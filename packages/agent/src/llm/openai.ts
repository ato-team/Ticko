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
		},
	) {}

	async complete(req: LlmRequest): Promise<LlmResponse> {
		const { data, latencyMs } = await postWithRetry(
			this.deps,
			`${this.deps.baseUrl.replace(/\/$/, "")}/chat/completions`,
			{ authorization: `Bearer ${this.deps.apiKey.reveal()}` },
			{
				model: this.deps.model,
				stream: false,
				[this.deps.maxTokensParam]: req.maxOutputTokens,
				messages: [{ role: "system", content: req.system }, ...req.messages],
			},
			Response,
			(json) => ErrorBody.safeParse(json).data?.error.message,
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
