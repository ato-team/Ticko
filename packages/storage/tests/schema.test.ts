import { expect, test } from "bun:test";
import {
	CONVERSATION_EVENTS,
	ControlOwner,
	ConversationStatus,
	controlOwnerFor,
	transition,
} from "@ticko/domain";
import { eq } from "drizzle-orm";
import type { Tx } from "../src/db";
import { contacts, conversations } from "../src/schema";
import { pgErrorCode, withTestDb } from "../src/testing";

// true bila state.ts (allowedFrom, lewat transition()) punya event yang
// membawa `from` ke `to`. Dipakai untuk mencocokkan trigger DB dengan domain.
function reachable(from: ConversationStatus, to: ConversationStatus): boolean {
	return CONVERSATION_EVENTS.some((event) => {
		const r = transition(from, event);
		return r.ok && r.status === to;
	});
}

async function insertConversation(
	tx: Tx,
	values: Pick<typeof conversations.$inferInsert, "status" | "controlOwner">,
) {
	const [c] = await tx
		.insert(contacts)
		.values({ channel: "telegram", externalId: crypto.randomUUID() })
		.returning();
	if (!c) throw new Error("insert contact gagal");
	const [conv] = await tx
		.insert(conversations)
		.values({
			contactId: c.id,
			channel: "telegram",
			externalConversationId: "42",
			...values,
		})
		.returning();
	if (!conv) throw new Error("insert conversation gagal");
	return conv;
}

// Satu SAVEPOINT per percobaan supaya error tidak membatalkan transaksi luar.
async function codeOf(tx: Tx, fn: (tx: Tx) => Promise<unknown>) {
	try {
		await tx.transaction(fn);
		return null;
	} catch (e) {
		const code = pgErrorCode(e);
		if (code === null) throw e;
		return code;
	}
}

test("CHECK database sepakat dengan controlOwnerFor untuk setiap pasangan", async () => {
	const results = await withTestDb(async (tx) => {
		const out = [];
		for (const status of ConversationStatus.options) {
			for (const controlOwner of ControlOwner.options) {
				const code = await codeOf(tx, (sp) =>
					insertConversation(sp, { status, controlOwner }),
				);
				out.push({ status, controlOwner, rejected: code === "23514" });
			}
		}
		return out;
	});
	expect(results).toHaveLength(18);
	for (const r of results) {
		expect(r).toEqual({
			...r,
			rejected: controlOwnerFor(r.status) !== r.controlOwner,
		});
	}
});

test("UPDATE ke human_active dengan control_owner bot ditolak (AC-2.2)", async () => {
	const code = await withTestDb(async (tx) => {
		await insertConversation(tx, { status: "bot_active", controlOwner: "bot" });
		return codeOf(tx, (sp) =>
			sp.update(conversations).set({ status: "human_active" }),
		);
	});
	expect(code).toBe("23514");
});

// Trigger conversations_status_transition_trigger (0004) adalah lapis kedua:
// setiap pasangan status diuji dengan control_owner target yang SUDAH benar,
// supaya penolakan yang tertangkap murni dari bentuk transisinya, bukan dari
// CHECK status/control_owner di atas.
test("trigger DB menolak transisi yang tidak ada di transition() (AC-2.2)", async () => {
	const results = await withTestDb(async (tx) => {
		const out: {
			from: ConversationStatus;
			to: ConversationStatus;
			rejected: boolean;
		}[] = [];
		for (const from of ConversationStatus.options) {
			for (const to of ConversationStatus.options) {
				if (from === to) continue;
				const code = await codeOf(tx, async (sp) => {
					const conv = await insertConversation(sp, {
						status: from,
						controlOwner: controlOwnerFor(from),
					});
					await sp
						.update(conversations)
						.set({ status: to, controlOwner: controlOwnerFor(to) })
						.where(eq(conversations.id, conv.id));
				});
				out.push({ from, to, rejected: code !== null });
			}
		}
		return out;
	});
	expect(results).toHaveLength(30);
	for (const r of results) {
		expect(r.rejected).toBe(!reachable(r.from, r.to));
	}
});

test("human_active -> new ditolak trigger DB (AC-2.2)", async () => {
	const code = await withTestDb(async (tx) => {
		const conv = await insertConversation(tx, {
			status: "human_active",
			controlOwner: "human",
		});
		return codeOf(tx, (sp) =>
			sp
				.update(conversations)
				.set({ status: "new", controlOwner: "none" })
				.where(eq(conversations.id, conv.id)),
		);
	});
	expect(code).toBe("23514");
});
