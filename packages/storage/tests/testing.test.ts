import { afterAll, beforeAll, expect, test } from "bun:test";
import { contacts } from "../src/schema";
import { createTestDb, withTestDb } from "../src/testing";

test("withTestDb: data test pertama tidak terlihat oleh test kedua (1/2)", async () => {
	const n = await withTestDb(async (tx) => {
		await tx
			.insert(contacts)
			.values({ channel: "telegram", externalId: "iso" });
		return (await tx.select().from(contacts)).length;
	});
	expect(n).toBe(1);
});

test("withTestDb: data test pertama tidak terlihat oleh test kedua (2/2)", async () => {
	const n = await withTestDb(
		async (tx) => (await tx.select().from(contacts)).length,
	);
	expect(n).toBe(0);
});

// Contoh test yang butuh commit sungguhan: dua koneksi berbeda harus melihat
// data yang sama. Pola ini dipakai untuk SKIP LOCKED dan uji balapan.
let isolated: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
	isolated = await createTestDb();
});
afterAll(() => isolated.drop());

test("createTestDb: commit terlihat dari koneksi lain", async () => {
	const { db } = isolated;
	await db
		.insert(contacts)
		.values({ channel: "telegram", externalId: "commit" });
	const [a, b] = await Promise.all([
		db.transaction((tx) => tx.select().from(contacts)),
		db.transaction((tx) => tx.select().from(contacts)),
	]);
	expect(a).toHaveLength(1);
	expect(b).toHaveLength(1);
});
