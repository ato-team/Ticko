import type { Secret } from "@ticko/domain";
import type { z } from "zod";
import {
	isRetryable,
	type LlmError,
	LlmFailure,
	type LlmResponse,
} from "./types";

export const LLM_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;

export interface HttpDeps {
	apiKey: Secret;
	fetch: typeof fetch;
	timeoutMs: number;
}

/**
 * POST JSON dengan timeout per percobaan dan retry maksimal 2 kali untuk
 * kegagalan sementara. Retry langsung tanpa jeda: jeda panjang milik job queue,
 * bukan timer di memori.
 */
export async function postWithRetry<T>(
	deps: HttpDeps,
	url: string,
	headers: Record<string, string>,
	body: unknown,
	schema: z.ZodType<T>,
	errorMessage: (json: unknown) => string | undefined,
	decode: (body: string) => unknown = parseJson,
): Promise<{ data: T; latencyMs: number }> {
	let last: LlmError = { kind: "network", message: "belum dicoba" };
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			return await postOnce(
				deps,
				url,
				headers,
				body,
				schema,
				errorMessage,
				decode,
			);
		} catch (e) {
			if (!(e instanceof LlmFailure) || !isRetryable(e.error)) throw e;
			last = e.error;
		}
	}
	throw new LlmFailure(last);
}

async function postOnce<T>(
	deps: HttpDeps,
	url: string,
	headers: Record<string, string>,
	body: unknown,
	schema: z.ZodType<T>,
	errorMessage: (json: unknown) => string | undefined,
	decode: (body: string) => unknown,
): Promise<{ data: T; latencyMs: number }> {
	const started = performance.now();
	let res: Response;
	let text: string;
	try {
		res = await deps.fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(deps.timeoutMs),
		});
		// Body dibaca di dalam try: timeout juga berlaku untuk respons streaming.
		text = await res.text();
	} catch (e) {
		if (e instanceof Error && e.name === "TimeoutError") {
			throw new LlmFailure({ kind: "timeout" });
		}
		const message = e instanceof Error ? e.message : String(e);
		throw new LlmFailure({
			kind: "network",
			message: message.replaceAll(deps.apiKey.reveal(), "[redacted]"),
		});
	}

	const json = decode(text);
	if (!res.ok)
		throw new LlmFailure(statusError(res.status, errorMessage(json)));

	// Bentuk JSON penyedia bisa berubah; jangan biarkan lolos diam-diam.
	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		throw new LlmFailure({
			kind: "invalid_response",
			message: parsed.error.issues.map((i) => i.path.join(".")).join(", "),
		});
	}
	return {
		data: parsed.data,
		latencyMs: Math.round(performance.now() - started),
	};
}

function parseJson(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return null;
	}
}

function statusError(status: number, message = ""): LlmError {
	if (status === 401 || status === 403) return { kind: "auth", status };
	if (status === 429) return { kind: "rate_limited" };
	if (status === 529 || status === 503) return { kind: "overloaded" };
	if (status >= 500) return { kind: "server", status };
	return { kind: "bad_request", status, message };
}

export function requireText(
	text: string,
	rest: Omit<LlmResponse, "text">,
): LlmResponse {
	if (text.trim() === "") {
		throw new LlmFailure({
			kind: "invalid_response",
			message: "jawaban kosong",
		});
	}
	return { text, ...rest };
}
