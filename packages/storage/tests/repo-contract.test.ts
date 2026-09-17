import { afterAll, describe, expect, test } from "bun:test";
import { ConversationId } from "@ticko/domain";
import { InMemoryContactRepo, InMemoryConversationRepo } from "../src/fake";
import {
	findActiveOrCreate,
	findOrCreateContact,
	getConversation,
} from "../src/repo";
import type { ContactRepo } from "../src/repo/types";
import { createTestDb } from "../src/testing";

// Kontrak (A-0.6): satu fungsi test-case dijalankan untuk fake dan
// implementasi Drizzle sungguhan, tapi HANYA untuk method yang punya
// keduanya hari ini (`get` via getConversation, `findOrCreateContact`).
// `listInbox`/`claim`/`handback` belum punya implementasi Drizzle (menyusul
// Phase 1 & 3) — diuji terpisah di repo-fake.test.ts terhadap fake saja.

/** name → fungsi yang mengembalikan sepasang (get by id, seed satu percakapan → id). */
function getContract(
	name: string,
	setup: () => Promise<{
		get: (id: string) => Promise<{ id: string } | null>;
		seed: () => Promise<string>;
	}>,
) {
	describe(`ConversationRepo.get — ${name}`, () => {
		test("mengembalikan percakapan yang ada", async () => {
			const { get, seed } = await setup();
			const id = await seed();
			expect((await get(id))?.id).toBe(id);
		});

		test("null bila tidak ditemukan", async () => {
			const { get } = await setup();
			expect(await get(crypto.randomUUID())).toBeNull();
		});
	});
}

function contactContract(name: string, makeRepo: () => Promise<ContactRepo>) {
	describe(`ContactRepo.findOrCreateContact — ${name}`, () => {
		test("membuat kontak baru lalu mengembalikan yang sama untuk externalId sama", async () => {
			const repo = await makeRepo();
			const input = {
				channel: "telegram" as const,
				externalId: `contract-${name}`,
				displayName: "Budi",
			};
			const first = await repo.findOrCreateContact(undefined as never, input);
			const second = await repo.findOrCreateContact(undefined as never, {
				...input,
				displayName: null,
			});
			expect(second.id).toBe(first.id);
			expect(second.displayName).toBe("Budi");
		});
	});
}

// --- Fake -----------------------------------------------------------------

getContract("fake", async () => {
	const repo = new InMemoryConversationRepo();
	return {
		get: async (id) => repo.get(undefined as never, ConversationId.parse(id)),
		seed: async () => {
			const id = crypto.randomUUID();
			repo.seed([
				{
					id: ConversationId.parse(id),
					contactId: crypto.randomUUID() as never,
					channel: "telegram",
					externalConversationId: id,
					status: "new",
					controlOwner: "none",
					version: 0,
					lastInboundAt: null,
				},
			]);
			return id;
		},
	};
});

contactContract("fake", async () => new InMemoryContactRepo());

// --- Real (Drizzle via createTestDb) ---------------------------------------

const dbs: Array<() => Promise<void>> = [];
afterAll(() => Promise.all(dbs.map((drop) => drop())));

getContract("real (Drizzle)", async () => {
	const { db, drop } = await createTestDb();
	dbs.push(drop);
	return {
		get: async (id) => getConversation(db, ConversationId.parse(id)),
		seed: async () => {
			const contact = await findOrCreateContact(db, {
				channel: "telegram",
				externalId: crypto.randomUUID(),
				displayName: null,
			});
			const conv = await findActiveOrCreate(db, {
				contactId: contact.id,
				channel: "telegram",
				externalConversationId: crypto.randomUUID(),
			});
			return conv.id;
		},
	};
});

contactContract("real (Drizzle)", async () => {
	const { db, drop } = await createTestDb();
	dbs.push(drop);
	return {
		findOrCreateContact: (_ex, input) => findOrCreateContact(db, input),
	};
});
