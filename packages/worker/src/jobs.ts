import { ConversationId, MessageId } from "@ticko/domain";
import { z } from "zod";

export const JobType = z.enum(["send_message", "agent_run"]);
export type JobType = z.infer<typeof JobType>;

// Payload setiap jenis job. Divalidasi saat diambil dari tabel, bukan di-`as`.
// Setiap payload membawa traceId agar log worker tersambung ke request asal.
export const JobPayloads = {
	send_message: z.object({
		conversationId: ConversationId,
		text: z.string().min(1),
		traceId: z.string(),
	}),
	agent_run: z.object({
		conversationId: ConversationId,
		messageId: MessageId,
		traceId: z.string(),
	}),
} satisfies Record<JobType, z.ZodType>;

export type JobPayload<T extends JobType> = z.infer<(typeof JobPayloads)[T]>;
