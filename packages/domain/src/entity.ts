import { z } from "zod";

// Brand diambil dari Zod, bukan `unique symbol` buatan sendiri: dengan begitu
// satu-satunya jalan mendapat ID ber-brand adalah lewat parser, tanpa `as`.
export const ConversationId = z.uuid().brand<"ConversationId">();
export type ConversationId = z.infer<typeof ConversationId>;

export const ContactId = z.uuid().brand<"ContactId">();
export type ContactId = z.infer<typeof ContactId>;

export const MessageId = z.uuid().brand<"MessageId">();
export type MessageId = z.infer<typeof MessageId>;

export const UserId = z.uuid().brand<"UserId">();
export type UserId = z.infer<typeof UserId>;

export const Channel = z.enum(["telegram", "whatsapp"]);
export type Channel = z.infer<typeof Channel>;

export const SenderType = z.enum(["contact", "bot", "human", "system"]);
export type SenderType = z.infer<typeof SenderType>;

export const ConversationStatus = z.enum([
	"new",
	"bot_active",
	"handoff_requested",
	"human_active",
	"resolved",
	"closed",
]);
export type ConversationStatus = z.infer<typeof ConversationStatus>;

export const ControlOwner = z.enum(["bot", "human", "none"]);
export type ControlOwner = z.infer<typeof ControlOwner>;

export const UserRole = z.enum(["admin", "agent"]);
export type UserRole = z.infer<typeof UserRole>;
