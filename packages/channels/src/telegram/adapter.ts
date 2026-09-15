import {
	type ChannelAdapter,
	type ChannelError,
	ChannelFailure,
	type Secret,
	type SentMessage,
	type TemplateRef,
} from "@ticko/domain";
import { z } from "zod";

// Bot API dipanggil langsung lewat fetch, tanpa telegraf/grammy: dispatcher
// bawaan pustaka itu bentrok dengan job queue.

const ApiResponse = z.union([
	z.object({ ok: z.literal(true), result: z.unknown() }),
	z.object({
		ok: z.literal(false),
		error_code: z.number(),
		description: z.string(),
		parameters: z.object({ retry_after: z.number().optional() }).optional(),
	}),
]);

const SentResult = z.object({ message_id: z.number(), date: z.number() });

export class TelegramAdapter implements ChannelAdapter {
	readonly channel = "telegram";
	readonly #token: Secret;
	readonly #fetch: typeof fetch;
	readonly #apiBase: string;
	readonly #timeoutMs: number;

	constructor(opts: {
		botToken: Secret;
		fetch?: typeof fetch;
		apiBase?: string;
		timeoutMs?: number;
	}) {
		this.#token = opts.botToken;
		this.#fetch = opts.fetch ?? fetch;
		this.#apiBase = opts.apiBase ?? "https://api.telegram.org";
		this.#timeoutMs = opts.timeoutMs ?? 10_000;
	}

	async sendText(to: string, text: string): Promise<SentMessage> {
		const result = SentResult.safeParse(
			await this.#call("sendMessage", { chat_id: to, text }),
		);
		if (!result.success) {
			throw new ChannelFailure({
				kind: "rejected",
				status: 200,
				description: "respons sendMessage tidak dikenali",
			});
		}
		return {
			externalMessageId: `${to}:${result.data.message_id}`,
			sentAt: new Date(result.data.date * 1000).toISOString(),
		};
	}

	async sendTemplate(_to: string, template: TemplateRef): Promise<SentMessage> {
		// Telegram tidak punya template; supportsFreeForm selalu true sehingga
		// jalur ini tidak pernah dipilih.
		throw new ChannelFailure({
			kind: "rejected",
			status: 0,
			description: `telegram tidak mendukung template (${template.name})`,
		});
	}

	supportsFreeForm(_lastInboundAt: string | null): boolean {
		return true;
	}

	async setWebhook(url: string): Promise<void> {
		await this.#call("setWebhook", {
			url,
			allowed_updates: ["message"],
			drop_pending_updates: false,
		});
	}

	async #call(method: string, body: unknown): Promise<unknown> {
		let res: Response;
		try {
			res = await this.#fetch(
				`${this.#apiBase}/bot${this.#token.reveal()}/${method}`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(this.#timeoutMs),
				},
			);
		} catch (e) {
			if (e instanceof Error && e.name === "TimeoutError") {
				throw new ChannelFailure({ kind: "timeout" });
			}
			// Pesan error fetch bisa memuat URL, dan URL memuat token.
			throw new ChannelFailure({ kind: "network", cause: this.#scrub(e) });
		}

		const json: unknown = await res.json().catch(() => null);
		const parsed = ApiResponse.safeParse(json);
		if (!parsed.success) {
			throw new ChannelFailure({
				kind: "rejected",
				status: res.status,
				description: "respons Bot API tidak dikenali",
			});
		}
		if (parsed.data.ok) return parsed.data.result;
		throw new ChannelFailure(toChannelError(parsed.data));
	}

	#scrub(e: unknown): string {
		const msg = e instanceof Error ? e.message : String(e);
		return msg.replaceAll(this.#token.reveal(), "[redacted]");
	}
}

function toChannelError(r: {
	error_code: number;
	description: string;
	parameters?: { retry_after?: number | undefined } | undefined;
}): ChannelError {
	if (r.error_code === 429) {
		return {
			kind: "rate_limited",
			retryAfterSeconds: r.parameters?.retry_after ?? null,
		};
	}
	// 403: bot diblokir atau dikeluarkan dari chat. Tidak ada gunanya retry.
	if (r.error_code === 403) {
		return { kind: "recipient_unavailable", description: r.description };
	}
	return { kind: "rejected", status: r.error_code, description: r.description };
}
