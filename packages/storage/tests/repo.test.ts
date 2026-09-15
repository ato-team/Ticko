import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assertNever, type InboundMessage } from "@ticko/domain";
import { eq } from "drizzle-orm";
import {
	findActiveOrCreate,
	findOrCreateContact,
	getConversation,
	insertDeadLetter,
	insertInbound,
	insertOutbound,
	listRecentMessages,
	recordInboundAt,
	updateStatus,
} from "../src/repo";
import { contacts, conversations, deadLetters, messages } from "../src/schema";
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

		await updateStatus(tx, first.id, "bot_active");
		const again = await findActiveOrCreate(tx, input);
		expect(again).toMatchObject({
			id: first.id,
			status: "bot_active",
			controlOwner: "bot",
			version: 1,
		});

		await updateStatus(tx, first.id, "resolved");
		await updateStatus(tx, first.id, "closed");
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
