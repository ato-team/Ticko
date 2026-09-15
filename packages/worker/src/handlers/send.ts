import type { ChannelRegistry } from "@ticko/channels";
import { assertNever, ChannelFailure } from "@ticko/domain";
import { type Db, getConversation } from "@ticko/storage";
import type { Handlers } from "../poller";

/** Konsumen `send_message` (A-1.4): kirim teks ke channel percakapan. */
export function sendMessageHandler(deps: {
	db: Db;
	channels: ChannelRegistry;
}): Handlers["send_message"] {
	return async (job, log) => {
		const conv = await getConversation(deps.db, job.payload.conversationId);
		if (!conv)
			return { status: "cancelled", reason: "percakapan tidak ditemukan" };

		const adapter = deps.channels.get(conv.channel);
		try {
			const sent = await adapter.sendText(
				conv.externalConversationId,
				job.payload.text,
			);
			log.info(
				{ external_message_id: sent.externalMessageId },
				"pesan terkirim",
			);
			return { status: "done" };
		} catch (e) {
			if (!(e instanceof ChannelFailure)) throw e;
			// Yang sementara dilempar ulang → retry dengan backoff. Yang permanen
			// dihentikan: retry tidak akan mengubah hasilnya.
			switch (e.error.kind) {
				case "timeout":
				case "network":
				case "rate_limited":
					throw e;
				case "recipient_unavailable":
					return { status: "cancelled", reason: e.error.description };
				case "rejected":
					if (e.error.status >= 500) throw e;
					return { status: "cancelled", reason: e.error.description };
				default:
					return assertNever(e.error);
			}
		}
	};
}
