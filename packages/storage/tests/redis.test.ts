import { afterAll, expect, test } from "bun:test";
import { ConversationId, type DeskEvent, Secret } from "@ticko/domain";
import { createLogger } from "../src/log";
import { createDeskSubscriber } from "../src/redis";

const url = new Secret(process.env.TICKO_REDIS_URL ?? "redis://127.0.0.1:6379");
const lines: string[] = [];
const log = createLogger("warn", { write: (l: string) => lines.push(l) });
const sub = createDeskSubscriber(url, log);
afterAll(() => sub.close());

const conversationId = ConversationId.parse(
	"0b8e7a52-4c1f-4d2e-9a6b-3f5c8d7e1a20",
);

// Proses Bun terpisah sebagai publisher, supaya pub/sub terbukti lintas proses.
async function publishFromOtherProcess(events: unknown[]) {
	const script = `
		import Redis from "ioredis";
		import { createLogger } from "@ticko/storage/log";
		import { publishDeskEvent } from "@ticko/storage/redis";
		const r = new Redis(process.env.TICKO_REDIS_URL);
		for (const e of ${JSON.stringify(events)}) {
			if (e === "rusak") await r.publish("desk:events", "{bukan json");
			else await publishDeskEvent(r, e, createLogger("error"));
		}
		r.disconnect();
	`;
	const proc = Bun.spawn(["bun", "-e", script], {
		cwd: import.meta.dir,
		env: { ...process.env, TICKO_REDIS_URL: url.reveal() },
		stderr: "pipe",
	});
	expect(await proc.exited).toBe(0);
}

async function waitFor(check: () => boolean) {
	for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10);
}

test("event dari proses lain sampai ke semua listener; pesan rusak dibuang", async () => {
	const a: DeskEvent[] = [];
	const b: DeskEvent[] = [];
	const stopA = sub.listen((e) => a.push(e));
	const stopB = sub.listen((e) => b.push(e));
	const event: DeskEvent = { type: "sla_breached", conversationId };

	await publishFromOtherProcess(["rusak", event]);
	await waitFor(() => a.length > 0 && b.length > 0);
	expect(a).toEqual([event]);
	expect(b).toEqual([event]);
	expect(lines.some((l) => l.includes("event desk tidak valid"))).toBe(true);

	// Listener yang dilepas (tab SSE ditutup) tidak menerima event lagi.
	stopA();
	await publishFromOtherProcess([
		{ type: "status_changed", conversationId, status: "closed" },
	]);
	await waitFor(() => b.length > 1);
	expect(a).toHaveLength(1);
	expect(b).toHaveLength(2);
	stopB();
});
