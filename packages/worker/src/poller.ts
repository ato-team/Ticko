import { assertNever } from "@ticko/domain";
import type { Db } from "@ticko/storage";
import type { Logger } from "@ticko/storage/log";
import type { JobType } from "./jobs";
import {
	type ClaimedJob,
	cancel,
	claim,
	complete,
	fail,
	recoverStale,
} from "./queue";

// SATU-SATUNYA file di workspace yang boleh memakai setInterval/setTimeout
// (CONVENTIONS §5). Interval ini hanya "bangunkan dan cek tabel jobs"; tidak
// ada state timer yang hidup di memori — restart tidak menghilangkan apa pun.

export type JobOutcome =
	| { status: "done" }
	| { status: "cancelled"; reason: string };

export type Handlers = {
	[T in JobType]: (
		job: Extract<ClaimedJob, { type: T }>,
		log: Logger,
	) => Promise<JobOutcome>;
};

export function startPoller(opts: {
	db: Db;
	workerId: string;
	handlers: Handlers;
	log: Logger;
	intervalMs?: number;
}): { stop: () => Promise<void> } {
	const { db, workerId, handlers, log } = opts;
	let inFlight: Promise<void> | null = null;
	let stopping = false;
	let ticks = 0;

	const tick = async () => {
		// Pemulihan lock basi cukup sesekali, tidak setiap tick.
		if (ticks++ % 60 === 0) {
			const recovered = await recoverStale(db);
			if (recovered > 0)
				log.warn({ recovered }, "job dengan lock basi dikembalikan");
		}
		while (!stopping) {
			const job = await claim(db, workerId);
			if (!job) return;
			await runJob(db, job, handlers, log);
		}
	};

	const timer = setInterval(() => {
		if (inFlight || stopping) return;
		inFlight = tick()
			.catch((err: unknown) => log.error({ err }, "poller gagal"))
			.finally(() => {
				inFlight = null;
			});
	}, opts.intervalMs ?? 500);

	return {
		stop: async () => {
			stopping = true;
			clearInterval(timer);
			await inFlight;
		},
	};
}

export async function runJob(
	db: Db,
	job: ClaimedJob,
	handlers: Handlers,
	parentLog: Logger,
): Promise<void> {
	const log = parentLog.child({
		trace_id: job.payload.traceId,
		job_id: job.id,
		job_type: job.type,
	});
	try {
		const outcome = await dispatchHandler(job, handlers, log);
		if (outcome.status === "done") {
			await complete(db, job.id);
		} else {
			await cancel(db, job.id, outcome.reason);
			log.info({ reason: outcome.reason }, "job dibatalkan");
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.warn(
			{ err, attempts: job.attempts + 1 },
			"job gagal, dijadwalkan ulang",
		);
		await fail(db, job.id, message);
	}
}

function dispatchHandler(
	job: ClaimedJob,
	handlers: Handlers,
	log: Logger,
): Promise<JobOutcome> {
	switch (job.type) {
		case "send_message":
			return handlers.send_message(job, log);
		case "agent_run":
			return handlers.agent_run(job, log);
		default:
			return assertNever(job);
	}
}
