import {
	Channel,
	ControlOwner,
	ConversationStatus,
	SenderType,
	UserRole,
} from "@ticko/domain";
import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

// Enum Postgres diturunkan dari skema Zod domain: satu daftar nilai.
export const channelEnum = pgEnum("channel", Channel.enum);
export const senderTypeEnum = pgEnum("sender_type", SenderType.enum);
export const conversationStatusEnum = pgEnum(
	"conversation_status",
	ConversationStatus.enum,
);
export const controlOwnerEnum = pgEnum("control_owner", ControlOwner.enum);
export const userRoleEnum = pgEnum("user_role", UserRole.enum);
export const agentRunStatusEnum = pgEnum("agent_run_status", [
	"succeeded",
	"failed",
	"discarded",
]);
export const jobStatusEnum = pgEnum("job_status", [
	"pending",
	"running",
	"done",
	"failed",
	"cancelled",
]);

// Semua waktu TIMESTAMPTZ, disimpan UTC.
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts("created_at").notNull().defaultNow();

export const users = pgTable("users", {
	id: uuid("id").primaryKey().defaultRandom(),
	email: text("email").notNull().unique(),
	passwordHash: text("password_hash").notNull(),
	displayName: text("display_name").notNull(),
	role: userRoleEnum("role").notNull(),
	createdAt: createdAt(),
});

// Session login internal (B-1.7). `id` adalah sha256(token) hex — token
// mentah cuma ada di cookie klien, kebocoran baris ini tidak cukup untuk
// login sebagai user.
export const sessions = pgTable("sessions", {
	id: text("id").primaryKey(),
	userId: uuid("user_id")
		.notNull()
		.references(() => users.id),
	expiresAt: ts("expires_at").notNull(),
	createdAt: createdAt(),
});

export const contacts = pgTable(
	"contacts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		channel: channelEnum("channel").notNull(),
		externalId: text("external_id").notNull(),
		displayName: text("display_name"),
		createdAt: createdAt(),
		updatedAt: ts("updated_at").notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("contacts_channel_external_id_key").on(t.channel, t.externalId),
	],
);

export const conversations = pgTable(
	"conversations",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		contactId: uuid("contact_id")
			.notNull()
			.references(() => contacts.id),
		channel: channelEnum("channel").notNull(),
		// Tujuan balasan di channel (chat id Telegram, nomor WhatsApp).
		externalConversationId: text("external_conversation_id").notNull(),
		status: conversationStatusEnum("status").notNull().default("new"),
		controlOwner: controlOwnerEnum("control_owner").notNull().default("none"),
		version: integer("version").notNull().default(0),
		lastInboundAt: ts("last_inbound_at"),
		resolvedAt: ts("resolved_at"),
		createdAt: createdAt(),
		updatedAt: ts("updated_at").notNull().defaultNow(),
	},
	(t) => [
		index("conversations_status_control_owner_idx").on(
			t.status,
			t.controlOwner,
		),
		// Satu percakapan aktif per kontak; findActiveOrCreate yang balapan
		// kalah di sini, bukan menghasilkan dua percakapan.
		uniqueIndex("conversations_one_active_per_contact")
			.on(t.contactId)
			.where(sql`${t.status} <> 'closed'`),
		// Lapis kedua dari controlOwnerFor() di domain/state.ts. Test integrasi
		// memastikan keduanya sepakat untuk setiap pasangan.
		check(
			"conversations_status_control_owner_check",
			sql`(${t.status} = 'bot_active' AND ${t.controlOwner} = 'bot')
			 OR (${t.status} = 'human_active' AND ${t.controlOwner} = 'human')
			 OR (${t.status} IN ('new', 'handoff_requested', 'resolved', 'closed')
			     AND ${t.controlOwner} = 'none')`,
		),
	],
);

export const messages = pgTable(
	"messages",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversations.id),
		senderType: senderTypeEnum("sender_type").notNull(),
		senderUserId: uuid("sender_user_id").references(() => users.id),
		// Kunci idempotency pesan masuk; adapter menjamin unik lintas chat
		// (Telegram: `<chat_id>:<message_id>`). NULL untuk pesan keluar.
		externalMessageId: text("external_message_id").unique(),
		content: text("content"),
		attachments: jsonb("attachments").notNull().default([]),
		sentAt: ts("sent_at").notNull(),
		// clock_timestamp(), bukan now(): beberapa pesan dalam satu transaksi
		// tetap punya urutan yang pasti.
		createdAt: ts("created_at").notNull().default(sql`clock_timestamp()`),
	},
	(t) => [
		index("messages_conversation_id_created_at_idx").on(
			t.conversationId,
			t.createdAt,
		),
	],
);

// Job queue & timer (A-1.3). Diklaim lewat FOR UPDATE SKIP LOCKED di
// packages/worker/src/queue.ts. Tidak ada scheduler lain.
export const jobs = pgTable(
	"jobs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		jobType: text("job_type").notNull(),
		conversationId: uuid("conversation_id").references(() => conversations.id),
		payload: jsonb("payload").notNull(),
		status: jobStatusEnum("status").notNull().default("pending"),
		// Jumlah kegagalan; gagal ke-(max_attempts + 1) → failed.
		attempts: integer("attempts").notNull().default(0),
		maxAttempts: integer("max_attempts").notNull().default(3),
		runAfter: ts("run_after").notNull().defaultNow(),
		lockedAt: ts("locked_at"),
		lockedBy: text("locked_by"),
		dedupeKey: text("dedupe_key").unique(),
		lastError: text("last_error"),
		createdAt: createdAt(),
		updatedAt: ts("updated_at").notNull().defaultNow(),
	},
	(t) => [
		index("jobs_pending_run_after_idx")
			.on(t.runAfter)
			.where(sql`${t.status} = 'pending'`),
		index("jobs_conversation_id_status_idx").on(t.conversationId, t.status),
	],
);

// Jejak setiap pemanggilan LLM (AC-3.6): prompt, respons mentah, token,
// latensi, biaya. `discarded` = jawaban dibuang karena control_owner berubah
// selama LLM berjalan.
export const agentRuns = pgTable(
	"agent_runs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversations.id),
		messageId: uuid("message_id")
			.notNull()
			.references(() => messages.id),
		replyMessageId: uuid("reply_message_id").references(() => messages.id),
		traceId: text("trace_id").notNull(),
		status: agentRunStatusEnum("status").notNull(),
		model: text("model").notNull(),
		prompt: jsonb("prompt").notNull(),
		response: text("response"),
		error: text("error"),
		promptTokens: integer("prompt_tokens").notNull().default(0),
		completionTokens: integer("completion_tokens").notNull().default(0),
		costEstimate: numeric("cost_estimate", {
			precision: 12,
			scale: 6,
			mode: "number",
		})
			.notNull()
			.default(0),
		latencyMs: integer("latency_ms").notNull().default(0),
		// Sumber jawaban dari basis pengetahuan (AC-7.5), terisi mulai Sprint 4.
		kbChunkIds: uuid("kb_chunk_ids").array().notNull().default(sql`'{}'`),
		createdAt: createdAt(),
	},
	(t) => [
		index("agent_runs_conversation_id_created_at_idx").on(
			t.conversationId,
			t.createdAt,
		),
	],
);

// Payload webhook yang gagal diparse Zod (AC-1.7, B-1.3). Webhook tetap
// membalas 200 supaya Telegram/Meta tidak retry terus lalu menonaktifkan
// endpoint-nya; baris di sini yang dipakai untuk pemeriksaan manual.
export const deadLetters = pgTable(
	"dead_letter",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		channel: channelEnum("channel").notNull(),
		// Body mentah request, bukan hasil parse — bentuknya bisa apa saja.
		payload: text("payload").notNull(),
		error: text("error").notNull(),
		createdAt: createdAt(),
	},
	(t) => [index("dead_letter_created_at_idx").on(t.createdAt)],
);
