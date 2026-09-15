import { z } from "zod";
import { type HttpDeps, postWithRetry, requireText } from "./http";
import {
	type LlmClient,
	LlmFailure,
	type LlmRequest,
	type LlmResponse,
} from "./types";

// Messages API (POST /v1/messages) lewat fetch.
const Response = z.object({
	model: z.string(),
	stop_reason: z.string().nullable(),
	content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
	usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

const ErrorBody = z.object({ error: z.object({ message: z.string() }) });

export class AnthropicClient implements LlmClient {
	constructor(
		private readonly deps: HttpDeps & { baseUrl: string; model: string },
	) {}

	async complete(req: LlmRequest): Promise<LlmResponse> {
		const { data, latencyMs } = await postWithRetry(
			this.deps,
			`${this.deps.baseUrl.replace(/\/$/, "")}/v1/messages`,
			{
				"x-api-key": this.deps.apiKey.reveal(),
				"anthropic-version": "2023-06-01",
			},
			{
				model: this.deps.model,
				max_tokens: req.maxOutputTokens,
				system: req.system,
				messages: req.messages,
			},
			Response,
			(json) => ErrorBody.safeParse(json).data?.error.message,
		);
		if (data.stop_reason === "refusal") {
			throw new LlmFailure({ kind: "refused" });
		}
		// Blok thinking dan lainnya diabaikan; hanya teks yang dikirim ke pelanggan.
		const text = data.content
			.flatMap((b) => (b.type === "text" && b.text ? [b.text] : []))
			.join("");
		return requireText(text, {
			model: data.model,
			inputTokens: data.usage.input_tokens,
			outputTokens: data.usage.output_tokens,
			latencyMs,
		});
	}
}
