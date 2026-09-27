import { createHash, randomBytes } from "node:crypto";
import {
	Channel,
	ContactId,
	ControlOwner,
	type ConversationDetail,
	type ConversationEvent,
	ConversationId,
	ConversationStatus as ConversationStatusSchema,
	type InboundMessage,
	MessageId,
	SenderType,
	type TransitionResult,
	transition,
	UserId,
	UserRole,
} from "@ticko/domain";
import { and, count, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor, Tx } from "../db";
import {
	agentRuns,
	contacts,
	conversationEvents,
	conversations,
	deadLetters,
	messages,
	outboundQueue,
	sessions,
	users,
} from "../schema";

export * from "./types";

import type { ConversationSummary, InboxFilter, Page } from "./types";

// Baris database diparse ke tipe ber-brand lewat Zod, bukan di-`as`.
const iso = z.date().transform((d) => d.toISOString());

export const Contact = z.object({
	id: ContactId,
	channel: Channel,
	externalId: z.string(),
	displayName: z.string().nullable(),
});
export type Contact = z.infer<typeof Contact>;

export const Conversation = z.object({
	id: ConversationId,
	contactId: ContactId,
	channel: Channel,
	externalConversationId: z.string(),
	status: ConversationStatusSchema,
	controlOwner: ControlOwner,
	version: z.number().int(),
	lastInboundAt: iso.nullable(),
});
export type Conversation = z.infer<typeof Conversation>;

export const StoredMessage = z.object({
	id: MessageId,
	conversationId: ConversationId,
	senderType: SenderType,
	content: z.string().nullable(),
	sentAt: iso,
});
export type StoredMessage = z.infer<typeof StoredMessage>;

// --- Contact -----------------------------------------------------------------

/** Satu query upsert: dua panggilan bersamaan tetap menghasilkan satu baris (AC-1.4). */
export async function findOrCreateContact(
	ex: Executor,
	input: { channel: Channel; externalId: string; displayName: string | null },
): Promise<Contact> {
	const [row] = await ex
		.insert(contacts)
		.values(input)
		.onConflictDoUpdate({
			target: [contacts.channel, contacts.externalId],
			set: {
				displayName: sql`coalesce(excluded.display_name, ${contacts.displayName})`,
				updatedAt: sql`now()`,
			},
		})
		.returning();
	return Contact.parse(row);
}

// --- Conversation ------------------------------------------------------------

/**
 * Percakapan non-closed milik kontak, atau yang baru bila tidak ada (AC-1.5).
 * Index unik parsial `conversations_one_active_per_contact` membuat panggilan
 * yang balapan menunggu lalu membaca baris pemenang, bukan membuat dua.
 */
export async function findActiveOrCreate(
	ex: Executor,
	input: {
		contactId: ContactId;
		channel: Channel;
		externalConversationId: string;
	},
): Promise<Conversation> {
	const [created] = await ex
		.insert(conversations)
		.values(input)
		.onConflictDoNothing({
			target: conversations.contactId,
			where: sql`${conversations.status} <> 'closed'`,
		})
		.returning();
	if (created) return Conversation.parse(created);

	const [existing] = await ex
		.select()
		.from(conversations)
		.where(
			and(
				eq(conversations.contactId, input.contactId),
				ne(conversations.status, "closed"),
			),
		);
	return Conversation.parse(existing);
}

export async function getConversation(
	ex: Executor,
	id: ConversationId,
	opts: { forUpdate?: boolean } = {},
): Promise<Conversation | null> {
	const q = ex.select().from(conversations).where(eq(conversations.id, id));
	const [row] = await (opts.forUpdate ? q.for("update") : q);
	return row ? Conversation.parse(row) : null;
}

// --- Inbox desk (B-2.1, Kontrak 7) ----------------------------------------------

const SummaryRow = z.object({
	id: ConversationId,
	channel: Channel,
	status: ConversationStatusSchema,
	controlOwner: ControlOwner,
	contactName: z.string().nullable(),
	lastInboundAt: iso.nullable(),
});

const LastMessageRow = z.object({
	conversationId: ConversationId,
	senderType: SenderType,
	content: z.string().nullable(),
	sentAt: iso,
});

// Batas pesan di detail; riwayat lebih panjang butuh pagination sendiri.
export const DETAIL_MESSAGE_LIMIT = 200;

/**
 * Daftar inbox: tanpa filter status → semua kecuali `closed`. Urut dari yang
 * paling lama menunggu (`last_inbound_at` tertua); urgensi menyusul bersama
 * kolomnya di Sprint 3. Filter `assignedUserId` belum ada kolomnya (claim,
 * A-3.1), jadi sengaja tidak diterima di sini.
 */
export async function listInbox(
	ex: Executor,
	filter: Omit<InboxFilter, "assignedUserId">,
): Promise<Page<ConversationSummary>> {
	const page = filter.page ?? 1;
	const pageSize = filter.pageSize ?? 20;
	const where = filter.status
		? eq(conversations.status, filter.status)
		: ne(conversations.status, "closed");

	const [counted] = await ex
		.select({ total: count() })
		.from(conversations)
		.where(where);
	const rows = await ex
		.select({
			id: conversations.id,
			channel: conversations.channel,
			status: conversations.status,
			controlOwner: conversations.controlOwner,
			contactName: contacts.displayName,
			lastInboundAt: conversations.lastInboundAt,
		})
		.from(conversations)
		.innerJoin(contacts, eq(contacts.id, conversations.contactId))
		.where(where)
		.orderBy(
			sql`${conversations.lastInboundAt} ASC NULLS LAST`,
			conversations.id,
		)
		.limit(pageSize)
		.offset((page - 1) * pageSize);
	const summaries = rows.map((r) => SummaryRow.parse(r));

	const ids = summaries.map((r) => r.id);
	const lastRows =
		ids.length === 0
			? []
			: await ex
					.selectDistinctOn([messages.conversationId], {
						conversationId: messages.conversationId,
						senderType: messages.senderType,
						content: messages.content,
						sentAt: messages.sentAt,
					})
					.from(messages)
					.where(inArray(messages.conversationId, ids))
					.orderBy(
						messages.conversationId,
						desc(messages.createdAt),
						desc(messages.id),
					);
	const last = new Map(
		lastRows.map((r) => {
			const { conversationId, ...msg } = LastMessageRow.parse(r);
			return [conversationId, msg];
		}),
	);

	return {
		items: summaries.map((s) => ({
			...s,
			lastMessage: last.get(s.id) ?? null,
		})),
		page,
		pageSize,
		total: z.number().int().parse(counted?.total),
	};
}

export async function getConversationDetail(
	ex: Executor,
	id: ConversationId,
): Promise<ConversationDetail | null> {
	const [row] = await ex
		.select({
			id: conversations.id,
			channel: conversations.channel,
			status: conversations.status,
			controlOwner: conversations.controlOwner,
			contactName: contacts.displayName,
			lastInboundAt: conversations.lastInboundAt,
			version: conversations.version,
		})
		.from(conversations)
		.innerJoin(contacts, eq(contacts.id, conversations.contactId))
		.where(eq(conversations.id, id));
	if (!row) return null;
	const summary = SummaryRow.extend({ version: z.number().int() }).parse(row);
	const msgs = (await listRecentMessages(ex, id, DETAIL_MESSAGE_LIMIT)).map(
		(m) => ({
			id: m.id,
			senderType: m.senderType,
			content: m.content,
			sentAt: m.sentAt,
		}),
	);
	const tail = msgs.at(-1);
	return {
		...summary,
		lastMessage: tail
			? {
					senderType: tail.senderType,
					content: tail.content,
					sentAt: tail.sentAt,
				}
			: null,
		messages: msgs,
	};
}

/**
 * transition() + tulis DB + catat event, satu transaksi (A-2.1, AC-2.6).
 * Mengunci ulang baris (sudah dikunci pemanggil dalam tx yang sama, jadi ini
 * tidak menunggu) supaya fungsi ini berdiri sendiri tanpa status lama sebagai
 * parameter terpisah. Ditolak → tidak menulis apa pun. Status tidak berubah
 * (mis. message_received di status yang sama) → tidak menulis apa pun juga,
 * event log hanya untuk perubahan sungguhan.
 */
export async function changeStatus(
	tx: Tx,
	{
		id,
		event,
		userId,
	}: { id: ConversationId; event: ConversationEvent; userId?: UserId },
): Promise<TransitionResult> {
	const conv = await getConversation(tx, id, { forUpdate: true });
	if (!conv) {
		// Baris hilang di tengah transaksi berarti bug pemanggil, bukan kasus
		// yang punya arti domain — biarkan meledak.
		throw new Error(`percakapan ${id} hilang saat changeStatus`);
	}
	const result = transition(conv.status, event);
	if (!result.ok) return result;
	if (result.status === conv.status) return result;

	await tx
		.update(conversations)
		.set({
			status: result.status,
			controlOwner: result.controlOwner,
			version: sql`${conversations.version} + 1`,
			updatedAt: sql`now()`,
		})
		.where(eq(conversations.id, id));
	await tx.insert(conversationEvents).values({
		conversationId: id,
		fromStatus: conv.status,
		toStatus: result.status,
		trigger: event,
		triggeredByUserId: userId,
	});
	return result;
}

export async function recordInboundAt(
	ex: Executor,
	id: ConversationId,
	at: string,
): Promise<void> {
	await ex
		.update(conversations)
		.set({ lastInboundAt: new Date(at), updatedAt: sql`now()` })
		.where(eq(conversations.id, id));
}

// --- Message -----------------------------------------------------------------

export type InsertError = { kind: "duplicate"; externalId: string };
export type InsertResult =
	| { ok: true; id: MessageId }
	| { ok: false; error: InsertError };

/** Webhook yang di-retry membawa id sama → `duplicate`, bukan exception (AC-1.3). */
export async function insertInbound(
	ex: Executor,
	conversationId: ConversationId,
	msg: InboundMessage,
): Promise<InsertResult> {
	const [row] = await ex
		.insert(messages)
		.values({
			conversationId,
			senderType: "contact",
			externalMessageId: msg.externalMessageId,
			content: msg.content.text,
			attachments: msg.attachments,
			sentAt: new Date(msg.sentAt),
		})
		.onConflictDoNothing({ target: messages.externalMessageId })
		.returning({ id: messages.id });
	if (!row) {
		return {
			ok: false,
			error: { kind: "duplicate", externalId: msg.externalMessageId },
		};
	}
	return { ok: true, id: MessageId.parse(row.id) };
}

export async function insertOutbound(
	ex: Executor,
	input: {
		conversationId: ConversationId;
		senderType: "bot" | "system";
		content: string;
	},
): Promise<MessageId> {
	const [row] = await ex
		.insert(messages)
		.values({ ...input, sentAt: new Date() })
		.returning({ id: messages.id });
	return MessageId.parse(row?.id);
}

export async function getMessage(
	ex: Executor,
	id: MessageId,
): Promise<StoredMessage | null> {
	const [row] = await ex.select().from(messages).where(eq(messages.id, id));
	return row ? StoredMessage.parse(row) : null;
}

/** N pesan terakhir, urut dari yang paling lama. */
export async function listRecentMessages(
	ex: Executor,
	conversationId: ConversationId,
	limit: number,
): Promise<StoredMessage[]> {
	const rows = await ex
		.select()
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(desc(messages.createdAt), desc(messages.id))
		.limit(limit);
	return rows.reverse().map((r) => StoredMessage.parse(r));
}

// --- Agent run -----------------------------------------------------------------

export async function insertAgentRun(
	ex: Executor,
	run: Omit<typeof agentRuns.$inferInsert, "id" | "createdAt">,
): Promise<string> {
	const [row] = await ex
		.insert(agentRuns)
		.values(run)
		.returning({ id: agentRuns.id });
	return z.string().parse(row?.id);
}

// --- Outbound queue (A-2.6) ----------------------------------------------------

export const OutboundQueueStatus = z.enum([
	"pending",
	"sent",
	"failed",
	"dead",
]);
export type OutboundQueueStatus = z.infer<typeof OutboundQueueStatus>;

export const OutboundQueueRow = z.object({
	id: z.string(),
	conversationId: ConversationId,
	messageId: MessageId,
	channel: Channel,
	recipient: z.string(),
	text: z.string(),
	status: OutboundQueueStatus,
	attempts: z.number().int(),
	lastError: z.string().nullable(),
	externalMessageId: z.string().nullable(),
});
export type OutboundQueueRow = z.infer<typeof OutboundQueueRow>;

/** Ditulis dalam transaksi yang sama dengan `insertOutbound` (A-2.6). */
export async function insertOutboundQueue(
	ex: Executor,
	input: {
		conversationId: ConversationId;
		messageId: MessageId;
		channel: Channel;
		recipient: string;
		text: string;
	},
): Promise<string> {
	const [row] = await ex
		.insert(outboundQueue)
		.values(input)
		.returning({ id: outboundQueue.id });
	return z.string().parse(row?.id);
}

export async function getOutboundQueue(
	ex: Executor,
	id: string,
	opts: { forUpdate?: boolean } = {},
): Promise<OutboundQueueRow | null> {
	const q = ex.select().from(outboundQueue).where(eq(outboundQueue.id, id));
	const [row] = await (opts.forUpdate ? q.for("update") : q);
	return row ? OutboundQueueRow.parse(row) : null;
}

/** Sukses kirim: status `sent`, `attempts` naik satu (percobaan yang berhasil ini). */
export async function markOutboundSent(
	ex: Executor,
	id: string,
	externalMessageId: string,
): Promise<void> {
	await ex
		.update(outboundQueue)
		.set({
			status: "sent",
			externalMessageId,
			attempts: sql`${outboundQueue.attempts} + 1`,
			updatedAt: sql`now()`,
		})
		.where(eq(outboundQueue.id, id));
}

/**
 * Gagal kirim: `attempts` naik, `lastError` dicatat. `dead: true` = terminal
 * (retry job habis atau error permanen) — baris ini jadi dead letter-nya.
 */
export async function markOutboundFailed(
	ex: Executor,
	id: string,
	input: { error: string; dead: boolean },
): Promise<void> {
	await ex
		.update(outboundQueue)
		.set({
			status: input.dead ? "dead" : "failed",
			attempts: sql`${outboundQueue.attempts} + 1`,
			lastError: input.error.slice(0, 2000),
			updatedAt: sql`now()`,
		})
		.where(eq(outboundQueue.id, id));
}

// --- Dead letter ---------------------------------------------------------------

/** Payload webhook yang gagal diparse (AC-1.7). Baris mentah untuk pemeriksaan manual. */
export async function insertDeadLetter(
	ex: Executor,
	input: { channel: Channel; payload: string; error: string },
): Promise<void> {
	await ex.insert(deadLetters).values(input);
}

// --- User & Session (B-1.7) ---------------------------------------------------

export const User = z.object({
	id: UserId,
	email: z.string(),
	displayName: z.string(),
	role: UserRole,
});
export type User = z.infer<typeof User>;

export async function findUserByEmail(
	ex: Executor,
	email: string,
): Promise<(User & { passwordHash: string }) | null> {
	const [row] = await ex.select().from(users).where(eq(users.email, email));
	if (!row) return null;
	return {
		...User.parse(row),
		passwordHash: z.string().parse(row.passwordHash),
	};
}

export async function createUser(
	ex: Executor,
	input: {
		email: string;
		passwordHash: string;
		displayName: string;
		role: UserRole;
	},
): Promise<User> {
	const [row] = await ex.insert(users).values(input).returning();
	return User.parse(row);
}

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/**
 * Token mentah dikembalikan sekali di sini, untuk cookie klien. Yang tersimpan
 * hanya hash-nya — baris ini bocor tidak cukup untuk login sebagai user.
 */
export async function createSession(
	ex: Executor,
	input: { userId: UserId; ttlMs: number },
): Promise<{ token: string; expiresAt: Date }> {
	const token = randomBytes(32).toString("hex");
	const expiresAt = new Date(Date.now() + input.ttlMs);
	await ex
		.insert(sessions)
		.values({ id: hashToken(token), userId: input.userId, expiresAt });
	return { token, expiresAt };
}

/** null bila token tidak ada atau sudah kedaluwarsa. */
export async function findSessionUser(
	ex: Executor,
	token: string,
): Promise<User | null> {
	const [row] = await ex
		.select({ user: users })
		.from(sessions)
		.innerJoin(users, eq(sessions.userId, users.id))
		.where(
			and(
				eq(sessions.id, hashToken(token)),
				gt(sessions.expiresAt, sql`now()`),
			),
		);
	return row ? User.parse(row.user) : null;
}

export async function deleteSession(
	ex: Executor,
	token: string,
): Promise<void> {
	await ex.delete(sessions).where(eq(sessions.id, hashToken(token)));
}
