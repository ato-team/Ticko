import { expect, test } from "bun:test";
import { Secret } from "@ticko/domain";
import {
	createSession,
	createUser,
	deleteSession,
	findSessionUser,
	findUserByEmail,
	type Tx,
} from "@ticko/storage";
import { createLogger } from "@ticko/storage/log";
import { withTestDb } from "@ticko/storage/testing";
import { createApp } from "../src/app";
import type { AuthDeps } from "../src/auth";
import { SESSION_TTL_MS } from "../src/auth";
import { hashPassword } from "../src/lib/password";

function authDepsFor(tx: Tx): AuthDeps {
	return {
		sessionSecret: new Secret("test-session-secret"),
		findUserByEmail: (email) => findUserByEmail(tx, email),
		createSession: (userId) =>
			createSession(tx, { userId, ttlMs: SESSION_TTL_MS }),
		findSessionUser: (token) => findSessionUser(tx, token),
		deleteSession: (token) => deleteSession(tx, token),
	};
}

function appFor(tx: Tx, log = createLogger("error")) {
	return createApp({
		log,
		checkDatabase: async () => ({ ok: true }),
		checkRedis: async () => ({ ok: true }),
		webhooks: null,
		auth: authDepsFor(tx),
	});
}

function login(
	app: ReturnType<typeof appFor>,
	email: string,
	password: string,
) {
	return app.request("/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
}

function cookieFrom(res: Response): string {
	const raw = res.headers.get("set-cookie");
	if (!raw) throw new Error("respons tidak berisi set-cookie");
	return raw.split(";")[0] ?? "";
}

test("login sukses membuat session; /me mengembalikan user lewat cookie", async () => {
	await withTestDb(async (tx) => {
		await createUser(tx, {
			email: "agent@ticko.test",
			passwordHash: await hashPassword("rahasia123"),
			displayName: "Agent Satu",
			role: "agent",
		});
		const app = appFor(tx);

		const res = await login(app, "agent@ticko.test", "rahasia123");
		expect(res.status).toBe(200);
		const cookie = cookieFrom(res);

		const me = await app.request("/me", { headers: { cookie } });
		expect(me.status).toBe(200);
		expect(await me.json()).toMatchObject({
			email: "agent@ticko.test",
			displayName: "Agent Satu",
			role: "agent",
		});
	});
});

test("tanpa cookie → /me 401 UNAUTHORIZED", async () => {
	await withTestDb(async (tx) => {
		const res = await appFor(tx).request("/me");
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({
			error: { code: "UNAUTHORIZED", message: expect.any(String) },
		});
	});
});

test("logout menghapus session; /me sesudahnya 401 (AC login/logout)", async () => {
	await withTestDb(async (tx) => {
		await createUser(tx, {
			email: "logout@ticko.test",
			passwordHash: await hashPassword("rahasia123"),
			displayName: "Logout",
			role: "agent",
		});
		const app = appFor(tx);
		const cookie = cookieFrom(
			await login(app, "logout@ticko.test", "rahasia123"),
		);

		const out = await app.request("/auth/logout", {
			method: "POST",
			headers: { cookie },
		});
		expect(out.status).toBe(204);

		const me = await app.request("/me", { headers: { cookie } });
		expect(me.status).toBe(401);
	});
});

test("password salah → 401 INVALID_CREDENTIALS", async () => {
	await withTestDb(async (tx) => {
		await createUser(tx, {
			email: "salah@ticko.test",
			passwordHash: await hashPassword("benar123"),
			displayName: "Salah",
			role: "agent",
		});
		const res = await login(appFor(tx), "salah@ticko.test", "keliru");
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({
			error: { code: "INVALID_CREDENTIALS", message: expect.any(String) },
		});
	});
});

test("email tidak terdaftar → 401 INVALID_CREDENTIALS juga, bukan 404", async () => {
	await withTestDb(async (tx) => {
		const res = await login(appFor(tx), "tidak-ada@ticko.test", "apa saja");
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({
			error: { code: "INVALID_CREDENTIALS" },
		});
	});
});

test("password tidak pernah muncul di log, termasuk saat login gagal", async () => {
	await withTestDb(async (tx) => {
		await createUser(tx, {
			email: "log@ticko.test",
			passwordHash: await hashPassword("benar123"),
			displayName: "Log",
			role: "agent",
		});
		const lines: string[] = [];
		const log = createLogger("info", {
			write: (s: string) => {
				lines.push(s);
			},
		});
		const app = appFor(tx, log);

		await login(app, "log@ticko.test", "rahasia-jangan-bocor");
		await login(app, "log@ticko.test", "benar123");

		expect(lines.length).toBeGreaterThan(0);
		expect(lines.join("\n")).not.toContain("rahasia-jangan-bocor");
		expect(lines.join("\n")).not.toContain("benar123");
	});
});
