import { describe, expect, test } from "bun:test";
import { ConversationStatus } from "../src/entity";
import {
	type ConversationEvent,
	controlOwnerFor,
	transition,
} from "../src/state";

const ok = (
	from: ConversationStatus,
	event: ConversationEvent,
	status: ConversationStatus,
) =>
	test(`${from} --${event}--> ${status}`, () => {
		expect(transition(from, event)).toEqual({
			ok: true,
			status,
			controlOwner: controlOwnerFor(status),
		});
	});

const rejected = (from: ConversationStatus, event: ConversationEvent) =>
	test(`${from} --${event}--> ditolak`, () => {
		expect(transition(from, event)).toEqual({
			ok: false,
			error: { kind: "invalid_transition", from, event },
		});
	});

describe("transisi sah", () => {
	ok("new", "message_received", "bot_active");
	ok("bot_active", "message_received", "bot_active");
	ok("bot_active", "handoff_requested", "handoff_requested");
	ok("bot_active", "agent_claimed", "human_active");
	ok("bot_active", "resolved", "resolved");
	ok("handoff_requested", "message_received", "handoff_requested");
	ok("handoff_requested", "agent_claimed", "human_active");
	ok("handoff_requested", "handoff_timed_out", "resolved");
	ok("human_active", "message_received", "human_active");
	ok("human_active", "handed_back", "bot_active");
	ok("human_active", "resolved", "resolved");
	ok("resolved", "message_received", "bot_active");
	ok("resolved", "inactivity_timeout", "closed");
});

describe("transisi ditolak", () => {
	test("tidak ada transisi yang kembali ke new (AC-2.2)", () => {
		const events: ConversationEvent[] = [
			"message_received",
			"handoff_requested",
			"agent_claimed",
			"handed_back",
			"resolved",
			"handoff_timed_out",
			"inactivity_timeout",
		];
		const toNew = ConversationStatus.options.flatMap((from) =>
			events.filter((e) => {
				const r = transition(from, e);
				return r.ok && r.status === "new";
			}),
		);
		expect(toNew).toEqual([]);
	});
	rejected("handoff_requested", "handed_back");
	rejected("human_active", "handoff_requested");
	rejected("new", "agent_claimed");
	rejected("closed", "message_received");
	rejected("resolved", "handed_back");
});

test("handoff: saat bukan bot_active, control_owner bukan bot", () => {
	for (const s of ConversationStatus.options) {
		expect(controlOwnerFor(s) === "bot").toBe(s === "bot_active");
	}
	expect(controlOwnerFor("human_active")).toBe("human");
});
