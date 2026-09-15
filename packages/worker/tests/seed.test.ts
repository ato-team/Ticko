import { afterAll, expect, test } from "bun:test";
import { ConversationStatus } from "@ticko/domain";
import { schema } from "@ticko/storage";
import { createTestDb } from "@ticko/storage/testing";
import { runSeed } from "../src/seed";

// Butuh commit sungguhan (bukan withTestDb yang selalu rollback): idempotensi
// diverifikasi lewat pemanggilan runSeed kedua terhadap data yang sudah ada.
const { db, drop } = await createTestDb();
afterAll(drop);

test("runSeed idempoten dan mencakup keenam status (A-1.5)", async () => {
	const first = await runSeed(db);
	const rowsAfterFirst = await db.select().from(schema.conversations);
	expect(rowsAfterFirst).toHaveLength(first.conversations);

	const statuses = new Set(rowsAfterFirst.map((r) => r.status));
	for (const s of ConversationStatus.options)
		expect(statuses.has(s)).toBe(true);

	const second = await runSeed(db);
	expect(second).toEqual(first);
	const rowsAfterSecond = await db.select().from(schema.conversations);
	expect(rowsAfterSecond).toHaveLength(rowsAfterFirst.length);

	const contacts = await db.select().from(schema.contacts);
	expect(contacts).toHaveLength(20);
});
