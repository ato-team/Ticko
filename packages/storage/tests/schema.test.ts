import { expect, test } from "bun:test";
import {
	ControlOwner,
	ConversationStatus,
	controlOwnerFor,
} from "@ticko/domain";
import { contacts, conversations } from "../src/schema";
import { pgErrorCode, type Tx, withTestDb } from "../src/testing";

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
