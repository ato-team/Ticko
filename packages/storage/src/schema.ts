import {
	Channel,
	ControlOwner,
	ConversationStatus,
	SenderType,
} from "@ticko/domain";
import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	jsonb,
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
export const userRoleEnum = pgEnum("user_role", ["admin", "agent"]);

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
