import type { ChannelRegistry } from "@ticko/channels";
import { assertNever, ChannelFailure } from "@ticko/domain";
import {
	type Db,
	getOutboundQueue,
	markOutboundFailed,
	markOutboundSent,
} from "@ticko/storage";
import type { Handlers } from "../poller";

/**
 * Konsumen `send_message` (A-2.6). `outbound_queue` = status pengiriman +
 * idempotency; `jobs.attempts` tetap satu-satunya otoritas retry/backoff.
 * Row lock tidak ditahan selama `sendText` (bisa lambat, pola sama dengan
 * panggilan LLM di agent.ts) — dikunci ulang hanya saat menulis hasil.
 *
 * ponytail: at-least-once — worker mati di antara `sendText` dan
 * `markOutboundSent` bisa mengirim ulang. Telegram tidak punya idempotency
 * key; tutup celah ini kalau channel berikutnya (WhatsApp) menyediakannya.
 */
export function sendMessageHandler(deps: {
	db: Db;
	channels: ChannelRegistry;
}): Handlers["send_message"] {
	return async (job, log) => {
		const row = await getOutboundQueue(deps.db, job.payload.outboundId);
		if (!row)
			return { status: "cancelled", reason: "outbound_queue tidak ditemukan" };
		if (row.status === "sent" || row.status === "dead") {
			log.info({ outbound_id: row.id, status: row.status }, "dilewati");
			return { status: "done" };
		}

		const fail = (error: string, dead: boolean) =>
			markOutboundFailed(deps.db, row.id, { error, dead });
		const lastTry = job.attempts >= job.maxAttempts;

		try {
			const sent = await deps.channels
				.get(row.channel)
				.sendText(row.recipient, row.text);
			await deps.db.transaction(async (tx) => {
				const locked = await getOutboundQueue(tx, row.id, { forUpdate: true });
				if (locked?.status === "sent") return;
				await markOutboundSent(tx, row.id, sent.externalMessageId);
			});
			log.info(
				{ external_message_id: sent.externalMessageId },
				"pesan terkirim",
			);
			return { status: "done" };
		} catch (e) {
			if (!(e instanceof ChannelFailure)) throw e;
			const err = e.error;
			switch (err.kind) {
				case "timeout":
				case "network":
				case "rate_limited":
					await fail(err.kind, lastTry);
					throw e;
				case "recipient_unavailable":
					await fail(err.description, true);
					return { status: "cancelled", reason: err.description };
				case "rejected":
					if (err.status >= 500) {
						await fail(`rejected ${err.status}: ${err.description}`, lastTry);
						throw e;
					}
					await fail(err.description, true);
					return { status: "cancelled", reason: err.description };
				default:
					return assertNever(err);
			}
		}
	};
}
