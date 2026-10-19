import { describe, expect, test } from "bun:test";
import { ConversationId, UserId } from "@ticko/domain";
import { InMemoryConversationRepo } from "../src/fake";
import type { Conversation } from "../src/repo";

// Unit test fake (A-0.6): listInbox/claim/handback tidak punya implementasi
// Drizzle sungguhan hari ini, jadi diuji langsung terhadap fake, bukan lewat
// fungsi kontrak bersama. Semantik yang diuji harus tetap cocok dengan yang
// dijanjikan kontrak repo (optimistic locking di claim, filter+paginasi di
// listInbox, not_assigned di handback).

function conv(overrides: Partial<Conversation> = {}): Conversation {
	return {
		id: ConversationId.parse(crypto.randomUUID()),
		contactId: crypto.randomUUID() as never,
		channel: "telegram",
		externalConversationId: crypto.randomUUID(),
		status: "handoff_requested",
		controlOwner: "none",
		version: 0,
		lastInboundAt: null,
		...overrides,
	};
}

describe("InMemoryConversationRepo.claim", () => {
	test("versi cocok → sukses, version naik, assignment tersimpan", async () => {
		const repo = new InMemoryConversationRepo();
		const c = conv();
		repo.seed([c]);
		const userId = UserId.parse(crypto.randomUUID());

		const result = await repo.claim(undefined as never, c.id, userId, 0);
		expect(result).toMatchObject({ ok: true, conversation: { version: 1 } });
	});

	test("versi tidak cocok → already_claimed", async () => {
		const repo = new InMemoryConversationRepo();
		const c = conv();
		repo.seed([c]);
		const userId = UserId.parse(crypto.randomUUID());

		const result = await repo.claim(undefined as never, c.id, userId, 5);
		expect(result).toEqual({ ok: false, reason: "already_claimed" });
	});

	test("id tidak ada → not_found", async () => {
		const repo = new InMemoryConversationRepo();
		const userId = UserId.parse(crypto.randomUUID());
		const result = await repo.claim(
			undefined as never,
			ConversationId.parse(crypto.randomUUID()),
			userId,
			0,
		);
		expect(result).toEqual({ ok: false, reason: "not_found" });
	});
});

describe("InMemoryConversationRepo.handback", () => {
	test("user yang mengklaim → sukses, assignment dilepas", async () => {
		const repo = new InMemoryConversationRepo();
		const c = conv();
		repo.seed([c]);
		const userId = UserId.parse(crypto.randomUUID());
		await repo.claim(undefined as never, c.id, userId, 0);

		const result = await repo.handback(
			undefined as never,
			c.id,
			userId,
			"selesai",
		);
		expect(result).toEqual({ ok: true });
	});

	test("user lain (atau belum diklaim) → not_assigned", async () => {
		const repo = new InMemoryConversationRepo();
		const c = conv();
		repo.seed([c]);
		const userId = UserId.parse(crypto.randomUUID());

		const result = await repo.handback(
			undefined as never,
			c.id,
			userId,
			"catatan",
		);
		expect(result).toEqual({ ok: false, reason: "not_assigned" });
	});

	test("id tidak ada → not_found", async () => {
		const repo = new InMemoryConversationRepo();
		const userId = UserId.parse(crypto.randomUUID());
		const result = await repo.handback(
			undefined as never,
			ConversationId.parse(crypto.randomUUID()),
			userId,
			"catatan",
		);
		expect(result).toEqual({ ok: false, reason: "not_found" });
	});
});

describe("InMemoryConversationRepo.listInbox", () => {
	test("filter status dan paginasi", async () => {
		const repo = new InMemoryConversationRepo();
		const items = Array.from({ length: 5 }, (_, i) =>
			conv({ status: i < 3 ? "handoff_requested" : "resolved" }),
		);
		repo.seed(items);

		const page1 = await repo.listInbox(undefined as never, {
			status: "handoff_requested",
			page: 1,
			pageSize: 2,
		});
		expect(page1).toMatchObject({ page: 1, pageSize: 2, total: 3 });
		expect(page1.items).toHaveLength(2);

		const page2 = await repo.listInbox(undefined as never, {
			status: "handoff_requested",
			page: 2,
			pageSize: 2,
		});
		expect(page2.items).toHaveLength(1);
	});

	test("filter assignedUserId hanya mengembalikan yang diklaim user itu", async () => {
		const repo = new InMemoryConversationRepo();
		const a = conv();
		const b = conv();
		repo.seed([a, b]);
		const userId = UserId.parse(crypto.randomUUID());
		await repo.claim(undefined as never, a.id, userId, 0);

		const result = await repo.listInbox(undefined as never, {
			assignedUserId: userId,
		});
		expect(result.items.map((c) => c.id)).toEqual([a.id]);
	});
});

describe("InMemoryConversationRepo.calls", () => {
	test("mencatat setiap panggilan method dengan argumennya", async () => {
		const repo = new InMemoryConversationRepo();
		const c = conv();
		repo.seed([c]);
		await repo.get(undefined as never, c.id);
		expect(repo.calls).toEqual([{ method: "get", args: [undefined, c.id] }]);
	});
});

describe("InMemoryConversationRepo.setControlOwner", () => {
	test("mengubah controlOwner langsung, melewati state machine", async () => {
		const repo = new InMemoryConversationRepo();
		const c = conv({ controlOwner: "none" });
		repo.seed([c]);
		repo.setControlOwner(c.id, "human");
		const found = await repo.get(undefined as never, c.id);
		expect(found?.controlOwner).toBe("human");
	});
});
