import { assertNever } from "@ticko/domain";

// Interface LLM milik sendiri (A-2.2). Penyedia (Anthropic, OpenAI, atau
// endpoint kompatibel) ada di balik ini; loop agent tidak tahu bedanya.

export interface LlmMessage {
	role: "user" | "assistant";
	content: string;
}

export interface LlmRequest {
	system: string;
	messages: LlmMessage[];
	maxOutputTokens: number;
}

export interface LlmResponse {
	text: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	latencyMs: number;
}

// Pemanggil bercabang di sini: yang sementara boleh diulang, `refused` dan
// `bad_request` tidak (bot lebih baik eskalasi daripada mengarang).
export type LlmError =
	| { kind: "timeout" }
	| { kind: "network"; message: string }
	| { kind: "rate_limited" }
	| { kind: "overloaded" }
	| { kind: "server"; status: number }
	| { kind: "auth"; status: number }
	| { kind: "bad_request"; status: number; message: string }
	| { kind: "refused" }
	| { kind: "invalid_response"; message: string };

export class LlmFailure extends Error {
	constructor(readonly error: LlmError) {
		super(`panggilan LLM gagal: ${error.kind}`);
		this.name = "LlmFailure";
	}
}

export function isRetryable(e: LlmError): boolean {
	switch (e.kind) {
		case "timeout":
		case "network":
		case "rate_limited":
		case "overloaded":
		case "server":
			return true;
		case "auth":
		case "bad_request":
		case "refused":
		case "invalid_response":
			return false;
		default:
			return assertNever(e);
	}
}

export interface LlmClient {
	/** Melempar `LlmFailure` saat gagal. */
	complete(req: LlmRequest): Promise<LlmResponse>;
}
