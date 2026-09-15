import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { stripVTControlCharacters, styleText } from "node:util";
import { createLlmClient, type LlmClient } from "@ticko/agent";
// Hanya alat pengecekan lokal: `--fake` sengaja memakai LLM palsu.
import { FakeLlm } from "@ticko/agent/fake";
import { fromAdapters } from "@ticko/channels";
import {
	type ChannelAdapter,
	ConfigError,
	type ConversationEvent,
	type ConversationId,
	loadAgentConfig,
	loadAppConfig,
	type SentMessage,
	transition,
} from "@ticko/domain";
import {
	close,
	connect,
	type Db,
	getConversation,
	listRecentMessages,
	schema,
	updateStatus,
} from "@ticko/storage";
import { createLogger } from "@ticko/storage/log";
import { desc, eq } from "drizzle-orm";
import { receiveInbound } from "./dispatch";
import { type AgentDeps, agentRunHandler } from "./handlers/agent";
import { sendMessageHandler } from "./handlers/send";
import { type Handlers, runJob } from "./poller";
import { claim } from "./queue";

// REPL pengecekan agent. Pesan melewati jalur produksi yang sama dengan webhook
// (dispatcher → jobs → agent worker → send_message); hanya adapter channel yang
// diganti: balasan dicetak ke terminal, tidak dikirim ke Telegram.

const { agentRuns, conversations, contacts, jobs } = schema;

const HELP = `${styleText("bold", "Percakapan")}   /new  /takeover  /handback
${styleText("bold", "Inspeksi")}     /status  /msgs [n]  /runs [n]  /jobs [n]  /convs [n]
${styleText("bold", "Lainnya")}      /help  /quit
Ketik teks biasa untuk mengirim pesan sebagai pelanggan.`;

export interface CliDeps {
	db: Db;
	llm: LlmClient;
	config: AgentDeps["config"];
	systemPrompt: string;
	print: (line: string) => void;
}

// Warna status: bot_active hijau (aman), human_active kuning (perlu perhatian),
// selainnya (misal closed) dim.
function statusColor(status: string): string {
	if (status === "bot_active") return "green";
	if (status === "human_active") return "yellow";
	return "gray";
}

function badge(status: string): string {
	return styleText(statusColor(status) as Parameters<typeof styleText>[0], "●");
}

function ok(s: string): string {
	return styleText("green", `✓ ${s}`);
}

function fail(s: string): string {
	return styleText("red", `✗ ${s}`);
}

/** id → 8 karakter pertama, tanggal → jam:menit:detik UTC, null → "-". Tampilan saja. */
function formatCell(v: unknown): string {
	if (v == null) return "-";
	if (v instanceof Date) return `${v.toISOString().slice(11, 19)} UTC`;
	if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
		return `${v.slice(11, 19)} UTC`;
	}
	if (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v)) return v.slice(0, 8);
	return String(v);
}

/** Daftar key: value vertikal, untuk satu objek (mis. /status). */
function renderKv(row: Record<string, unknown>): string {
	const keys = Object.keys(row);
	const width = Math.max(...keys.map((k) => k.length));
	return keys
		.map(
			(k) => `  ${styleText("bold", k.padEnd(width))}  ${formatCell(row[k])}`,
		)
		.join("\n");
}

/** Tabel rata kolom, dipotong ke lebar terminal. Kosong → satu baris dim. */
function renderTable(rows: Record<string, unknown>[]): string {
	if (rows.length === 0) return dim("(belum ada data)");
	const cols = Object.keys(rows[0] ?? {});
	const cells = rows.map((r) => cols.map((c) => formatCell(r[c])));
	const widths = cols.map((c, i) =>
		Math.max(c.length, ...cells.map((row) => row[i]?.length ?? 0)),
	);
	const maxWidth = (process.stdout.columns || 100) - 2;
	const pad = (s: string, w: number) =>
		s + " ".repeat(Math.max(0, w - s.length));
	const line = (values: string[]) => {
		let out = values.map((v, i) => pad(v, widths[i] ?? 0)).join("  ");
		if (stripVTControlCharacters(out).length > maxWidth) {
			out = `${out.slice(0, maxWidth - 1)}…`;
		}
		return out;
	};
	const header = styleText("bold", line(cols.map((c) => c.toUpperCase())));
	return [header, ...cells.map(line)].join("\n");
}

export function createCli(deps: CliDeps) {
	const { db, print } = deps;
	// Ringkasan per giliran sudah menampilkan kegagalan; log JSON hanya mengganggu.
	const log = createLogger("error");
	let chatId = newChatId();
	let conversationId: ConversationId | null = null;
	let seq = 0;

	const terminal: ChannelAdapter = {
		channel: "telegram",
		async sendText(_to: string, text: string): Promise<SentMessage> {
			print(`${styleText("green", "bot       ›")} ${text}`);
			seq += 1;
			return {
				externalMessageId: `${chatId}:out-${seq}`,
				sentAt: new Date().toISOString(),
			};
		},
		async sendTemplate(): Promise<SentMessage> {
			throw new Error("template tidak didukung di CLI");
		},
		supportsFreeForm: () => true,
	};

	const handlers: Handlers = {
		agent_run: agentRunHandler({
			db,
			llm: deps.llm,
			config: deps.config,
			systemPrompt: deps.systemPrompt,
		}),
		send_message: sendMessageHandler({
			db,
			channels: fromAdapters(new Map([["telegram", terminal]])),
		}),
	};

	// Jalankan job sinkron sampai antrian kosong. Job yang dijadwalkan ulang
	// (run_after di masa depan) tidak ditunggu; statusnya terlihat di /jobs.
	async function drain() {
		for (let job = await claim(db, "cli"); job; job = await claim(db, "cli")) {
			await runJob(db, job, handlers, log);
		}
	}

	async function send(text: string) {
		seq += 1;
		const started = new Date();
		const r = await receiveInbound(
			db,
			{
				channel: "telegram",
				externalConversationId: chatId,
				externalMessageId: `${chatId}:${Date.now()}-${seq}`,
				senderExternalId: chatId,
				senderDisplayName: "Pelanggan CLI",
				content: { text },
				attachments: [],
				sentAt: new Date().toISOString(),
			},
			`cli-${crypto.randomUUID()}`,
		);
		if (r.kind === "duplicate") return print(dim("pesan duplikat, diabaikan"));
		conversationId = r.conversationId;
		if (!r.botScheduled) {
			print(dim("dispatcher: control_owner bukan bot → tidak ada agent_run"));
		}
		await drain();
		await summary(started);
	}

	/** Ringkasan giliran ini saja: run/job lama tidak ikut ditampilkan. */
	async function summary(since: Date) {
		if (!conversationId) return;
		const conv = await getConversation(db, conversationId);
		const [run] = await db
			.select()
			.from(agentRuns)
			.where(eq(agentRuns.conversationId, conversationId))
			.orderBy(desc(agentRuns.createdAt))
			.limit(1);
		const [job] = await db
			.select()
			.from(jobs)
			.where(eq(jobs.conversationId, conversationId))
			.orderBy(desc(jobs.createdAt))
			.limit(1);
		const parts = [
			conv
				? `${badge(conv.status)} ${conv.status} (${conv.controlOwner})`
				: "?",
		];
		if (run && run.createdAt >= since) {
			const mark = run.status === "succeeded" ? ok("run") : fail("run");
			const secs = (run.latencyMs / 1000).toFixed(1);
			parts.push(
				`${mark} ${run.promptTokens}→${run.completionTokens} tok · $${run.costEstimate} · ${secs}s${run.error ? ` (${run.error})` : ""}`,
			);
		}
		if (job && job.createdAt >= since && job.status !== "done") {
			parts.push(
				styleText(
					"yellow",
					`job ${job.jobType} ${job.status}: ${job.lastError ?? "-"}`,
				),
			);
		}
		print(`  ${parts.join(dim(" · "))}`);
	}

	async function changeControl(event: ConversationEvent) {
		if (!conversationId)
			return print(dim("belum ada percakapan; kirim pesan dulu"));
		const id = conversationId;
		const result = await db.transaction(async (tx) => {
			const conv = await getConversation(tx, id, { forUpdate: true });
			if (!conv) return fail("percakapan tidak ditemukan");
			const next = transition(conv.status, event);
			if (!next.ok)
				return fail(`transisi ditolak: ${conv.status} --${event}-->`);
			await updateStatus(tx, id, next.status);
			return ok(
				`${conv.status} → ${next.status} (control_owner=${next.controlOwner})`,
			);
		});
		print(result);
	}

	function requireConv(): ConversationId | null {
		if (!conversationId) print(dim("belum ada percakapan; kirim pesan dulu"));
		return conversationId;
	}

	/** Mengembalikan false saat pengguna keluar. */
	async function handle(line: string): Promise<boolean> {
		const input = line.trim();
		if (input === "") return true;
		if (!input.startsWith("/")) {
			await send(input);
			return true;
		}
		const [cmd, arg] = input.split(/\s+/, 2);
		const n = Number.parseInt(arg ?? "", 10) || 10;
		switch (cmd) {
			case "/quit":
			case "/exit":
				return false;
			case "/help":
				print(HELP);
				break;
			case "/new":
				chatId = newChatId();
				conversationId = null;
				print(dim(`pelanggan baru: ${chatId}`));
				break;
			case "/takeover":
				await changeControl("agent_claimed");
				break;
			case "/handback":
				await changeControl("handed_back");
				break;
			case "/status": {
				const id = requireConv();
				if (!id) break;
				const conv = await getConversation(db, id);
				if (!conv) {
					print(dim("percakapan tidak ditemukan"));
					break;
				}
				print(
					renderKv({
						id: conv.id,
						status: `${badge(conv.status)} ${conv.status}`,
						control_owner: conv.controlOwner,
						version: conv.version,
						last_inbound: conv.lastInboundAt,
					}),
				);
				break;
			}
			case "/msgs": {
				const id = requireConv();
				if (id) {
					const msgs = await listRecentMessages(db, id, n);
					print(
						renderTable(
							msgs.map((m) => ({
								dari: m.senderType,
								waktu: m.sentAt,
								isi: m.content,
							})),
						),
					);
				}
				break;
			}
			case "/runs": {
				const id = requireConv();
				if (!id) break;
				const rows = await db
					.select()
					.from(agentRuns)
					.where(eq(agentRuns.conversationId, id))
					.orderBy(desc(agentRuns.createdAt))
					.limit(n);
				print(
					renderTable(
						rows.map((r) => ({
							status: r.status,
							model: r.model,
							in: r.promptTokens,
							out: r.completionTokens,
							usd: r.costEstimate,
							ms: r.latencyMs,
							error: r.error,
							jawaban: r.response?.slice(0, 60),
						})),
					),
				);
				break;
			}
			case "/jobs": {
				const id = requireConv();
				if (!id) break;
				const rows = await db
					.select()
					.from(jobs)
					.where(eq(jobs.conversationId, id))
					.orderBy(desc(jobs.createdAt))
					.limit(n);
				print(
					renderTable(
						rows.map((j) => ({
							tipe: j.jobType,
							status: j.status,
							attempts: j.attempts,
							run_after: j.runAfter,
							error: j.lastError,
						})),
					),
				);
				break;
			}
			case "/convs": {
				const rows = await db
					.select({
						id: conversations.id,
						kontak: contacts.externalId,
						status: conversations.status,
						control_owner: conversations.controlOwner,
						diperbarui: conversations.updatedAt,
					})
					.from(conversations)
					.innerJoin(contacts, eq(contacts.id, conversations.contactId))
					.orderBy(desc(conversations.updatedAt))
					.limit(n);
				print(renderTable(rows));
				break;
			}
			default:
				print(dim(`perintah tidak dikenal: ${cmd} (lihat /help)`));
		}
		return true;
	}

	return { handle };
}

function newChatId(): string {
	return `cli-${crypto.randomUUID().slice(0, 8)}`;
}

function dim(s: string): string {
	return styleText("dim", s);
}

if (import.meta.main) await main();

async function main() {
	const fake = process.argv.includes("--fake");
	// Dengan --fake, API key tidak dibutuhkan.
	const env = fake
		? {
				...process.env,
				TICKO_LLM_API_KEY: process.env.TICKO_LLM_API_KEY || "fake",
			}
		: process.env;
	const [app, agent] = await Promise.all([
		loadAppConfig(undefined, env),
		loadAgentConfig(undefined, env),
	]).catch((e: unknown) => {
		if (e instanceof ConfigError) {
			console.error(fail(e.message));
			process.exit(1);
		}
		throw e;
	});

	const db = connect(app.database);
	const cli = createCli({
		db,
		llm: fake
			? FakeLlm.withText("Halo! Ini balasan dari FakeLlm (mode --fake).")
			: createLlmClient(agent),
		config: agent,
		systemPrompt: await readFile(`${process.cwd()}/prompts/agent.md`, "utf8"),
		print: (line) => console.log(line),
	});

	const rule = "━".repeat(Math.min(process.stdout.columns || 50, 50));
	console.log(styleText("bold", `${rule}\n  Ticko CLI\n${rule}`));
	console.log(
		renderKv({ LLM: fake ? "FakeLlm" : `${agent.provider}/${agent.model}` }),
	);
	console.log(
		`  ${styleText("yellow", "⚠ Jangan jalankan `bun run worker` bersamaan: ia bisa mengambil job CLI.")}`,
	);
	console.log();
	console.log(HELP);
	console.log();

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let closed = false;
	rl.on("close", () => {
		closed = true;
	});
	rl.setPrompt(styleText("cyan", "pelanggan › "));
	rl.prompt();
	try {
		// Iterator baris menyangga input, jadi perintah yang di-pipe tidak hilang.
		for await (const line of rl) {
			try {
				if (!(await cli.handle(line))) break;
			} catch (e) {
				console.error(fail(e instanceof Error ? e.message : String(e)));
			}
			if (!closed) rl.prompt();
		}
	} finally {
		rl.close();
		await close(db);
	}
}
