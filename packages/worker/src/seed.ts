import {
	type ConversationStatus,
	controlOwnerFor,
	loadAppConfig,
} from "@ticko/domain";
import { close, connect, type Db, schema } from "@ticko/storage";
import { eq } from "drizzle-orm";
import { runSteps } from "./ui/task";

// A-1.5: `bun run db:seed` mengisi database dengan data realistis supaya Dev B
// bisa membangun halaman inbox (Sprint 2) sebelum alur handoff (Sprint 3)
// selesai. Idempoten: setiap kontak/percakapan/pesan punya id eksternal
// deterministik dan dicek dulu sebelum insert.

const CONTACT_COUNT = 20;

// 3+4+3+3+3+4 = 20 — satu percakapan "utama" per kontak, mencakup keenam status.
const PRIMARY: { status: ConversationStatus; backdateHours?: number }[] = [
	{ status: "new" },
	{ status: "new" },
	{ status: "new" },
	{ status: "bot_active" },
	{ status: "bot_active" },
	{ status: "bot_active" },
	{ status: "bot_active" },
	{ status: "handoff_requested", backdateHours: 3 }, // lewat SLA
	{ status: "handoff_requested", backdateHours: 20 }, // tertunda, di luar jam kerja
	{ status: "handoff_requested" },
	{ status: "human_active" },
	{ status: "human_active" },
	{ status: "human_active" },
	{ status: "resolved" },
	{ status: "resolved" },
	{ status: "resolved" },
	{ status: "closed" },
	{ status: "closed" },
	{ status: "closed" },
	{ status: "closed" },
];

// Riwayat tambahan (closed, exempt dari index unik "satu percakapan aktif per
// kontak") supaya total 30 percakapan sesuai target Backlog A-1.5.
const EXTRA_CLOSED = 10;

// ponytail: "lewat SLA" dan "tertunda" di sini cuma perkiraan lewat
// backdateHours pada updated_at — belum ada kolom SLA/antrian tertunda
// sungguhan (menyusul A-3.4/A-4.5 di Sprint 3-4).

function required<T>(v: T | undefined, msg: string): T {
	if (v === undefined) throw new Error(msg);
	return v;
}

async function upsertContact(db: Db, i: number): Promise<string> {
	const displayName = `Kontak Seed ${i}`;
	const [row] = await db
		.insert(schema.contacts)
		.values({
			channel: "telegram",
			externalId: `seed-contact-${i}`,
			displayName,
		})
		.onConflictDoUpdate({
			target: [schema.contacts.channel, schema.contacts.externalId],
			set: { displayName },
		})
		.returning({ id: schema.contacts.id });
	return required(row?.id, `upsert kontak ${i} gagal`);
}

async function ensureConversation(
	db: Db,
	contactId: string,
	externalConversationId: string,
	status: ConversationStatus,
	backdateHours?: number,
): Promise<string> {
	const [existing] = await db
		.select({ id: schema.conversations.id })
		.from(schema.conversations)
		.where(
			eq(schema.conversations.externalConversationId, externalConversationId),
		);
	if (existing) return existing.id;

	const backdated = backdateHours
		? new Date(Date.now() - backdateHours * 60 * 60 * 1000)
		: new Date();
	const [row] = await db
		.insert(schema.conversations)
		.values({
			contactId,
			channel: "telegram",
			externalConversationId,
			status,
			controlOwner: controlOwnerFor(status),
			lastInboundAt: backdated,
			updatedAt: backdated,
		})
		.returning({ id: schema.conversations.id });
	return required(row?.id, `insert percakapan ${externalConversationId} gagal`);
}

const TURNS: { senderType: "contact" | "bot"; content: string }[] = [
	{ senderType: "contact", content: "Halo, saya butuh bantuan." },
	{ senderType: "bot", content: "Tentu, ada yang bisa dibantu?" },
	{ senderType: "contact", content: "Pesanan saya belum sampai." },
	{ senderType: "bot", content: "Baik, saya cek dulu ya." },
];

async function ensureMessages(
	db: Db,
	conversationId: string,
	seq: number,
): Promise<void> {
	for (const [i, turn] of TURNS.entries()) {
		await db
			.insert(schema.messages)
			.values({
				conversationId,
				senderType: turn.senderType,
				externalMessageId: `seed-msg-${seq}-${i}`,
				content: turn.content,
				sentAt: new Date(Date.now() - (TURNS.length - i) * 60_000),
			})
			.onConflictDoNothing({ target: schema.messages.externalMessageId });
	}
}

export async function runSeed(
	db: Db,
): Promise<{ contacts: number; conversations: number }> {
	const contactIds: string[] = [];
	for (let i = 1; i <= CONTACT_COUNT; i++)
		contactIds.push(await upsertContact(db, i));

	let seq = 0;
	for (const [i, spec] of PRIMARY.entries()) {
		seq++;
		const contactId = required(
			contactIds[i],
			`index kontak ${i} di luar jangkauan`,
		);
		const convId = await ensureConversation(
			db,
			contactId,
			`seed-conv-${i + 1}`,
			spec.status,
			spec.backdateHours,
		);
		await ensureMessages(db, convId, seq);
	}

	for (let i = 0; i < EXTRA_CLOSED; i++) {
		seq++;
		const contactId = required(
			contactIds[i % CONTACT_COUNT],
			`index kontak ${i % CONTACT_COUNT} di luar jangkauan`,
		);
		const convId = await ensureConversation(
			db,
			contactId,
			`seed-conv-extra-${i + 1}`,
			"closed",
		);
		await ensureMessages(db, convId, seq);
	}

	return {
		contacts: CONTACT_COUNT,
		conversations: PRIMARY.length + EXTRA_CLOSED,
	};
}

if (import.meta.main) {
	let db: Db | undefined;
	let config: Awaited<ReturnType<typeof loadAppConfig>> | undefined;
	const ok = await runSteps("Seed data", [
		{
			label: "Memuat config/app.toml",
			run: async () => {
				config = await loadAppConfig();
				return undefined;
			},
		},
		{
			label: "Mengisi kontak, percakapan, dan pesan",
			run: async () => {
				if (!config) throw new Error("config belum dimuat");
				db = connect(config.database);
				const r = await runSeed(db);
				return `${r.contacts} kontak, ${r.conversations} percakapan`;
			},
		},
	]);
	if (db) await close(db);
	process.exit(ok ? 0 : 1);
}
