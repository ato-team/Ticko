import { afterAll, beforeAll, expect, test } from "bun:test";
import { ConversationId } from "@ticko/domain";
import { schema } from "@ticko/storage";
import { createLogger } from "@ticko/storage/log";
import { createTestDb } from "@ticko/storage/testing";
import { eq } from "drizzle-orm";
import { type Handlers, runJob, startPoller } from "../src/poller";
import { claim, enqueue } from "../src/queue";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
	t = await createTestDb();
});
afterAll(() => t.drop());

const log = createLogger("error");
const conversationId = ConversationId.parse(
	"0b8e7a52-4c1f-4d2e-9a6b-3f5c8d7e1a20",
);
const status = async (id: string) =>
	(
		await t.db
			.select({ s: schema.jobs.status })
			.from(schema.jobs)
			.where(eq(schema.jobs.id, id))
	)[0]?.s;

const handlers = (send: Handlers["send_message"]): Handlers => ({
	send_message: send,
	agent_run: async () => ({ status: "done" }),
});

async function enqueueAndRun(h: Handlers) {
	const id = await enqueue(t.db, {
		type: "send_message",
		payload: { conversationId, text: "x", traceId: "trace" },
	});
	const job = await claim(t.db, "w");
	if (!job) throw new Error("job tidak terambil");
	await runJob(t.db, job, h, log);
	return id;
}

test("handler selesai → done; batal → cancelled; melempar → dijadwalkan ulang", async () => {
	const done = await enqueueAndRun(handlers(async () => ({ status: "done" })));
	const cancelled = await enqueueAndRun(
		handlers(async () => ({
			status: "cancelled",
			reason: "control_owner bukan bot",
		})),
	);
	const failed = await enqueueAndRun(
		handlers(async () => {
			throw new Error("jaringan putus");
		}),
	);
	expect([
		await status(done),
		await status(cancelled),
		await status(failed),
	]).toEqual(["done", "cancelled", "pending"]);
});

test("startPoller mengambil job dan berhenti dengan rapi", async () => {
	const seen: string[] = [];
	const id = await enqueue(t.db, {
		type: "send_message",
		payload: { conversationId, text: "dari poller", traceId: "trace" },
	});
	const poller = startPoller({
		db: t.db,
		workerId: "w-poller",
		log,
		intervalMs: 20,
		handlers: handlers(async (job) => {
			seen.push(job.payload.text);
			return { status: "done" };
		}),
	});
	for (let i = 0; i < 100 && (await status(id)) !== "done"; i++)
		await Bun.sleep(20);
	await poller.stop();
	expect(seen).toContain("dari poller");
	expect(await status(id)).toBe("done");
});
