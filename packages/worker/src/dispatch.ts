import {
	assertNever,
	type ConversationId,
	controlOwnerFor,
	type InboundMessage,
	type MessageId,
	transition,
} from "@ticko/domain";
import {
	type Db,
	findActiveOrCreate,
	findOrCreateContact,
	getConversation,
	insertInbound,
	recordInboundAt,
	updateStatus,
} from "@ticko/storage";
import { enqueue } from "./queue";

// Dispatcher — lapis pertama Handoff Integrity (PRD Alur 1 langkah 8–9).
// Keputusan "apakah bot boleh bekerja" dibuat di sini dari control_owner di
// database, sebelum LLM ada di jalur. Worker memeriksanya ulang (lapis kedua).
// Tidak diserahkan ke dev lain (AGENTS.md).

export type ReceiveResult =
	| { kind: "duplicate" }
	| {
			kind: "stored";
			conversationId: ConversationId;
			messageId: MessageId;
			/** true bila job agent_run dimasukkan ke antrian. */
			botScheduled: boolean;
	  };

export async function receiveInbound(
	db: Db,
	msg: InboundMessage,
	traceId: string,
): Promise<ReceiveResult> {
	// Satu transaksi: pesan, perubahan status, dan job tersimpan bersama atau
	// tidak sama sekali. Tidak ada pekerjaan yang tertinggal di memori.
	return db.transaction(async (tx) => {
		const contact = await findOrCreateContact(tx, {
			channel: msg.channel,
			externalId: msg.senderExternalId,
			displayName: msg.senderDisplayName,
		});
		const active = await findActiveOrCreate(tx, {
			contactId: contact.id,
			channel: msg.channel,
			externalConversationId: msg.externalConversationId,
		});
		// Kunci baris: pesan beruntun untuk percakapan yang sama diproses urut,
		// dan handoff yang berjalan bersamaan tidak bisa menyelinap di tengah.
		const conv = await getConversation(tx, active.id, { forUpdate: true });
		if (!conv)
			throw new Error(`percakapan ${active.id} hilang di tengah transaksi`);

		const inserted = await insertInbound(tx, conv.id, msg);
		if (!inserted.ok) {
			switch (inserted.error.kind) {
				case "duplicate":
					return { kind: "duplicate" };
				default:
					return assertNever(inserted.error.kind);
			}
		}
		await recordInboundAt(tx, conv.id, msg.sentAt);

		const next = transition(conv.status, "message_received");
		// findActiveOrCreate tidak pernah mengembalikan `closed`, satu-satunya
		// status yang menolak message_received.
		if (!next.ok) {
			throw new Error(`transisi ditolak: ${conv.status} --message_received-->`);
		}
		if (next.status !== conv.status) {
			await updateStatus(tx, conv.id, next.status);
		}

		const botScheduled = controlOwnerFor(next.status) === "bot";
		if (botScheduled) {
			await enqueue(tx, {
				type: "agent_run",
				conversationId: conv.id,
				payload: { conversationId: conv.id, messageId: inserted.id, traceId },
			});
		}
		return {
			kind: "stored",
			conversationId: conv.id,
			messageId: inserted.id,
			botScheduled,
		};
	});
}
