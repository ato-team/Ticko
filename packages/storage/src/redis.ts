import type { Secret } from "@ticko/domain";
import Redis from "ioredis";

export function connectRedis(url: Secret): Redis {
	return new Redis(url.reveal(), {
		lazyConnect: true,
		connectTimeout: 3000,
		commandTimeout: 3000,
		maxRetriesPerRequest: 1,
	});
}

export type RedisPingResult =
	| { ok: true }
	| { ok: false; error: { kind: "unreachable"; message: string } };

export async function pingRedis(redis: Redis): Promise<RedisPingResult> {
	try {
		await redis.ping();
		return { ok: true };
	} catch (e) {
		return {
			ok: false,
			error: {
				kind: "unreachable",
				message: e instanceof Error ? e.message : String(e),
			},
		};
	}
}
