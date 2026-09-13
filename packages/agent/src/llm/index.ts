import { type AgentConfig, assertNever } from "@ticko/domain";
import { AnthropicClient } from "./anthropic";
import { LLM_TIMEOUT_MS } from "./http";
import { OpenAiClient } from "./openai";
import type { LlmClient } from "./types";

export { AnthropicClient } from "./anthropic";
export { OpenAiClient } from "./openai";
export * from "./types";

export function createLlmClient(
	cfg: AgentConfig,
	opts: { fetch?: typeof fetch } = {},
): LlmClient {
	const deps = {
		apiKey: cfg.apiKey,
		baseUrl: cfg.baseUrl,
		model: cfg.model,
		fetch: opts.fetch ?? fetch,
		timeoutMs: LLM_TIMEOUT_MS,
	};
	switch (cfg.provider) {
		case "anthropic":
			return new AnthropicClient(deps);
		case "openai":
			return new OpenAiClient(deps);
		default:
			return assertNever(cfg.provider);
	}
}

/** Estimasi biaya USD dari tarif di agent.toml. */
export function estimateCostUsd(
	cfg: Pick<AgentConfig, "inputUsdPerMtok" | "outputUsdPerMtok">,
	usage: { inputTokens: number; outputTokens: number },
): number {
	return (
		(usage.inputTokens * cfg.inputUsdPerMtok +
			usage.outputTokens * cfg.outputUsdPerMtok) /
		1_000_000
	);
}
