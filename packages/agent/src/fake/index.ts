import {
	type LlmClient,
	type LlmError,
	LlmFailure,
	type LlmRequest,
	type LlmResponse,
} from "../llm/types";

type Step = { text: string } | { error: LlmError };

/**
 * LLM palsu yang deterministik (A-2.5, Kontrak 6): tanpa jaringan, tanpa biaya.
 * Menjalankan langkah sesuai urutan; langkah terakhir diulang bila habis.
 *
 * ponytail: withToolCall belum ada karena LlmClient belum mengenal tool.
 * Tambahkan bersama interface Tool di A-2.7.
 */
export class FakeLlm implements LlmClient {
	readonly calls: LlmRequest[] = [];
	private index = 0;

	constructor(private readonly steps: Step[]) {
		if (steps.length === 0)
			throw new Error("FakeLlm butuh minimal satu langkah");
	}

	static withText(...texts: string[]): FakeLlm {
		return new FakeLlm(texts.map((text) => ({ text })));
	}

	static withError(error: LlmError): FakeLlm {
		return new FakeLlm([{ error }]);
	}

	static script(...steps: Step[]): FakeLlm {
		return new FakeLlm(steps);
	}

	async complete(req: LlmRequest): Promise<LlmResponse> {
		this.calls.push(structuredClone(req));
		const step = this.steps[Math.min(this.index, this.steps.length - 1)];
		this.index += 1;
		if (!step) throw new Error("tidak terjangkau: steps tidak kosong");
		if ("error" in step) throw new LlmFailure(step.error);
		return {
			text: step.text,
			model: "fake",
			// Perkiraan kasar agar pencatatan token bisa diuji.
			inputTokens: JSON.stringify(req).length,
			outputTokens: step.text.length,
			latencyMs: 0,
		};
	}
}
