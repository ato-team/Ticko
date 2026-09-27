import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { LlmClient } from "@ticko/agent";
import { FakeLlm } from "@ticko/agent/fake";
import { fromAdapters } from "@ticko/channels";
import { MockChannelAdapter } from "@ticko/channels/fake";
import { ConversationId, type InboundMessage } from "@ticko/domain";
import {
	changeStatus,
	getConversation,
	listRecentMessages,
	schema,
} from "@ticko/storage";
import { createLogger } from "@ticko/storage/log";
import { createTestDb } from "@ticko/storage/testing";
import { eq } from "drizzle-orm";
import { receiveInbound } from "../src/dispatch";
import { agentRunHandler } from "../src/handlers/agent";
import { sendMessageHandler } from "../src/handlers/send";
import { runJob } from "../src/poller";
import { claim, enqueue } from "../src/queue";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
	t = await createTestDb();
});
afterAll(() => t.drop());
beforeEach(async () => {
	await t.db.delete(schema.jobs);
	await t.db.delete(schema.agentRuns);
	await t.db.delete(schema.outboundQueue);
	await t.db.delete(schema.messages);
	await t.db.delete(schema.conversationEvents);
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

const config = {
	model: "fake",
	maxOutputTokens: 256,
	contextMaxTokens: 4000,
	recentMessages: 20,
	inputUsdPerMtok: 5,
	outputUsdPerMtok: 25,
};

function worker(
	llm: LlmClient = FakeLlm.withText("Halo! Ada yang bisa kami bantu?"),
) {
	const adapter = new MockChannelAdapter("telegram");
	const handlers = {
		agent_run: agentRunHandler({
			db: t.db,
			llm,
			config,
			systemPrompt: "Kamu CS.",
		}),
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
	return { adapter, drain, llm };
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

test("A-2.4: pertanyaan → dijawab AI, terkirim, agent_runs terisi", async () => {
	const w = worker();
	const r = await receiveInbound(t.db, inbound("halo"), "trace-ai");
	await w.drain();
	expect(
		w.adapter.sent.map((s) => [s.to, "text" in s ? s.text : null]),
	).toEqual([["42", "Halo! Ada yang bisa kami bantu?"]]);
	if (r.kind !== "stored") throw new Error("harus stored");
	const msgs = await listRecentMessages(t.db, r.conversationId, 10);
	expect(msgs.map((m) => [m.senderType, m.content])).toEqual([
		["contact", "halo"],
		["bot", "Halo! Ada yang bisa kami bantu?"],
	]);
	const [run] = await t.db.select().from(schema.agentRuns);
	expect(run).toMatchObject({
		status: "succeeded",
		traceId: "trace-ai",
		messageId: r.messageId,
		replyMessageId: msgs[1]?.id,
		response: "Halo! Ada yang bisa kami bantu?",
		prompt: {
			system: "Kamu CS.",
			messages: [{ role: "user", content: "halo" }],
			maxOutputTokens: 256,
		},
	});
	expect(run?.promptTokens).toBeGreaterThan(0);
	expect(run?.completionTokens).toBeGreaterThan(0);
	expect(run?.costEstimate).toBeGreaterThan(0);
});

test("HANDOFF: control_owner=human saat pesan masuk → tersimpan, tidak ada job, tidak ada balasan", async () => {
	const w = worker();
	const first = await receiveInbound(t.db, inbound("halo"), "t");
	if (first.kind !== "stored") throw new Error("harus stored");
	await w.drain();
	w.adapter.sent.length = 0;
	await t.db.transaction((tx) =>
		changeStatus(tx, { id: first.conversationId, event: "agent_claimed" }),
	);

	const r = await receiveInbound(t.db, inbound("masih di sana?"), "t");
	expect(r).toMatchObject({ kind: "stored", botScheduled: false });
	await w.drain();
	expect(w.adapter.sent).toHaveLength(0);
	expect(w.llm instanceof FakeLlm && w.llm.calls).toHaveLength(1);
	const pending = (await jobsOf()).filter(
		(j) => j.status === "pending" || j.status === "running",
	);
	expect(pending).toHaveLength(0);
});

test("HANDOFF: control_owner berubah setelah job dijadwalkan → worker membatalkan (AC-3.1)", async () => {
	const w = worker();
	const r = await receiveInbound(t.db, inbound("halo"), "t");
	if (r.kind !== "stored") throw new Error("harus stored");
	await t.db.transaction((tx) =>
		changeStatus(tx, { id: r.conversationId, event: "agent_claimed" }),
	);

	await w.drain();
	expect(w.adapter.sent).toHaveLength(0);
	expect(w.llm instanceof FakeLlm && w.llm.calls).toHaveLength(0);
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

test("A-2.6: gagal kirim dicoba ulang 3 kali lalu jadi dead letter", async () => {
	const w = worker();
	await receiveInbound(t.db, inbound("halo"), "t");
	for (let i = 0; i < 4; i++) {
		w.adapter.failNext = true;
		w.adapter.failWith = { kind: "network", cause: "putus" };
		// Lewati jeda backoff 1/4/16 detik.
		await t.db.update(schema.jobs).set({ runAfter: new Date() });
		await w.drain();
	}
	const [job] = await t.db
		.select()
		.from(schema.jobs)
		.where(eq(schema.jobs.jobType, "send_message"));
	expect(job).toMatchObject({ status: "failed", attempts: 4 });
	const [out] = await t.db.select().from(schema.outboundQueue);
	expect(out).toMatchObject({
		status: "dead",
		attempts: 4,
		lastError: "network",
	});
	expect(w.adapter.sent).toHaveLength(0);
});

test("A-2.6: worker menjalankan pesan yang sama dua kali → terkirim sekali", async () => {
	const w = worker();
	await receiveInbound(t.db, inbound("halo"), "t");
	await w.drain();
	const [out] = await t.db.select().from(schema.outboundQueue);
	if (!out) throw new Error("outbound_queue kosong");
	// Redelivery: job kedua untuk baris outbound yang sama.
	await enqueue(t.db, {
		type: "send_message",
		payload: { outboundId: out.id, traceId: "t" },
	});
	await w.drain();
	expect(w.adapter.sent).toHaveLength(1);
	const [after] = await t.db.select().from(schema.outboundQueue);
	expect(after).toMatchObject({ status: "sent", attempts: 1 });
	expect(after?.externalMessageId).not.toBeNull();
});

test("HANDOFF: control_owner berubah SELAMA LLM berjalan → jawaban dibuang, tidak terkirim", async () => {
	let conversationId = "";
	const llm: LlmClient = {
		complete: async () => {
			// Agent manusia mengambil alih tepat saat LLM sedang berpikir.
			await t.db.transaction((tx) =>
				changeStatus(tx, {
					id: ConversationId.parse(conversationId),
					event: "agent_claimed",
				}),
			);
			return {
				text: "jawaban basi",
				model: "fake",
				inputTokens: 10,
				outputTokens: 2,
				latencyMs: 5,
			};
		},
	};
	const w = worker(llm);
	const r = await receiveInbound(t.db, inbound("halo"), "t");
	if (r.kind !== "stored") throw new Error("harus stored");
	conversationId = r.conversationId;
	await w.drain();

	expect(w.adapter.sent).toHaveLength(0);
	const msgs = await listRecentMessages(t.db, r.conversationId, 10);
	expect(msgs.filter((m) => m.senderType === "bot")).toHaveLength(0);
	const [run] = await t.db.select().from(schema.agentRuns);
	expect(run).toMatchObject({
		status: "discarded",
		response: "jawaban basi",
		replyMessageId: null,
	});
	expect(
		(await jobsOf()).filter((j) => j.jobType === "send_message"),
	).toHaveLength(0);
});

test("pesan beruntun → hanya pesan terakhir yang dijawab, sekali", async () => {
	const w = worker();
	await receiveInbound(t.db, inbound("halo"), "t");
	await receiveInbound(t.db, inbound("mau tanya"), "t");
	await receiveInbound(t.db, inbound("soal pengiriman"), "t");
	await w.drain();
	expect(w.adapter.sent).toHaveLength(1);
	const llm = w.llm instanceof FakeLlm ? w.llm : null;
	expect(llm?.calls.map((c) => c.messages.map((m) => m.content))).toEqual([
		["halo", "mau tanya", "soal pengiriman"],
	]);
});

test("LLM gagal sementara → agent_runs failed + job diulang; ditolak → tidak membalas", async () => {
	const flaky = worker(FakeLlm.withError({ kind: "overloaded" }));
	await receiveInbound(t.db, inbound("halo"), "t");
	await flaky.drain();
	const [job] = await t.db
		.select()
		.from(schema.jobs)
		.where(eq(schema.jobs.jobType, "agent_run"));
	expect(job).toMatchObject({ status: "pending", attempts: 1 });
	expect((await t.db.select().from(schema.agentRuns))[0]).toMatchObject({
		status: "failed",
		error: "overloaded",
	});

	await t.db.delete(schema.jobs);
	const refused = worker(FakeLlm.withError({ kind: "refused" }));
	await receiveInbound(t.db, inbound("x", "77"), "t");
	await refused.drain();
	expect(refused.adapter.sent).toHaveLength(0);
	const [job2] = await t.db
		.select()
		.from(schema.jobs)
		.where(eq(schema.jobs.jobType, "agent_run"));
	expect(job2?.status).toBe("cancelled");
});
