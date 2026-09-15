import { createHash, randomBytes } from "node:crypto";
import {
	Channel,
	ContactId,
	ControlOwner,
	ConversationId,
	type ConversationStatus,
	ConversationStatus as ConversationStatusSchema,
	controlOwnerFor,
	type InboundMessage,
	MessageId,
	SenderType,
	UserId,
	UserRole,
} from "@ticko/domain";
import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "./db";
import {
	agentRuns,
	contacts,
	conversations,
	deadLetters,
	messages,
	sessions,
	users,
} from "./schema";

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

/** control_owner selalu diturunkan dari status; tidak bisa disetel terpisah. */
export async function updateStatus(
	ex: Executor,
	id: ConversationId,
	status: ConversationStatus,
): Promise<void> {
	await ex
		.update(conversations)
		.set({
			status,
			controlOwner: controlOwnerFor(status),
			version: sql`${conversations.version} + 1`,
			updatedAt: sql`now()`,
		})
		.where(eq(conversations.id, id));
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
