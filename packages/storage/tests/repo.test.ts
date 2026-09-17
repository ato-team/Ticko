import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assertNever, type InboundMessage, UserId } from "@ticko/domain";
import { eq } from "drizzle-orm";
import {
	changeStatus,
	findActiveOrCreate,
	findOrCreateContact,
	getConversation,
	getMessage,
	insertAgentRun,
	insertDeadLetter,
	insertInbound,
	insertOutbound,
	listRecentMessages,
	recordInboundAt,
} from "../src/repo";
import {
	agentRuns,
	contacts,
	conversationEvents,
	conversations,
	deadLetters,
	messages,
} from "../src/schema";
import { createTestDb, withTestDb } from "../src/testing";

const inbound = (externalMessageId: string, text = "halo"): InboundMessage => ({
	channel: "telegram",
	externalConversationId: "42",
	externalMessageId,
	senderExternalId: "42",
	senderDisplayName: "Budi",
	content: { text },
	attachments: [],
	sentAt: "2026-09-14T03:00:00.000Z",
});

// Test balapan butuh commit sungguhan dan banyak koneksi.
describe("balapan", () => {
	let t: Awaited<ReturnType<typeof createTestDb>>;
	beforeAll(async () => {
		t = await createTestDb();
	});
	afterAll(() => t.drop());

	test("findOrCreateContact bersamaan → satu baris (AC-1.4)", async () => {
		const input = {
			channel: "telegram",
			externalId: "race",
			displayName: null,
		} as const;
		const results = await Promise.all(
			Array.from({ length: 10 }, () => findOrCreateContact(t.db, input)),
		);
		expect(new Set(results.map((c) => c.id)).size).toBe(1);
		const rows = await t.db
			.select()
			.from(contacts)
			.where(eq(contacts.externalId, "race"));
		expect(rows).toHaveLength(1);
	});

	test("findActiveOrCreate bersamaan → satu percakapan aktif", async () => {
		const c = await findOrCreateContact(t.db, {
			channel: "telegram",
			externalId: "race-conv",
			displayName: null,
		});
		const input = {
			contactId: c.id,
			channel: "telegram",
			externalConversationId: "1",
		} as const;
		const results = await Promise.all(
			Array.from({ length: 10 }, () =>
				t.db.transaction((tx) => findActiveOrCreate(tx, input)),
			),
		);
		expect(new Set(results.map((r) => r.id)).size).toBe(1);
	});
});

test("contact: displayName diperbarui, null tidak menimpa", async () => {
	await withTestDb(async (tx) => {
		const a = await findOrCreateContact(tx, {
			channel: "telegram",
			externalId: "7",
			displayName: "Budi",
		});
		const b = await findOrCreateContact(tx, {
			channel: "telegram",
			externalId: "7",
			displayName: null,
		});
		const c = await findOrCreateContact(tx, {
			channel: "telegram",
			externalId: "7",
			displayName: "Budi S",
		});
		expect(b).toEqual(a);
		expect(c).toEqual({ ...a, displayName: "Budi S" });
	});
});

test("pesan dari kontak dengan percakapan aktif digabung ke sana; closed membuat baru (AC-1.5)", async () => {
	await withTestDb(async (tx) => {
		const c = await findOrCreateContact(tx, {
			channel: "telegram",
			externalId: "8",
			displayName: null,
		});
		const input = {
			contactId: c.id,
			channel: "telegram",
			externalConversationId: "8",
		} as const;
		const first = await findActiveOrCreate(tx, input);
		expect(first).toMatchObject({
			status: "new",
			controlOwner: "none",
			version: 0,
		});

		await changeStatus(tx, { id: first.id, event: "message_received" });
		const again = await findActiveOrCreate(tx, input);
		expect(again).toMatchObject({
			id: first.id,
			status: "bot_active",
			controlOwner: "bot",
			version: 1,
		});

		await changeStatus(tx, { id: first.id, event: "resolved" });
		await changeStatus(tx, { id: first.id, event: "inactivity_timeout" });
		const fresh = await findActiveOrCreate(tx, input);
		expect(fresh.id).not.toBe(first.id);
	});
});

test("getConversation dan recordInboundAt", async () => {
	await withTestDb(async (tx) => {
		const c = await findOrCreateContact(tx, {
			channel: "telegram",
			externalId: "9",
			displayName: null,
		});
		const conv = await findActiveOrCreate(tx, {
			contactId: c.id,
			channel: "telegram",
			externalConversationId: "9",
		});
		await recordInboundAt(tx, conv.id, "2026-09-14T03:00:00.000Z");
		expect(
			await getConversation(tx, conv.id, { forUpdate: true }),
		).toMatchObject({
			lastInboundAt: "2026-09-14T03:00:00.000Z",
		});
		await tx.delete(conversations).where(eq(conversations.id, conv.id));
		expect(await getConversation(tx, conv.id)).toBeNull();
	});
});

test("insertInbound dua kali → satu baris, panggilan kedua duplicate (AC-1.3)", async () => {
	await withTestDb(async (tx) => {
		const c = await findOrCreateContact(tx, {
			channel: "telegram",
			externalId: "10",
			displayName: null,
		});
		const conv = await findActiveOrCreate(tx, {
			contactId: c.id,
			channel: "telegram",
			externalConversationId: "10",
		});

		const first = await insertInbound(tx, conv.id, inbound("10:1"));
		const second = await insertInbound(tx, conv.id, inbound("10:1"));
		expect(first.ok).toBe(true);
		expect(second).toEqual({
			ok: false,
			error: { kind: "duplicate", externalId: "10:1" },
		});

		// Pola pemanggil: cabang per varian, ditutup assertNever.
		const handled = second.ok
			? "stored"
			: (() => {
					switch (second.error.kind) {
						case "duplicate":
							return "ignored";
						default:
							return assertNever(second.error.kind);
					}
				})();
		expect(handled).toBe("ignored");

		const rows = await tx
			.select()
			.from(messages)
			.where(eq(messages.externalMessageId, "10:1"));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.senderType).toBe("contact");
	});
});

test("listRecentMessages: N terakhir, urut lama → baru, termasuk balasan bot", async () => {
	await withTestDb(async (tx) => {
		const c = await findOrCreateContact(tx, {
			channel: "telegram",
			externalId: "11",
			displayName: null,
		});
		const conv = await findActiveOrCreate(tx, {
			contactId: c.id,
			channel: "telegram",
			externalConversationId: "11",
		});
		for (let i = 1; i <= 5; i++)
			await insertInbound(tx, conv.id, inbound(`11:${i}`, `m${i}`));
		await insertOutbound(tx, {
			conversationId: conv.id,
			senderType: "bot",
			content: "balasan",
		});

		const recent = await listRecentMessages(tx, conv.id, 3);
		expect(recent.map((m) => [m.senderType, m.content])).toEqual([
			["contact", "m4"],
			["contact", "m5"],
			["bot", "balasan"],
		]);
	});
});

test("insertOutbound menyimpan pesan bot/system tanpa externalMessageId", async () => {
	await withTestDb(async (tx) => {
		const c = await findOrCreateContact(tx, {
			channel: "telegram",
			externalId: "12",
			displayName: null,
		});
		const conv = await findActiveOrCreate(tx, {
			contactId: c.id,
			channel: "telegram",
			externalConversationId: "12",
		});
		const id = await insertOutbound(tx, {
			conversationId: conv.id,
			senderType: "system",
			content: "sistem: eskalasi",
		});
		const rows = await tx.select().from(messages).where(eq(messages.id, id));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			senderType: "system",
			content: "sistem: eskalasi",
			externalMessageId: null,
		});
	});
});

test("getMessage mengembalikan pesan tersimpan, null bila tidak ada", async () => {
	await withTestDb(async (tx) => {
		const c = await findOrCreateContact(tx, {
			channel: "telegram",
			externalId: "13",
			displayName: null,
		});
		const conv = await findActiveOrCreate(tx, {
			contactId: c.id,
			channel: "telegram",
			externalConversationId: "13",
		});
		const inserted = await insertInbound(
			tx,
			conv.id,
			inbound("13:1", "halo bot"),
		);
		if (!inserted.ok) throw new Error("insertInbound gagal");

		const found = await getMessage(tx, inserted.id);
		expect(found).toMatchObject({
			id: inserted.id,
			conversationId: conv.id,
			senderType: "contact",
			content: "halo bot",
		});

		await tx.delete(messages).where(eq(messages.id, inserted.id));
		expect(await getMessage(tx, inserted.id)).toBeNull();
	});
});

test("insertAgentRun mencatat jejak pemanggilan LLM (AC-3.6)", async () => {
	await withTestDb(async (tx) => {
		const c = await findOrCreateContact(tx, {
			channel: "telegram",
			externalId: "14",
			displayName: null,
		});
		const conv = await findActiveOrCreate(tx, {
			contactId: c.id,
			channel: "telegram",
			externalConversationId: "14",
		});
		const inserted = await insertInbound(tx, conv.id, inbound("14:1"));
		if (!inserted.ok) throw new Error("insertInbound gagal");
		const replyId = await insertOutbound(tx, {
			conversationId: conv.id,
			senderType: "bot",
			content: "balasan bot",
		});

		const runId = await insertAgentRun(tx, {
			conversationId: conv.id,
			messageId: inserted.id,
			replyMessageId: replyId,
			traceId: "trace-14",
			status: "succeeded",
			model: "test-model",
			prompt: { messages: [] },
			response: "balasan bot",
		});

		expect(typeof runId).toBe("string");

		const rows = await tx
			.select()
			.from(agentRuns)
			.where(eq(agentRuns.id, runId));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: runId,
			conversationId: conv.id,
			messageId: inserted.id,
			replyMessageId: replyId,
			traceId: "trace-14",
			status: "succeeded",
			model: "test-model",
			prompt: { messages: [] },
			response: "balasan bot",
		});
	});
});

test("changeStatus mencatat satu conversation_events per perubahan status (AC-2.6)", async () => {
	await withTestDb(async (tx) => {
		const c = await findOrCreateContact(tx, {
			channel: "telegram",
			externalId: "15",
			displayName: null,
		});
		const conv = await findActiveOrCreate(tx, {
			contactId: c.id,
			channel: "telegram",
			externalConversationId: "15",
		});

		const result = await changeStatus(tx, {
			id: conv.id,
			event: "message_received",
		});
		expect(result).toMatchObject({ ok: true, status: "bot_active" });

		const rows = await tx
			.select()
			.from(conversationEvents)
			.where(eq(conversationEvents.conversationId, conv.id));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			conversationId: conv.id,
			fromStatus: "new",
			toStatus: "bot_active",
			trigger: "message_received",
			triggeredByUserId: null,
		});
	});
});

test("changeStatus menolak transisi tak sah tanpa menulis apa pun", async () => {
	await withTestDb(async (tx) => {
		const c = await findOrCreateContact(tx, {
			channel: "telegram",
			externalId: "16",
			displayName: null,
		});
		const conv = await findActiveOrCreate(tx, {
			contactId: c.id,
			channel: "telegram",
			externalConversationId: "16",
		});

		// "new" tidak menerima resolved.
		const result = await changeStatus(tx, { id: conv.id, event: "resolved" });
		expect(result.ok).toBe(false);

		const after = await getConversation(tx, conv.id);
		expect(after?.status).toBe("new");
		const rows = await tx
			.select()
			.from(conversationEvents)
			.where(eq(conversationEvents.conversationId, conv.id));
		expect(rows).toHaveLength(0);
	});
});

test("changeStatus tanpa perubahan status sungguhan tidak menulis event", async () => {
	await withTestDb(async (tx) => {
		const c = await findOrCreateContact(tx, {
			channel: "telegram",
			externalId: "17",
			displayName: null,
		});
		const conv = await findActiveOrCreate(tx, {
			contactId: c.id,
			channel: "telegram",
			externalConversationId: "17",
		});
		await changeStatus(tx, { id: conv.id, event: "message_received" });

		// bot_active + message_received tetap bot_active (event.ts: tidak berubah).
		const result = await changeStatus(tx, {
			id: conv.id,
			event: "message_received",
		});
		expect(result).toMatchObject({ ok: true, status: "bot_active" });

		const rows = await tx
			.select()
			.from(conversationEvents)
			.where(eq(conversationEvents.conversationId, conv.id));
		expect(rows).toHaveLength(1); // hanya dari transisi new → bot_active di atas
		const after = await getConversation(tx, conv.id);
		expect(after?.version).toBe(1); // versi tidak naik lagi
	});
});

test("changeStatus: kegagalan insert event membatalkan update status juga (AC-2.6)", async () => {
	await withTestDb(async (tx) => {
		const c = await findOrCreateContact(tx, {
			channel: "telegram",
			externalId: "18",
			displayName: null,
		});
		const conv = await findActiveOrCreate(tx, {
			contactId: c.id,
			channel: "telegram",
			externalConversationId: "18",
		});
		await changeStatus(tx, { id: conv.id, event: "message_received" });

		const badUserId = UserId.parse("00000000-0000-0000-0000-000000000000");
		// userId acak tidak ada di tabel users → FK gagal saat insert event,
		// yang harus membatalkan update conversations.status juga.
		await expect(
			tx.transaction((sp) =>
				changeStatus(sp, {
					id: conv.id,
					event: "handoff_requested",
					userId: badUserId,
				}),
			),
		).rejects.toThrow();

		const after = await getConversation(tx, conv.id);
		expect(after?.status).toBe("bot_active");
		const rows = await tx
			.select()
			.from(conversationEvents)
			.where(eq(conversationEvents.conversationId, conv.id));
		expect(rows).toHaveLength(1); // cuma event new → bot_active, bukan yang gagal
	});
});

test("insertDeadLetter menyimpan payload mentah dan pesan error utuh (AC-1.7)", async () => {
	await withTestDb(async (tx) => {
		await insertDeadLetter(tx, {
			channel: "telegram",
			payload: "{bukan json",
			error: "Unexpected end of JSON input",
		});
		const rows = await tx.select().from(deadLetters);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			channel: "telegram",
			payload: "{bukan json",
			error: "Unexpected end of JSON input",
		});
	});
});
