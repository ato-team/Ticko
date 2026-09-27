import { expect, test } from "bun:test";
import { Secret } from "@ticko/domain";
import {
	createSession,
	createUser,
	deleteSession,
	findSessionUser,
	findUserByEmail,
	getConversationDetail,
	listInbox,
	schema,
	type Tx,
} from "@ticko/storage";
import { createLogger } from "@ticko/storage/log";
import { withTestDb } from "@ticko/storage/testing";
import { z } from "zod";
import { createApp } from "../src/app";
import { SESSION_TTL_MS } from "../src/auth";
import { hashPassword } from "../src/lib/password";

function appFor(tx: Tx) {
	return createApp({
		log: createLogger("error"),
		checkDatabase: async () => ({ ok: true }),
		checkRedis: async () => ({ ok: true }),
		webhooks: null,
		auth: {
			sessionSecret: new Secret("test-session-secret"),
			findUserByEmail: (email) => findUserByEmail(tx, email),
			createSession: (userId) =>
				createSession(tx, { userId, ttlMs: SESSION_TTL_MS }),
			findSessionUser: (token) => findSessionUser(tx, token),
			deleteSession: (token) => deleteSession(tx, token),
		},
		conversations: {
			list: (filter) => listInbox(tx, filter),
			get: (id) => getConversationDetail(tx, id),
		},
	});
}

async function loggedIn(tx: Tx) {
	await createUser(tx, {
		email: "agent@ticko.test",
		passwordHash: await hashPassword("rahasia123"),
		displayName: "Agent",
		role: "agent",
	});
	const app = appFor(tx);
	const res = await app.request("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email: "agent@ticko.test", password: "rahasia123" }),
	});
	const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
	const get = (path: string) => app.request(path, { headers: { cookie } });
	return { app, get };
}

let seq = 0;
async function seed(
	tx: Tx,
	name: string,
	status: "new" | "bot_active" | "closed",
	inboundMinutesAgo: number,
	texts: string[],
) {
	const [contact] = await tx
		.insert(schema.contacts)
		.values({ channel: "telegram", externalId: `c${++seq}`, displayName: name })
		.returning();
	const at = new Date(Date.now() - inboundMinutesAgo * 60_000);
	const [conv] = await tx
		.insert(schema.conversations)
		.values({
			contactId: contact?.id ?? "",
			channel: "telegram",
			externalConversationId: `chat${seq}`,
			status,
			controlOwner: status === "bot_active" ? "bot" : "none",
			lastInboundAt: at,
		})
		.returning();
	for (const [i, content] of texts.entries()) {
		await tx.insert(schema.messages).values({
			conversationId: conv?.id ?? "",
			senderType: i % 2 === 0 ? "contact" : "bot",
			content,
			sentAt: new Date(at.getTime() + i * 1000),
		});
	}
	return conv?.id ?? "";
}

const ErrorBody = z.object({ error: z.object({ code: z.string() }) });
const errorOf = async (res: Response) =>
	ErrorBody.parse(await res.json()).error.code;

test("tanpa session → 401 UNAUTHORIZED dengan format error seragam", async () => {
	await withTestDb(async (tx) => {
		const res = await appFor(tx).request("/api/conversations");
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({
			error: { code: "UNAUTHORIZED", message: "Silakan login" },
		});
	});
});

test("daftar: tanpa closed, paling lama menunggu di atas, pesan terakhir, pagination", async () => {
	await withTestDb(async (tx) => {
		const { get } = await loggedIn(tx);
		const baru = await seed(tx, "Baru", "new", 5, ["halo"]);
		const lama = await seed(tx, "Lama", "bot_active", 30, ["tanya", "dijawab"]);
		await seed(tx, "Selesai", "closed", 60, ["makasih"]);

		const res = await get("/api/conversations");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ page: 1, pageSize: 20, total: 2 });
		expect(body.items.map((i: { id: string }) => i.id)).toEqual([lama, baru]);
		expect(body.items[0]).toMatchObject({
			contactName: "Lama",
			channel: "telegram",
			status: "bot_active",
			controlOwner: "bot",
			lastMessage: { senderType: "bot", content: "dijawab" },
		});
		expect(body.items[0].lastInboundAt).toEndWith("Z");

		const p2 = await (await get("/api/conversations?page=2&pageSize=1")).json();
		expect(p2).toMatchObject({ page: 2, pageSize: 1, total: 2 });
		expect(p2.items.map((i: { id: string }) => i.id)).toEqual([baru]);

		const closed = await (await get("/api/conversations?status=closed")).json();
		expect(
			closed.items.map((i: { contactName: string }) => i.contactName),
		).toEqual(["Selesai"]);
	});
});

test("query tidak sah → 400 BAD_REQUEST", async () => {
	await withTestDb(async (tx) => {
		const { get } = await loggedIn(tx);
		for (const q of ["status=arsip", "page=0", "pageSize=1000"]) {
			const res = await get(`/api/conversations?${q}`);
			expect(res.status).toBe(400);
			expect(await errorOf(res)).toBe("BAD_REQUEST");
		}
	});
});

test("detail berisi riwayat pesan; id tak dikenal atau bukan UUID → 404", async () => {
	await withTestDb(async (tx) => {
		const { get } = await loggedIn(tx);
		const id = await seed(tx, "Budi", "bot_active", 2, [
			"halo",
			"hai",
			"ongkir?",
		]);

		const res = await get(`/api/conversations/${id}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ id, contactName: "Budi", version: 0 });
		expect(body.messages.map((m: { content: string }) => m.content)).toEqual([
			"halo",
			"hai",
			"ongkir?",
		]);
		expect(body.lastMessage).toMatchObject({ content: "ongkir?" });

		for (const bad of [crypto.randomUUID(), "bukan-uuid"]) {
			const r = await get(`/api/conversations/${bad}`);
			expect(r.status).toBe(404);
			expect(await errorOf(r)).toBe("NOT_FOUND");
		}
	});
});
