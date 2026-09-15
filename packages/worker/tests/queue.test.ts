import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { ConversationId } from "@ticko/domain";
import { schema } from "@ticko/storage";
import { createTestDb } from "@ticko/storage/testing";
import { eq, sql } from "drizzle-orm";
import {
	claim,
	complete,
	enqueue,
	enqueueWithDedupe,
	fail,
	recoverStale,
} from "../src/queue";

const { jobs } = schema;
let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
	t = await createTestDb();
});
afterAll(() => t.drop());
beforeEach(async () => {
	await t.db.delete(jobs);
});

const conversationId = ConversationId.parse(
	"0b8e7a52-4c1f-4d2e-9a6b-3f5c8d7e1a20",
);
const payload = (text: string) => ({ conversationId, text, traceId: "trace" });

async function row(id: string) {
	const [r] = await t.db
		.select({
			status: jobs.status,
			attempts: jobs.attempts,
			delay: sql<number>`round(extract(epoch from ${jobs.runAfter} - now()))::int`,
		})
		.from(jobs)
		.where(eq(jobs.id, id));
	return r;
}

test("dua worker bersamaan tidak pernah mengambil job yang sama", async () => {
	for (let i = 0; i < 40; i++) {
		await enqueue(t.db, { type: "send_message", payload: payload(`m${i}`) });
	}
	const drain = async (workerId: string) => {
		const ids: string[] = [];
		for (
			let job = await claim(t.db, workerId);
			job;
			job = await claim(t.db, workerId)
		) {
			ids.push(job.id);
		}
		return ids;
	};
	const [a, b, c] = await Promise.all([drain("w1"), drain("w2"), drain("w3")]);
	const all = [...(a ?? []), ...(b ?? []), ...(c ?? [])];
	expect(all).toHaveLength(40);
	expect(new Set(all).size).toBe(40);
});

test("job belum jatuh tempo tidak diambil", async () => {
	await enqueue(t.db, {
		type: "send_message",
		payload: payload("nanti"),
		runAfter: new Date(Date.now() + 60_000),
	});
	expect(await claim(t.db, "w")).toBeNull();
});

test("gagal dicoba ulang dengan jeda 1, 4, 16 detik lalu failed", async () => {
	const id = await enqueue(t.db, {
		type: "send_message",
		payload: payload("x"),
	});
	const seen = [];
	for (let i = 0; i < 4; i++) {
		await t.db.update(jobs).set({ status: "running" }).where(eq(jobs.id, id));
		await fail(t.db, id, "boom");
		seen.push(await row(id));
	}
	expect(seen).toEqual([
		{ status: "pending", attempts: 1, delay: 1 },
		{ status: "pending", attempts: 2, delay: 4 },
		{ status: "pending", attempts: 3, delay: 16 },
		{ status: "failed", attempts: 4, delay: 64 },
	]);
});

test("lock lebih dari 5 menit dikembalikan ke pending", async () => {
	const stale = await enqueue(t.db, {
		type: "send_message",
		payload: payload("a"),
	});
	const fresh = await enqueue(t.db, {
		type: "send_message",
		payload: payload("b"),
	});
	await t.db
		.update(jobs)
		.set({ status: "running", lockedAt: sql`now() - interval '6 minutes'` })
		.where(eq(jobs.id, stale));
	await t.db
		.update(jobs)
		.set({ status: "running", lockedAt: sql`now() - interval '1 minute'` })
		.where(eq(jobs.id, fresh));
	expect(await recoverStale(t.db)).toBe(1);
	expect((await row(stale))?.status).toBe("pending");
	expect((await row(fresh))?.status).toBe("running");
});

test("enqueueWithDedupe menimpa run_after, tidak membuat duplikat", async () => {
	const key = `${conversationId}:echo`;
	const soon = new Date(Date.now() + 10_000);
	const later = new Date(Date.now() + 120_000);
	await enqueueWithDedupe(t.db, {
		type: "send_message",
		payload: payload("1"),
		dedupeKey: key,
		runAfter: soon,
	});
	await enqueueWithDedupe(t.db, {
		type: "send_message",
		payload: payload("2"),
		dedupeKey: key,
		runAfter: later,
	});
	const rows = await t.db.select().from(jobs).where(eq(jobs.dedupeKey, key));
	expect(rows).toHaveLength(1);
	expect(rows[0]?.runAfter.getTime()).toBe(later.getTime());
});

test("payload tidak valid ditandai failed saat diambil, bukan di-as", async () => {
	const [bad] = await t.db
		.insert(jobs)
		.values({ jobType: "send_message", payload: { text: 42 } })
		.returning({ id: jobs.id });
	const good = await enqueue(t.db, {
		type: "send_message",
		payload: payload("ok"),
	});

	const job = await claim(t.db, "w");
	expect(job?.id).toBe(good);
	expect(job?.type === "send_message" && job.payload.text).toBe("ok");
	expect((await row(bad?.id ?? ""))?.status).toBe("failed");
	if (job) await complete(t.db, job.id);
	expect((await row(good))?.status).toBe("done");
});
