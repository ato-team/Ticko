import {
	buildContext,
	estimateCostUsd,
	isRetryable,
	type LlmClient,
	LlmFailure,
	type LlmRequest,
	type LlmResponse,
} from "@ticko/agent";
import type { AgentConfig } from "@ticko/domain";
import {
	type Db,
	type Executor,
	getConversation,
	insertAgentRun,
	insertOutbound,
	listRecentMessages,
} from "@ticko/storage";
import type { Handlers, JobOutcome } from "../poller";
import { enqueue } from "../queue";

export interface AgentDeps {
	db: Db;
	llm: LlmClient;
	config: Pick<
		AgentConfig,
		| "model"
		| "maxOutputTokens"
		| "contextMaxTokens"
		| "recentMessages"
		| "inputUsdPerMtok"
		| "outputUsdPerMtok"
	>;
	systemPrompt: string;
}

/**
 * Agent worker v1 (A-2.4): single-turn, tanpa tool.
 *
 * control_owner diperiksa dua kali di sini (lapis kedua Handoff Integrity,
 * AC-3.1): sebelum LLM dipanggil, dan lagi di bawah row lock sebelum jawaban
 * disimpan — handoff bisa terjadi selama LLM berpikir. Row lock tidak ditahan
 * selama panggilan LLM (bisa 30 detik).
 */
export function agentRunHandler(deps: AgentDeps): Handlers["agent_run"] {
	return async (job, log) => {
		const { conversationId, messageId, traceId } = job.payload;

		const conv = await getConversation(deps.db, conversationId);
		if (!conv) return cancelled("percakapan tidak ditemukan");
		if (conv.controlOwner !== "bot") {
			return cancelled(
				`control_owner=${conv.controlOwner}, LLM tidak dipanggil`,
			);
		}

		const history = await listRecentMessages(
			deps.db,
			conversationId,
			deps.config.recentMessages,
		);
		// Pelanggan mengirim beberapa pesan beruntun → hanya job untuk pesan
		// terakhir yang menjawab, sekaligus untuk semuanya.
		const lastFromContact = history.findLast((m) => m.senderType === "contact");
		if (lastFromContact && lastFromContact.id !== messageId) {
			return cancelled("digantikan pesan pelanggan yang lebih baru");
		}

		const prompt = buildContext({
			systemPrompt: deps.systemPrompt,
			history,
			contextMaxTokens: deps.config.contextMaxTokens,
			maxOutputTokens: deps.config.maxOutputTokens,
		});

		let res: LlmResponse;
		try {
			res = await deps.llm.complete(prompt);
		} catch (e) {
			if (!(e instanceof LlmFailure)) throw e;
			await recordRun(
				deps.db,
				deps.config.model,
				{ conversationId, messageId, traceId, prompt },
				{
					status: "failed",
					error: e.error.kind,
				},
			);
			if (isRetryable(e.error)) throw e;
			// ponytail: jawaban ditolak/tidak valid → bot diam. Eskalasi otomatis
			// ke manusia (request_human_handoff) menyusul di Sprint 4.
			log.warn(
				{ llm_error: e.error.kind },
				"LLM gagal permanen, tidak membalas",
			);
			return cancelled(`LLM gagal: ${e.error.kind}`);
		}

		const costEstimate = estimateCostUsd(deps.config, res);
		return deps.db.transaction(async (tx): Promise<JobOutcome> => {
			const locked = await getConversation(tx, conversationId, {
				forUpdate: true,
			});
			if (locked?.controlOwner !== "bot") {
				await recordRun(
					tx,
					deps.config.model,
					{ conversationId, messageId, traceId, prompt },
					{ status: "discarded", res, costEstimate },
				);
				return cancelled(
					"control_owner berubah selama LLM berjalan, jawaban dibuang",
				);
			}

			const replyId = await insertOutbound(tx, {
				conversationId,
				senderType: "bot",
				content: res.text,
			});
			await recordRun(
				tx,
				deps.config.model,
				{ conversationId, messageId, traceId, prompt },
				{ status: "succeeded", res, costEstimate, replyMessageId: replyId },
			);
			await enqueue(tx, {
				type: "send_message",
				conversationId,
				payload: { conversationId, text: res.text, traceId },
			});
			log.info(
				{
					input_tokens: res.inputTokens,
					output_tokens: res.outputTokens,
					latency_ms: res.latencyMs,
					cost_usd: costEstimate,
				},
				"jawaban agent dijadwalkan",
			);
			return { status: "done" };
		});
	};
}

function cancelled(reason: string): JobOutcome {
	return { status: "cancelled", reason };
}

async function recordRun(
	ex: Executor,
	configuredModel: string,
	base: {
		conversationId: string;
		messageId: string;
		traceId: string;
		prompt: LlmRequest;
	},
	outcome:
		| { status: "failed"; error: string }
		| {
				status: "succeeded" | "discarded";
				res: LlmResponse;
				costEstimate: number;
				replyMessageId?: string;
		  },
): Promise<void> {
	const common = {
		conversationId: base.conversationId,
		messageId: base.messageId,
		traceId: base.traceId,
		prompt: base.prompt,
	};
	await insertAgentRun(
		ex,
		outcome.status === "failed"
			? {
					...common,
					status: "failed",
					model: configuredModel,
					error: outcome.error,
				}
			: {
					...common,
					status: outcome.status,
					model: outcome.res.model,
					response: outcome.res.text,
					promptTokens: outcome.res.inputTokens,
					completionTokens: outcome.res.outputTokens,
					costEstimate: outcome.costEstimate,
					latencyMs: outcome.res.latencyMs,
					replyMessageId: outcome.replyMessageId ?? null,
				},
	);
}
