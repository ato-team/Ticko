import { afterAll, expect, test } from "bun:test";
import { Secret } from "@ticko/domain";
import { close, connect, ping } from "../src/db";

const url =
	process.env.TICKO_TEST_DATABASE_URL ??
	"postgres://ticko:ticko@127.0.0.1:5432/ticko";

const db = connect({ url: new Secret(url), maxConnections: 2 });
afterAll(() => close(db));

test("ping ke database hidup berhasil", async () => {
	expect(await ping(db)).toEqual({ ok: true });
});

test("ping ke database mati mengembalikan error jelas, bukan melempar", async () => {
	// Port 1 tidak pernah dipakai Postgres.
	const dead = connect({
		url: new Secret("postgres://ticko:ticko@127.0.0.1:1/ticko"),
		maxConnections: 1,
	});
	const r = await ping(dead);
	expect(r.ok).toBe(false);
	if (!r.ok) {
		expect(r.error.kind).toBe("unreachable");
		expect(r.error.message.length).toBeGreaterThan(0);
	}
	await close(dead);
});
