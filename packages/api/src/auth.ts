import type { Secret, UserId } from "@ticko/domain";
import type { User } from "@ticko/storage";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { z } from "zod";
import type { Env } from "./app";
import { toResponse } from "./error";
import { hashPassword, verifyPassword } from "./lib/password";

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 jam

export interface AuthDeps {
	sessionSecret: Secret;
	findUserByEmail: (
		email: string,
	) => Promise<(User & { passwordHash: string }) | null>;
	/** Dipanggil dengan SESSION_TTL_MS oleh pemanggil (main.ts). */
	createSession: (
		userId: UserId,
	) => Promise<{ token: string; expiresAt: Date }>;
	findSessionUser: (token: string) => Promise<User | null>;
	deleteSession: (token: string) => Promise<void>;
}

const SESSION_COOKIE = "session";

// Dibandingkan terhadap ini kalau email tidak ditemukan, supaya waktu respons
// login tidak membocorkan apakah sebuah email terdaftar.
const DUMMY_HASH = await hashPassword("bukan-password-asli-hanya-untuk-timing");

const LoginBody = z.object({ email: z.string(), password: z.string() });

export function authRoutes(deps: AuthDeps): Hono<Env> {
	const app = new Hono<Env>();

	app.post("/login", async (c) => {
		const parsed = LoginBody.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) return toResponse({ kind: "invalid_credentials" });

		const user = await deps.findUserByEmail(parsed.data.email);
		const ok = await verifyPassword(
			parsed.data.password,
			user?.passwordHash ?? DUMMY_HASH,
		);
		if (!user || !ok) return toResponse({ kind: "invalid_credentials" });

		const session = await deps.createSession(user.id);
		await setSignedCookie(
			c,
			SESSION_COOKIE,
			session.token,
			deps.sessionSecret.reveal(),
			{
				httpOnly: true,
				secure: true,
				sameSite: "Lax",
				path: "/",
				maxAge: SESSION_TTL_MS / 1000,
			},
		);
		return c.json({
			id: user.id,
			email: user.email,
			displayName: user.displayName,
			role: user.role,
		});
	});

	app.post("/logout", async (c) => {
		const token = await getSignedCookie(
			c,
			deps.sessionSecret.reveal(),
			SESSION_COOKIE,
		);
		if (token) await deps.deleteSession(token);
		deleteCookie(c, SESSION_COOKIE, { path: "/" });
		return c.body(null, 204);
	});

	return app;
}

/** Route di belakang ini boleh memakai c.get("user") tanpa cek undefined. */
export function requireAuth(deps: AuthDeps): MiddlewareHandler<Env> {
	return async (c: Context<Env>, next) => {
		const token = await getSignedCookie(
			c,
			deps.sessionSecret.reveal(),
			SESSION_COOKIE,
		);
		if (!token) return toResponse({ kind: "unauthorized" });
		const user = await deps.findSessionUser(token);
		if (!user) return toResponse({ kind: "unauthorized" });
		c.set("user", user);
		await next();
	};
}
