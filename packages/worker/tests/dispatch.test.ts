import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { fromAdapters } from "@ticko/channels";
import { MockChannelAdapter } from "@ticko/channels/fake";
import type { InboundMessage } from "@ticko/domain";
import {
	getConversation,
	listRecentMessages,
	schema,
	updateStatus,
} from "@ticko/storage";
import { createLogger } from "@ticko/storage/log";
import { createTestDb } from "@ticko/storage/testing";
import { eq } from "drizzle-orm";
import { receiveInbound } from "../src/dispatch";
import { echoAgentHandler } from "../src/handlers/agent";
import { sendMessageHandler } from "../src/handlers/send";
import { runJob } from "../src/poller";
import { claim } from "../src/queue";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
	t = await createTestDb();
});
afterAll(() => t.drop());
beforeEach(async () => {
	await t.db.delete(schema.jobs);
	await t.db.delete(schema.messages);
	await t.db.delete(schema.conversations);
	await t.db.delete(schema.contacts);
});

const log = createLogger("error");
let seq = 0;
const inbound = (text: string, chat = "42"): InboundMessage => ({
	channel: "telegram",
	externalConversationId: chat,
	externalMessageId: `${chat}:${++seq}`,
	senderExternalId: chat,
	senderDisplayName: "Budi",
	content: { text },
	attachments: [],
	sentAt: new Date().toISOString(),
});

const jobsOf = () => t.db.select().from(schema.jobs);

function worker() {
	const adapter = new MockChannelAdapter("telegram");
	const handlers = {
		agent_run: echoAgentHandler({ db: t.db }),
		send_message: sendMessageHandler({
			db: t.db,
			channels: fromAdapters(new Map([["telegram", adapter]])),
		}),
	};
	const drain = async () => {
		for (let job = await claim(t.db, "w"); job; job = await claim(t.db, "w")) {
			await runJob(t.db, job, handlers, log);
		}
	};
	return { adapter, drain };
}

test("pesan baru → bot_active, tersimpan, agent_run dijadwalkan", async () => {
	const r = await receiveInbound(t.db, inbound("halo"), "trace-1");
	if (r.kind !== "stored") throw new Error("harus stored");
	expect(r.botScheduled).toBe(true);
	expect(await getConversation(t.db, r.conversationId)).toMatchObject({
		status: "bot_active",
		controlOwner: "bot",
	});
	expect((await jobsOf()).map((j) => [j.jobType, j.status])).toEqual([
		["agent_run", "pending"],
	]);
});

test("webhook di-retry → duplicate, tidak ada job kedua", async () => {
	const msg = inbound("halo");
	await receiveInbound(t.db, msg, "a");
	expect(await receiveInbound(t.db, msg, "b")).toEqual({ kind: "duplicate" });
	expect(await jobsOf()).toHaveLength(1);
});

test("checkpoint Sprint 1: halo → 'Kamu bilang: halo' terkirim dan tersimpan", async () => {
	const w = worker();
	const r = await receiveInbound(t.db, inbound("halo"), "trace");
	await w.drain();
	expect(
		w.adapter.sent.map((s) => [s.to, "text" in s ? s.text : null]),
	).toEqual([["42", "Kamu bilang: halo"]]);
	if (r.kind !== "stored") throw new Error("harus stored");
	const msgs = await listRecentMessages(t.db, r.conversationId, 10);
	expect(msgs.map((m) => [m.senderType, m.content])).toEqual([
		["contact", "halo"],
		["bot", "Kamu bilang: halo"],
	]);
});

test("HANDOFF: control_owner=human saat pesan masuk → tersimpan, tidak ada job, tidak ada balasan", async () => {
	const w = worker();
	const first = await receiveInbound(t.db, inbound("halo"), "t");
	if (first.kind !== "stored") throw new Error("harus stored");
	await w.drain();
	w.adapter.sent.length = 0;
	await updateStatus(t.db, first.conversationId, "human_active");

	const r = await receiveInbound(t.db, inbound("masih di sana?"), "t");
	expect(r).toMatchObject({ kind: "stored", botScheduled: false });
	await w.drain();
	expect(w.adapter.sent).toHaveLength(0);
	const pending = (await jobsOf()).filter(
		(j) => j.status === "pending" || j.status === "running",
	);
	expect(pending).toHaveLength(0);
});

test("HANDOFF: control_owner berubah setelah job dijadwalkan → worker membatalkan (AC-3.1)", async () => {
	const w = worker();
	const r = await receiveInbound(t.db, inbound("halo"), "t");
	if (r.kind !== "stored") throw new Error("harus stored");
	await updateStatus(t.db, r.conversationId, "human_active");

	await w.drain();
	expect(w.adapter.sent).toHaveLength(0);
	const [job] = await t.db
		.select()
		.from(schema.jobs)
		.where(eq(schema.jobs.jobType, "agent_run"));
	expect(job?.status).toBe("cancelled");
	const msgs = await listRecentMessages(t.db, r.conversationId, 10);
	expect(msgs.filter((m) => m.senderType === "bot")).toHaveLength(0);
});

test("send_message: gagal sementara → retry; penerima memblokir bot → cancelled", async () => {
	const w = worker();
	await receiveInbound(t.db, inbound("a"), "t");
	w.adapter.failNext = true;
	w.adapter.failWith = { kind: "network", cause: "putus" };
	await w.drain();
	const send = async () =>
		(
			await t.db
				.select()
				.from(schema.jobs)
				.where(eq(schema.jobs.jobType, "send_message"))
		)[0];
	expect(await send()).toMatchObject({ status: "pending", attempts: 1 });

	await t.db.delete(schema.jobs);
	await receiveInbound(t.db, inbound("b"), "t");
	w.adapter.failNext = true;
	w.adapter.failWith = {
		kind: "recipient_unavailable",
		description: "bot diblokir",
	};
	await w.drain();
	expect(await send()).toMatchObject({
		status: "cancelled",
		lastError: "bot diblokir",
	});
});
