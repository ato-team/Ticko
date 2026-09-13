import { expect, test } from "bun:test";
import {
	Channel,
	ContactId,
	ControlOwner,
	ConversationId,
	ConversationStatus,
	SenderType,
} from "../src/entity";

const UUID = "0b8e7a52-4c1f-4d2e-9a6b-3f5c8d7e1a20";

test("parser ID menerima UUID dan menolak selain itu", () => {
	expect<string>(ConversationId.parse(UUID)).toBe(UUID);
	expect(ConversationId.safeParse("12345").success).toBe(false);
	expect(ContactId.safeParse(42).success).toBe(false);
});

test("ID berbeda tidak bisa saling menggantikan saat kompilasi", () => {
	const takesConversation = (id: ConversationId) => id;
	const contact = ContactId.parse(UUID);
	// @ts-expect-error ContactId bukan ConversationId
	takesConversation(contact);
	// @ts-expect-error string mentah harus lewat parser
	takesConversation(UUID);
});

test("enum menolak nilai di luar daftar", () => {
	expect(Channel.options).toEqual(["telegram", "whatsapp"]);
	expect(SenderType.options).toEqual(["contact", "bot", "human", "system"]);
	expect(ConversationStatus.options).toEqual([
		"new",
		"bot_active",
		"handoff_requested",
		"human_active",
		"resolved",
		"closed",
	]);
	expect(ControlOwner.options).toEqual(["bot", "human", "none"]);
	expect(ControlOwner.safeParse("ai").success).toBe(false);
});
