import { z } from "zod";
import {
	ConversationId,
	ConversationStatus,
	MessageId,
	UserId,
} from "./entity";

// Kontrak 4: event yang lewat `desk:events` (Redis pub/sub). Skema di sini,
// pemakainya (publisher/subscriber) ditambah di tugas lain.

export const Urgency = z.enum(["low", "normal", "high", "critical"]);
export type Urgency = z.infer<typeof Urgency>;

/** Makin tinggi angkanya, makin urgent — dipakai untuk sort inbox. */
export const URGENCY_RANK: Record<Urgency, number> = {
	critical: 3,
	high: 2,
	normal: 1,
	low: 0,
};

export const DeskEvent = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("message_received"),
		conversationId: ConversationId,
		messageId: MessageId,
	}),
	z.object({
		type: z.literal("handoff_requested"),
		conversationId: ConversationId,
		urgency: Urgency,
	}),
	z.object({
		type: z.literal("conversation_assigned"),
		conversationId: ConversationId,
		userId: UserId,
	}),
	z.object({
		type: z.literal("sla_breached"),
		conversationId: ConversationId,
	}),
	z.object({
		type: z.literal("status_changed"),
		conversationId: ConversationId,
		status: ConversationStatus,
	}),
]);
export type DeskEvent = z.infer<typeof DeskEvent>;

export const DESK_EVENTS_CHANNEL = "desk:events";
