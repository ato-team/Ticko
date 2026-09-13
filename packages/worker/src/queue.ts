import { assertNever, type ConversationId } from "@ticko/domain";
import { type Db, type Executor, schema } from "@ticko/storage";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { type JobPayload, JobPayloads, JobType } from "./jobs";

const { jobs } = schema;

export const STALE_LOCK_MINUTES = 5;

type EnqueueInput<T extends JobType> = {
	type: T;
	payload: JobPayload<T>;
	conversationId?: ConversationId;
	runAfter?: Date;
};

export async function enqueue<T extends JobType>(
	ex: Executor,
	input: EnqueueInput<T>,
): Promise<string> {
	const [row] = await ex
		.insert(jobs)
		.values({
			jobType: input.type,
			payload: input.payload,
			conversationId: input.conversationId ?? null,
			runAfter: input.runAfter ?? sql`now()`,
		})
		.returning({ id: jobs.id });
	return z.string().parse(row?.id);
}

/**
 * Satu job per `dedupeKey` (`{conversationId}:{timerType}`). Kalau sudah ada,
 * `run_after` dan payload ditimpa; job yang sudah selesai dihidupkan lagi.
 * Job yang sedang berjalan tidak disentuh.
 */
export async function enqueueWithDedupe<T extends JobType>(
	ex: Executor,
	input: EnqueueInput<T> & { dedupeKey: string; runAfter: Date },
): Promise<void> {
	await ex
		.insert(jobs)
		.values({
			jobType: input.type,
			payload: input.payload,
			conversationId: input.conversationId ?? null,
			runAfter: input.runAfter,
			dedupeKey: input.dedupeKey,
		})
		.onConflictDoUpdate({
			target: jobs.dedupeKey,
			set: {
				runAfter: input.runAfter,
				payload: input.payload,
				status: "pending",
				attempts: 0,
				lastError: null,
				updatedAt: sql`now()`,
			},
			setWhere: ne(jobs.status, "running"),
		});
}

export type ClaimedJob = {
	[T in JobType]: {
		id: string;
		type: T;
		payload: JobPayload<T>;
		attempts: number;
	};
}[JobType];

const ClaimedRow = z.object({
	id: z.string(),
	job_type: z.string(),
	payload: z.unknown(),
	attempts: z.number(),
});

/** Mengambil satu job yang jatuh tempo, atau null bila antrian kosong. */
export async function claim(
	db: Db,
	workerId: string,
): Promise<ClaimedJob | null> {
	for (;;) {
		// SKIP LOCKED tidak bisa diekspresikan query builder Drizzle.
		// Tanpa ini, dua worker bisa mengambil job yang sama.
		const rows = await db.execute(sql`
			UPDATE jobs SET status = 'running', locked_at = now(), locked_by = ${workerId},
				updated_at = now()
			WHERE id = (
				SELECT id FROM jobs
				WHERE status = 'pending' AND run_after <= now()
				ORDER BY run_after
				FOR UPDATE SKIP LOCKED
				LIMIT 1
			)
			RETURNING id, job_type, payload, attempts
		`);
		const [raw] = rows;
		if (raw === undefined) return null;
		const row = ClaimedRow.parse(raw);

		const job = parseJob(row);
		if (job) return job;

		// Payload tidak valid tidak akan pernah valid; jangan di-retry.
		await db
			.update(jobs)
			.set({
				status: "failed",
				lastError: `payload tidak valid untuk ${row.job_type}`,
				lockedAt: null,
				lockedBy: null,
				updatedAt: sql`now()`,
			})
			.where(eq(jobs.id, row.id));
	}
}

function parseJob(row: z.infer<typeof ClaimedRow>): ClaimedJob | null {
	const parsedType = JobType.safeParse(row.job_type);
	if (!parsedType.success) return null;
	const type = parsedType.data;
	const base = { id: row.id, attempts: row.attempts };
	switch (type) {
		case "send_message": {
			const p = JobPayloads.send_message.safeParse(row.payload);
			return p.success ? { ...base, type, payload: p.data } : null;
		}
		case "agent_run": {
			const p = JobPayloads.agent_run.safeParse(row.payload);
			return p.success ? { ...base, type, payload: p.data } : null;
		}
		default:
			return assertNever(type);
	}
}

export async function complete(ex: Executor, id: string): Promise<void> {
	await finish(ex, id, "done", null);
}

export async function cancel(
	ex: Executor,
	id: string,
	reason: string,
): Promise<void> {
	await finish(ex, id, "cancelled", reason);
}

async function finish(
	ex: Executor,
	id: string,
	status: "done" | "cancelled",
	lastError: string | null,
) {
	await ex
		.update(jobs)
		.set({
			status,
			lastError,
			lockedAt: null,
			lockedBy: null,
			updatedAt: sql`now()`,
		})
		.where(eq(jobs.id, id));
}

/**
 * Gagal ke-1, 2, 3 → dicoba lagi setelah 1, 4, 16 detik. Gagal berikutnya
 * (melewati max_attempts) → failed.
 */
export async function fail(
	ex: Executor,
	id: string,
	error: string,
): Promise<void> {
	await ex
		.update(jobs)
		.set({
			attempts: sql`${jobs.attempts} + 1`,
			status: sql`CASE WHEN ${jobs.attempts} + 1 > ${jobs.maxAttempts}
				THEN 'failed'::job_status ELSE 'pending'::job_status END`,
			runAfter: sql`now() + power(4, ${jobs.attempts}) * interval '1 second'`,
			lastError: error.slice(0, 2000),
			lockedAt: null,
			lockedBy: null,
			updatedAt: sql`now()`,
		})
		.where(eq(jobs.id, id));
}

/** Job yang worker-nya mati di tengah jalan dikembalikan ke antrian. */
export async function recoverStale(db: Db): Promise<number> {
	const rows = await db
		.update(jobs)
		.set({
			status: "pending",
			attempts: sql`${jobs.attempts} + 1`,
			lastError: "lock kedaluwarsa: worker berhenti di tengah job",
			lockedAt: null,
			lockedBy: null,
			updatedAt: sql`now()`,
		})
		.where(
			and(
				eq(jobs.status, "running"),
				sql`${jobs.lockedAt} < now() - ${STALE_LOCK_MINUTES} * interval '1 minute'`,
			),
		)
		.returning({ id: jobs.id });
	return rows.length;
}
