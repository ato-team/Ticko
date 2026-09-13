import { assertNever } from "@ticko/domain";
import type { StoredMessage } from "@ticko/storage";
import type { LlmMessage, LlmRequest } from "./llm/types";

// Context builder (A-2.3): system prompt + N pesan terakhir, dipangkas agar
// muat. Peringkasan menyusul di Sprint 5.
//
// ponytail: token diperkirakan dari jumlah karakter (1 token ≈ 3 karakter,
// sengaja boros), bukan tokenizer. Tokenizer OpenAI (js-tiktoken) salah hitung
// untuk Claude, dan count_tokens menambah satu panggilan jaringan per giliran.
// Ganti dengan count_tokens bila batas konteks mulai sering terlampaui.
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 3);
}

export function buildContext(input: {
	systemPrompt: string;
	/** Urut dari yang paling lama. */
	history: StoredMessage[];
	contextMaxTokens: number;
	maxOutputTokens: number;
}): LlmRequest {
	let budget =
		input.contextMaxTokens -
		input.maxOutputTokens -
		estimateTokens(input.systemPrompt);

	const picked: LlmMessage[] = [];
	for (let i = input.history.length - 1; i >= 0; i--) {
		const msg = input.history[i];
		if (!msg) continue;
		const m = toLlmMessage(msg);
		const cost = estimateTokens(m.content);
		// Pesan terbaru selalu ikut, walau sendirian melebihi anggaran.
		if (picked.length > 0 && cost > budget) break;
		budget -= cost;
		picked.push(m);
	}
	picked.reverse();

	// Percakapan harus diawali pesan pengguna.
	while (picked[0]?.role === "assistant") picked.shift();

	return {
		system: input.systemPrompt,
		messages: picked,
		maxOutputTokens: input.maxOutputTokens,
	};
}

function toLlmMessage(m: StoredMessage): LlmMessage {
	const content = m.content ?? "(pelanggan mengirim lampiran tanpa teks)";
	switch (m.senderType) {
		case "contact":
			return { role: "user", content };
		// Balasan agent manusia juga suara "kita" di mata pelanggan.
		case "bot":
		case "human":
			return { role: "assistant", content };
		case "system":
			return {
				role: "user",
				content: `[Catatan internal, bukan dari pelanggan] ${content}`,
			};
		default:
			return assertNever(m.senderType);
	}
}
