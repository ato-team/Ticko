import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { styleText } from "node:util";
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

const HELP = `Ketik pesan untuk mengirim sebagai pelanggan. Perintah:
  /status        percakapan aktif (status, control_owner, version)
  /msgs [n]      riwayat pesan
  /runs [n]      agent_runs percakapan ini
  /jobs [n]      jobs percakapan ini
  /convs [n]     percakapan terbaru di database
  /takeover      simulasi agent manusia mengambil alih (human_active)
  /handback      kembalikan ke bot (bot_active)
  /new           pelanggan baru
  /help, /quit`;

export interface CliDeps {
	db: Db;
	llm: LlmClient;
	config: AgentDeps["config"];
	systemPrompt: string;
	print: (line: string) => void;
	table: (rows: object[]) => void;
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
			print(`${styleText("green", "bot ›")} ${text}`);
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
		const parts = [`${conv?.status}/${conv?.controlOwner}`];
		if (run && run.createdAt >= since) {
			parts.push(
				`run ${run.status} ${run.promptTokens}+${run.completionTokens} tok $${run.costEstimate} ${run.latencyMs}ms${run.error ? ` (${run.error})` : ""}`,
			);
		}
		if (job && job.createdAt >= since && job.status !== "done") {
			parts.push(`job ${job.jobType} ${job.status}: ${job.lastError ?? "-"}`);
		}
		print(dim(parts.join(" · ")));
	}

	async function changeControl(event: ConversationEvent) {
		if (!conversationId)
			return print(dim("belum ada percakapan; kirim pesan dulu"));
		const id = conversationId;
		const result = await db.transaction(async (tx) => {
			const conv = await getConversation(tx, id, { forUpdate: true });
			if (!conv) return "percakapan tidak ditemukan";
			const next = transition(conv.status, event);
			if (!next.ok) return `transisi ditolak: ${conv.status} --${event}-->`;
			await updateStatus(tx, id, next.status);
			return `${conv.status} → ${next.status} (control_owner=${next.controlOwner})`;
		});
		print(styleText("yellow", result));
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
				if (id) deps.table([(await getConversation(db, id)) ?? {}]);
				break;
			}
			case "/msgs": {
				const id = requireConv();
				if (id) {
					const msgs = await listRecentMessages(db, id, n);
					deps.table(
						msgs.map((m) => ({
							dari: m.senderType,
							isi: m.content,
							waktu: m.sentAt,
						})),
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
				deps.table(
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
				deps.table(
					rows.map((j) => ({
						tipe: j.jobType,
						status: j.status,
						attempts: j.attempts,
						run_after: j.runAfter.toISOString(),
						error: j.lastError,
					})),
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
				deps.table(rows);
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
			console.error(e.message);
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
		table: (rows) => console.table(rows),
	});

	console.log(
		styleText(
			"bold",
			`Ticko CLI · LLM: ${fake ? "FakeLlm" : `${agent.provider}/${agent.model}`}`,
		),
	);
	console.log(
		styleText(
			"yellow",
			"Jangan jalankan `bun run worker` bersamaan: ia bisa mengambil job CLI.",
		),
	);
	console.log(HELP);

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let closed = false;
	rl.on("close", () => {
		closed = true;
	});
	rl.setPrompt(styleText("cyan", "kamu › "));
	rl.prompt();
	try {
		// Iterator baris menyangga input, jadi perintah yang di-pipe tidak hilang.
		for await (const line of rl) {
			try {
				if (!(await cli.handle(line))) break;
			} catch (e) {
				console.error(
					styleText("red", e instanceof Error ? e.message : String(e)),
				);
			}
			if (!closed) rl.prompt();
		}
	} finally {
		rl.close();
		await close(db);
	}
}
