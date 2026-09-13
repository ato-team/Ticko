import { z } from "zod";
import { Channel } from "./entity";

// Kontrak 1: channel menghasilkan, inti mengonsumsi. Payload webhook selalu
// masuk lewat skema ini, tidak pernah di-`as`.

export const Attachment = z.object({
	kind: z.enum(["photo", "document", "audio", "video", "other"]),
	externalFileId: z.string().min(1),
	mimeType: z.string().nullable(),
});
export type Attachment = z.infer<typeof Attachment>;

// Teks null untuk pesan yang hanya berisi lampiran.
export const MessageContent = z.object({
	text: z.string().nullable(),
});
export type MessageContent = z.infer<typeof MessageContent>;

export const InboundMessage = z.object({
	channel: Channel,
	externalConversationId: z.string().min(1),
	// Kunci idempotency: webhook yang di-retry membawa id yang sama.
	externalMessageId: z.string().min(1),
	senderExternalId: z.string().min(1),
	senderDisplayName: z.string().nullable(),
	content: MessageContent,
	attachments: z.array(Attachment),
	// Hanya UTC (akhiran Z); offset lain ditolak.
	sentAt: z.iso.datetime(),
});
export type InboundMessage = z.infer<typeof InboundMessage>;
