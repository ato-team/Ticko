import type { Secret } from "@ticko/domain";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function connect(cfg: { url: Secret; maxConnections: number }) {
	const client = postgres(cfg.url.reveal(), {
		max: cfg.maxConnections,
		connect_timeout: 5,
		onnotice: () => {},
	});
	return drizzle(client, { schema });
}

export type Db = ReturnType<typeof connect>;

export type PingResult =
	| { ok: true }
	| { ok: false; error: { kind: "timeout" | "unreachable"; message: string } };

export async function ping(db: Db, timeoutMs = 3000): Promise<PingResult> {
	const signal = AbortSignal.timeout(timeoutMs);
	const timedOut = new Promise<PingResult>((resolve) =>
		signal.addEventListener("abort", () =>
			resolve({
				ok: false,
				error: {
					kind: "timeout",
					message: `database tidak menjawab dalam ${timeoutMs} ms`,
				},
			}),
		),
	);
	const query = db.execute(sql`select 1`).then(
		(): PingResult => ({ ok: true }),
		(e: unknown): PingResult => ({
			ok: false,
			error: {
				kind: "unreachable",
				message: e instanceof Error ? e.message : String(e),
			},
		}),
	);
	return Promise.race([query, timedOut]);
}

export function close(db: Db): Promise<void> {
	return db.$client.end({ timeout: 5 });
}
