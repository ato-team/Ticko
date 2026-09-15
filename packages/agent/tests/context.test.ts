import { expect, test } from "bun:test";
import { ConversationId, MessageId } from "@ticko/domain";
import type { StoredMessage } from "@ticko/storage";
import { buildContext, estimateTokens } from "../src/context";

const conversationId = ConversationId.parse(
	"0b8e7a52-4c1f-4d2e-9a6b-3f5c8d7e1a20",
);
const msg = (
	i: number,
	senderType: StoredMessage["senderType"],
	content: string | null,
): StoredMessage => ({
	id: MessageId.parse(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
	conversationId,
	senderType,
	content,
	sentAt: "2026-09-14T03:00:00.000Z",
});

test("urutan: system terpisah, pesan lama → baru, peran dipetakan", () => {
	const req = buildContext({
		systemPrompt: "Kamu CS.",
		history: [
			msg(1, "contact", "halo"),
			msg(2, "bot", "Halo!"),
			msg(3, "human", "Saya Dina"),
			msg(4, "contact", null),
		],
		contextMaxTokens: 10_000,
		maxOutputTokens: 500,
	});
	expect(req).toEqual({
		system: "Kamu CS.",
		maxOutputTokens: 500,
		messages: [
			{ role: "user", content: "halo" },
			{ role: "assistant", content: "Halo!" },
			{ role: "assistant", content: "Saya Dina" },
			{ role: "user", content: "(pelanggan mengirim lampiran tanpa teks)" },
		],
	});
});

test("200 pesan tidak membuat prompt melebihi batas token", () => {
	const history = Array.from({ length: 200 }, (_, i) =>
		msg(i + 1, i % 2 === 0 ? "contact" : "bot", `pesan ke-${i} `.repeat(20)),
	);
	const limit = 2000;
	const req = buildContext({
		systemPrompt: "Kamu CS.",
		history,
		contextMaxTokens: limit,
		maxOutputTokens: 300,
	});
	const used =
		estimateTokens(req.system) +
		req.messages.reduce((n, m) => n + estimateTokens(m.content), 0) +
		req.maxOutputTokens;
	expect(used).toBeLessThanOrEqual(limit);
	expect(req.messages.length).toBeGreaterThan(0);
	expect(req.messages.length).toBeLessThan(200);
	expect(req.messages.at(-1)?.content).toBe(`pesan ke-199 `.repeat(20));
	expect(req.messages[0]?.role).toBe("user");
});
