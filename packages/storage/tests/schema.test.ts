import { afterAll, expect, test } from "bun:test";
import {
	ControlOwner,
	ConversationStatus,
	controlOwnerFor,
	Secret,
} from "@ticko/domain";
import { close, connect } from "../src/db";
import { contacts, conversations } from "../src/schema";

const db = connect({
	url: new Secret(
		process.env.TICKO_TEST_DATABASE_URL ??
			"postgres://ticko:ticko@127.0.0.1:5432/ticko",
	),
	maxConnections: 2,
});
afterAll(() => close(db));

class Rollback extends Error {}

// Menjalankan fn dalam transaksi yang selalu di-rollback; mengembalikan
// kode error Postgres (mis. 23514 check_violation) atau null bila sukses.
async function pgErrorCode(
	fn: (
		tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	) => Promise<unknown>,
): Promise<string | null> {
	try {
		await db.transaction(async (tx) => {
			await fn(tx);
			throw new Rollback();
		});
	} catch (e) {
		if (e instanceof Rollback) return null;
		const cause = e instanceof Error ? e.cause : undefined;
		if (typeof cause === "object" && cause !== null && "code" in cause) {
			return String(cause.code);
		}
		throw e;
	}
	return null;
}

test("CHECK database sepakat dengan controlOwnerFor untuk setiap pasangan", async () => {
	for (const status of ConversationStatus.options) {
		for (const controlOwner of ControlOwner.options) {
			const code = await pgErrorCode(async (tx) => {
				const [c] = await tx
					.insert(contacts)
					.values({ channel: "telegram", externalId: "check-test" })
					.returning();
				if (!c) throw new Error("insert contact gagal");
				await tx.insert(conversations).values({
					contactId: c.id,
					channel: "telegram",
					externalConversationId: "check-test",
					status,
					controlOwner,
				});
			});
			const valid = controlOwnerFor(status) === controlOwner;
			expect({ status, controlOwner, code }).toEqual({
				status,
				controlOwner,
				code: valid ? null : "23514",
			});
		}
	}
});

test("UPDATE ke human_active dengan control_owner bot ditolak (AC-2.2)", async () => {
	const code = await pgErrorCode(async (tx) => {
		const [c] = await tx
			.insert(contacts)
			.values({ channel: "telegram", externalId: "check-update" })
			.returning();
		if (!c) throw new Error("insert contact gagal");
		const [conv] = await tx
			.insert(conversations)
			.values({
				contactId: c.id,
				channel: "telegram",
				externalConversationId: "check-update",
				status: "bot_active",
				controlOwner: "bot",
			})
			.returning();
		if (!conv) throw new Error("insert conversation gagal");
		await tx.update(conversations).set({ status: "human_active" });
	});
	expect(code).toBe("23514");
});
