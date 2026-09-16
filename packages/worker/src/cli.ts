import type { LlmClient } from "@ticko/agent";
import { fromAdapters } from "@ticko/channels";
import {
	type ChannelAdapter,
	type ConversationEvent,
	type ConversationId,
	type SentMessage,
	transition,
} from "@ticko/domain";
import {
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
// diganti: balasan ditampilkan di terminal, tidak dikirim ke Telegram.
// Modul ini tidak tahu cara menggambar: ia memancarkan Entry, UI di ./ui.

const { agentRuns, conversations, contacts, jobs } = schema;

export const COMMANDS = [
	{ name: "/new", group: "Percakapan", desc: "mulai pelanggan baru" },
	{
		name: "/takeover",
		group: "Percakapan",
		desc: "manusia ambil alih (bot diam)",
	},
	{ name: "/handback", group: "Percakapan", desc: "kembalikan kontrol ke bot" },
	{ name: "/status", group: "Inspeksi", desc: "detail percakapan aktif" },
	{ name: "/msgs", group: "Inspeksi", desc: "pesan terakhir", args: "[n]" },
	{ name: "/runs", group: "Inspeksi", desc: "agent run terakhir", args: "[n]" },
	{ name: "/jobs", group: "Inspeksi", desc: "job terakhir", args: "[n]" },
	{ name: "/convs", group: "Inspeksi", desc: "semua percakapan", args: "[n]" },
	{ name: "/help", group: "Lainnya", desc: "tampilkan bantuan" },
	{ name: "/quit", group: "Lainnya", desc: "keluar" },
] as const;

export type Row = Record<string, unknown>;

export type Entry =
	| { kind: "bot" | "info" | "ok" | "fail"; text: string }
	| { kind: "table"; title: string; rows: Row[] }
	| { kind: "kv"; title: string; row: Row }
	| { kind: "help" }
	| {
			kind: "summary";
			status: string;
			controlOwner: string;
			run?: {
				ok: boolean;
				tokensIn: number;
				tokensOut: number;
				usd: string;
				secs: string;
				error: string | null;
			};
			job?: { type: string; status: string; error: string | null };
	  };

export interface CliStatus {
	chatId: string;
	status: string | null;
	controlOwner: string | null;
}

export interface CliDeps {
	db: Db;
	llm: LlmClient;
	config: AgentDeps["config"];
	systemPrompt: string;
	emit: (entry: Entry) => void;
}

/** id → 8 karakter pertama, tanggal → jam:menit:detik UTC, null → "-". Tampilan saja. */
export function formatCell(v: unknown): string {
	if (v == null) return "-";
	if (v instanceof Date) return `${v.toISOString().slice(11, 19)} UTC`;
	if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
		return `${v.slice(11, 19)} UTC`;
	}
	if (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v)) return v.slice(0, 8);
	return String(v);
}

export function createCli(deps: CliDeps) {
	const { db, emit } = deps;
	// Ringkasan per giliran sudah menampilkan kegagalan; log JSON hanya mengganggu.
	const log = createLogger("error");
	let chatId = newChatId();
	let conversationId: ConversationId | null = null;
	let seq = 0;
	let current: CliStatus = { chatId, status: null, controlOwner: null };
	const info = (text: string) => emit({ kind: "info", text });

	const terminal: ChannelAdapter = {
		channel: "telegram",
		async sendText(_to: string, text: string): Promise<SentMessage> {
			emit({ kind: "bot", text });
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
		if (r.kind === "duplicate") return info("pesan duplikat, diabaikan");
		conversationId = r.conversationId;
		if (!r.botScheduled) {
			info("dispatcher: control_owner bukan bot → tidak ada agent_run");
		}
		await drain();
		await summary(started);
	}

	/** Ringkasan giliran ini saja: run/job lama tidak ikut ditampilkan. */
	async function summary(since: Date) {
		if (!conversationId) return;
		const conv = await getConversation(db, conversationId);
		if (!conv) return;
		current = { chatId, status: conv.status, controlOwner: conv.controlOwner };
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
		const entry: Entry = {
			kind: "summary",
			status: conv.status,
			controlOwner: conv.controlOwner,
		};
		if (run && run.createdAt >= since) {
			entry.run = {
				ok: run.status === "succeeded",
				tokensIn: run.promptTokens,
				tokensOut: run.completionTokens,
				usd: String(run.costEstimate),
				secs: (run.latencyMs / 1000).toFixed(1),
				error: run.error,
			};
		}
		if (job && job.createdAt >= since && job.status !== "done") {
			entry.job = {
				type: job.jobType,
				status: job.status,
				error: job.lastError,
			};
		}
		emit(entry);
	}

	async function changeControl(event: ConversationEvent) {
		const id = requireConv();
		if (!id) return;
		const result = await db.transaction(async (tx): Promise<Entry> => {
			const conv = await getConversation(tx, id, { forUpdate: true });
			if (!conv) return { kind: "fail", text: "percakapan tidak ditemukan" };
			const next = transition(conv.status, event);
			if (!next.ok) {
				return {
					kind: "fail",
					text: `transisi ditolak: ${conv.status} --${event}-->`,
				};
			}
			await updateStatus(tx, id, next.status);
			return {
				kind: "ok",
				text: `${conv.status} → ${next.status} (control_owner=${next.controlOwner})`,
			};
		});
		// Status bar diperbarui dari DB setelah commit, bukan dari dalam transaksi.
		const conv = await getConversation(db, id);
		if (conv) {
			current = {
				chatId,
				status: conv.status,
				controlOwner: conv.controlOwner,
			};
		}
		emit(result);
	}

	function requireConv(): ConversationId | null {
		if (!conversationId) info("belum ada percakapan; kirim pesan dulu");
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
				emit({ kind: "help" });
				break;
			case "/new":
				chatId = newChatId();
				conversationId = null;
				current = { chatId, status: null, controlOwner: null };
				info(`pelanggan baru: ${chatId}`);
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
					info("percakapan tidak ditemukan");
					break;
				}
				current = {
					chatId,
					status: conv.status,
					controlOwner: conv.controlOwner,
				};
				emit({
					kind: "kv",
					title: "Status percakapan",
					row: {
						id: conv.id,
						status: conv.status,
						control_owner: conv.controlOwner,
						version: conv.version,
						last_inbound: conv.lastInboundAt,
					},
				});
				break;
			}
			case "/msgs": {
				const id = requireConv();
				if (!id) break;
				const msgs = await listRecentMessages(db, id, n);
				emit({
					kind: "table",
					title: "Pesan",
					rows: msgs.map((m) => ({
						dari: m.senderType,
						waktu: m.sentAt,
						isi: m.content,
					})),
				});
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
				emit({
					kind: "table",
					title: "Agent run",
					rows: rows.map((r) => ({
						status: r.status,
						model: r.model,
						in: r.promptTokens,
						out: r.completionTokens,
						usd: r.costEstimate,
						ms: r.latencyMs,
						error: r.error,
						jawaban: r.response?.slice(0, 60),
					})),
				});
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
				emit({
					kind: "table",
					title: "Job",
					rows: rows.map((j) => ({
						tipe: j.jobType,
						status: j.status,
						attempts: j.attempts,
						run_after: j.runAfter,
						error: j.lastError,
					})),
				});
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
				emit({ kind: "table", title: "Percakapan", rows });
				break;
			}
			default:
				emit({
					kind: "fail",
					text: `perintah tidak dikenal: ${cmd} (lihat /help)`,
				});
		}
		return true;
	}

	return { handle, status: () => current };
}

export type Cli = ReturnType<typeof createCli>;

function newChatId(): string {
	return `cli-${crypto.randomUUID().slice(0, 8)}`;
}
