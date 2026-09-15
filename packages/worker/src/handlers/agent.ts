import {
	type Db,
	getConversation,
	getMessage,
	insertOutbound,
} from "@ticko/storage";
import type { Handlers } from "../poller";
import { enqueue } from "../queue";

/**
 * Konsumen `agent_run`. Sementara (checkpoint Sprint 1) hanya membalas echo;
 * A-2.4 mengganti pembuatan teks dengan LLM. Pemeriksaan control_owner di sini
 * sudah final: lapis kedua Handoff Integrity (AC-3.1).
 */
export function echoAgentHandler(deps: { db: Db }): Handlers["agent_run"] {
	return (job) =>
		deps.db.transaction(async (tx) => {
			// FOR UPDATE: handoff yang berjalan bersamaan menunggu sampai balasan
			// ini tercatat, atau balasan ini yang melihat status barunya.
			const conv = await getConversation(tx, job.payload.conversationId, {
				forUpdate: true,
			});
			if (!conv)
				return { status: "cancelled", reason: "percakapan tidak ditemukan" };
			if (conv.controlOwner !== "bot") {
				return {
					status: "cancelled",
					reason: `control_owner=${conv.controlOwner}, bot tidak boleh membalas`,
				};
			}

			const msg = await getMessage(tx, job.payload.messageId);
			const text = `Kamu bilang: ${msg?.content ?? "(lampiran)"}`;
			await insertOutbound(tx, {
				conversationId: conv.id,
				senderType: "bot",
				content: text,
			});
			await enqueue(tx, {
				type: "send_message",
				conversationId: conv.id,
				payload: {
					conversationId: conv.id,
					text,
					traceId: job.payload.traceId,
				},
			});
			return { status: "done" };
		});
}
