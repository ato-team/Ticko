import { z } from "zod";
import { type HttpDeps, postWithRetry, requireText } from "./http";
import {
	type LlmClient,
	LlmFailure,
	type LlmRequest,
	type LlmResponse,
} from "./types";

// Chat Completions (POST {base_url}/chat/completions). base_url bisa diarahkan
// ke endpoint lain yang kompatibel.
const Response = z.object({
	model: z.string(),
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
	usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }),
});

const ErrorBody = z.object({ error: z.object({ message: z.string() }) });

export class OpenAiClient implements LlmClient {
	constructor(
		private readonly deps: HttpDeps & { baseUrl: string; model: string },
	) {}

	async complete(req: LlmRequest): Promise<LlmResponse> {
		const { data, latencyMs } = await postWithRetry(
			this.deps,
			`${this.deps.baseUrl.replace(/\/$/, "")}/chat/completions`,
			{ authorization: `Bearer ${this.deps.apiKey.reveal()}` },
			{
				model: this.deps.model,
				// max_tokens ditolak model reasoning OpenAI; max_completion_tokens
				// adalah nama yang berlaku sekarang.
				max_completion_tokens: req.maxOutputTokens,
				messages: [{ role: "system", content: req.system }, ...req.messages],
			},
			Response,
			(json) => ErrorBody.safeParse(json).data?.error.message,
		);
		const message = data.choices[0]?.message;
		if (message?.refusal) throw new LlmFailure({ kind: "refused" });
		return requireText(message?.content ?? "", {
			model: data.model,
			inputTokens: data.usage.prompt_tokens,
			outputTokens: data.usage.completion_tokens,
			latencyMs,
		});
	}
}
