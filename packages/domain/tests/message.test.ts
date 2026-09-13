import { expect, test } from "bun:test";
import { InboundMessage } from "../src/message";

const valid = {
	channel: "telegram",
	externalConversationId: "12345",
	externalMessageId: "12345:77",
	senderExternalId: "12345",
	senderDisplayName: "Budi",
	content: { text: "halo" },
	attachments: [],
	sentAt: "2026-09-14T03:00:00Z",
};

test("envelope valid diterima", () => {
	expect<unknown>(InboundMessage.parse(valid)).toEqual(valid);
});

test("pesan tanpa teks dengan lampiran diterima", () => {
	const photo = {
		...valid,
		content: { text: null },
		attachments: [{ kind: "photo", externalFileId: "AgAD", mimeType: null }],
	};
	expect(InboundMessage.safeParse(photo).success).toBe(true);
});

test("sentAt selain UTC ditolak", () => {
	const local = { ...valid, sentAt: "2026-09-14T10:00:00+07:00" };
	expect(InboundMessage.safeParse(local).success).toBe(false);
});

test("externalMessageId kosong ditolak karena jadi kunci idempotency", () => {
	const noId = { ...valid, externalMessageId: "" };
	expect(InboundMessage.safeParse(noId).success).toBe(false);
});
