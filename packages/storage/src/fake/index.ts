import { ContactId, type ConversationId, type UserId } from "@ticko/domain";
import type { Executor } from "../db";
import type { Contact, Conversation } from "../repo/index";
import type {
	ClaimResult,
	ContactRepo,
	ConversationRepo,
	ConversationSummary,
	HandbackResult,
	InboxFilter,
	Page,
} from "../repo/types";

// Fake in-memory (A-0.6): dipakai test handler yang belum butuh Postgres
// sungguhan. `assignedUserId` BELUM ada di kolom `Conversation` sungguhan
// (menyusul migrasi Sprint 3 / B-3.1) — di sini disimpan terpisah di
// `assignments`, bukan di baris Conversation, supaya bentuk fake tetap cocok
// dengan tipe asli. Tugas B-3.1 nanti perlu menyatukan ini dengan kolom asli.

type Call = { method: string; args: unknown[] };

export class InMemoryConversationRepo implements ConversationRepo {
	private readonly conversations = new Map<ConversationId, Conversation>();
	private readonly assignments = new Map<ConversationId, UserId>();
	readonly calls: Call[] = [];

	seed(conversations: Conversation[]): void {
		for (const c of conversations) this.conversations.set(c.id, c);
	}

	setControlOwner(
		id: ConversationId,
		owner: Conversation["controlOwner"],
	): void {
		const c = this.conversations.get(id);
		if (c) this.conversations.set(id, { ...c, controlOwner: owner });
	}

	async get(ex: Executor, id: ConversationId): Promise<Conversation | null> {
		this.calls.push({ method: "get", args: [ex, id] });
		return this.conversations.get(id) ?? null;
	}

	async listInbox(
		ex: Executor,
		filter: InboxFilter,
	): Promise<Page<ConversationSummary>> {
		this.calls.push({ method: "listInbox", args: [ex, filter] });
		const page = filter.page ?? 1;
		const pageSize = filter.pageSize ?? 20;
		const all = [...this.conversations.values()]
			.filter((c) => (filter.status ? c.status === filter.status : true))
			.filter((c) =>
				filter.assignedUserId
					? this.assignments.get(c.id) === filter.assignedUserId
					: true,
			);
		const start = (page - 1) * pageSize;
		const items = all.slice(start, start + pageSize).map(
			(c): ConversationSummary => ({
				id: c.id,
				channel: c.channel,
				status: c.status,
				controlOwner: c.controlOwner,
				lastInboundAt: c.lastInboundAt,
			}),
		);
		return { items, page, pageSize, total: all.length };
	}

	async claim(
		ex: Executor,
		id: ConversationId,
		userId: UserId,
		version: number,
	): Promise<ClaimResult> {
		this.calls.push({ method: "claim", args: [ex, id, userId, version] });
		const c = this.conversations.get(id);
		if (!c) return { ok: false, reason: "not_found" };
		if (c.version !== version) return { ok: false, reason: "already_claimed" };
		const claimed: Conversation = { ...c, version: c.version + 1 };
		this.conversations.set(id, claimed);
		this.assignments.set(id, userId);
		return { ok: true, conversation: claimed };
	}

	async handback(
		ex: Executor,
		id: ConversationId,
		userId: UserId,
		note: string,
	): Promise<HandbackResult> {
		this.calls.push({ method: "handback", args: [ex, id, userId, note] });
		const c = this.conversations.get(id);
		if (!c) return { ok: false, reason: "not_found" };
		if (this.assignments.get(id) !== userId) {
			return { ok: false, reason: "not_assigned" };
		}
		this.assignments.delete(id);
		return { ok: true };
	}
}

export class InMemoryContactRepo implements ContactRepo {
	private readonly contacts: Contact[] = [];
	readonly calls: Call[] = [];

	async findOrCreateContact(
		ex: Executor,
		input: {
			channel: Contact["channel"];
			externalId: string;
			displayName: string | null;
		},
	): Promise<Contact> {
		this.calls.push({ method: "findOrCreateContact", args: [ex, input] });
		const existing = this.contacts.find(
			(c) => c.channel === input.channel && c.externalId === input.externalId,
		);
		if (existing) {
			if (input.displayName !== null) existing.displayName = input.displayName;
			return existing;
		}
		const created: Contact = {
			id: ContactId.parse(crypto.randomUUID()),
			channel: input.channel,
			externalId: input.externalId,
			displayName: input.displayName,
		};
		this.contacts.push(created);
		return created;
	}
}
