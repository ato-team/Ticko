import { z } from "zod";
import { type HttpDeps, postWithRetry, requireText } from "./http";
import {
	type LlmClient,
	LlmFailure,
	type LlmRequest,
	type LlmResponse,
} from "./types";

// Chat Completions (POST {base_url}/chat/completions): OpenAI, OpenRouter,
// 9Router, atau endpoint lain yang kompatibel.
const Response = z.object({
	// Router tidak selalu mengembalikan model/usage; jangan gagal karenanya.
	model: z.string().optional(),
	choices: z
		.array(
			z.object({
				message: z.object({
					content: z.string().nullable(),
					refusal: z.string().nullable().optional(),
				}),
			}),
		)
		.min(1),
	usage: z
		.object({ prompt_tokens: z.number(), completion_tokens: z.number() })
		.optional(),
});

const ErrorBody = z.object({ error: z.object({ message: z.string() }) });

export class OpenAiClient implements LlmClient {
	constructor(
		private readonly deps: HttpDeps & {
			baseUrl: string;
			model: string;
			/**
			 * OpenAI menolak `max_tokens` untuk model reasoning; router yang
			 * meneruskan ke banyak penyedia paling luas mendukung `max_tokens`.
			 */
			maxTokensParam: "max_completion_tokens" | "max_tokens";
			/**
			 * Beberapa penyedia di balik 9Router hanya mengisi teks saat streaming
			 * (`stream: false` → content kosong). Respons SSE dirangkai jadi satu.
			 */
			stream: boolean;
		},
	) {}

	async complete(req: LlmRequest): Promise<LlmResponse> {
		const { data, latencyMs } = await postWithRetry(
			this.deps,
			`${this.deps.baseUrl.replace(/\/$/, "")}/chat/completions`,
			{ authorization: `Bearer ${this.deps.apiKey.reveal()}` },
			{
				model: this.deps.model,
				stream: this.deps.stream,
				[this.deps.maxTokensParam]: req.maxOutputTokens,
				messages: [{ role: "system", content: req.system }, ...req.messages],
			},
			Response,
			(json) => ErrorBody.safeParse(json).data?.error.message,
			decodeChatCompletion,
		);
		const message = data.choices[0]?.message;
		if (message?.refusal) throw new LlmFailure({ kind: "refused" });
		return requireText(message?.content ?? "", {
			model: data.model ?? this.deps.model,
			// ponytail: usage tidak dikirim router → token & biaya tercatat 0.
			inputTokens: data.usage?.prompt_tokens ?? 0,
			outputTokens: data.usage?.completion_tokens ?? 0,
			latencyMs,
		});
	}
}

/**
 * JSON biasa, atau SSE (`data: {chunk}` per baris) yang dirangkai menjadi
 * bentuk respons non-streaming. Router bisa membalas SSE walau tidak diminta.
 */
export function decodeChatCompletion(body: string): unknown {
	if (!/^\s*(data:|:)/.test(body)) {
		try {
			return JSON.parse(body);
		} catch {
			return null;
		}
	}
	let content = "";
	let refusal = "";
	let model: unknown;
	let usage: unknown;
	for (const line of body.split("\n")) {
		if (!line.startsWith("data:")) continue; // komentar SSE / baris kosong
		const payload = line.slice(5).trim();
		if (payload === "" || payload === "[DONE]") continue;
		let chunk: unknown;
		try {
			chunk = JSON.parse(payload);
		} catch {
			continue;
		}
		const c = Chunk.safeParse(chunk);
		if (!c.success) continue;
		model ??= c.data.model;
		usage = c.data.usage ?? usage;
		const delta = c.data.choices?.[0]?.delta;
		content += delta?.content ?? "";
		refusal += delta?.refusal ?? "";
	}
	return {
		model,
		usage,
		choices: [{ message: { content, refusal: refusal || null } }],
	};
}

const Chunk = z.object({
	model: z.string().optional(),
	usage: z.unknown().optional(),
	choices: z
		.array(
			z.object({
				delta: z
					.object({
						content: z.string().nullish(),
						refusal: z.string().nullish(),
					})
					.optional(),
			}),
		)
		.optional(),
});
