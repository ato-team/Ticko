import { assertNever } from "./assert";
import type { ControlOwner, ConversationStatus } from "./entity";

// PRD FR-2. Fungsi murni tanpa IO. CHECK constraint di database adalah lapis
// kedua: tipe ini hilang saat runtime, constraint tidak.

// Daftar tunggal supaya test bisa mengiterasi setiap event (dipakai untuk
// mencocokkan hasil transition() dengan trigger DB di 0004_status_transition_trigger.sql).
export const CONVERSATION_EVENTS = [
	"message_received", // pesan pelanggan masuk
	"handoff_requested", // bot atau aturan meminta manusia
	"agent_claimed", // agent manusia mengambil alih
	"handed_back", // agent mengembalikan ke bot
	"resolved", // masalah selesai (bot atau agent)
	"handoff_timed_out", // tidak ada agent yang mengambil
	"inactivity_timeout", // resolved tanpa aktivitas 24 jam
] as const;
export type ConversationEvent = (typeof CONVERSATION_EVENTS)[number];

export type TransitionResult =
	| { ok: true; status: ConversationStatus; controlOwner: ControlOwner }
	| {
			ok: false;
			error: {
				kind: "invalid_transition";
				from: ConversationStatus;
				event: ConversationEvent;
			};
	  };

// Satu-satunya pemetaan status → control_owner. Bot hanya boleh membalas di
// bot_active; skema database menurunkan CHECK constraint dari sini.
export function controlOwnerFor(status: ConversationStatus): ControlOwner {
	switch (status) {
		case "bot_active":
			return "bot";
		case "human_active":
			return "human";
		case "new":
		case "handoff_requested":
		case "resolved":
		case "closed":
			return "none";
		default:
			return assertNever(status);
	}
}

type Allowed = Partial<Record<ConversationEvent, ConversationStatus>>;

// Status baru tanpa entri di sini membuat typecheck gagal (AC-2.5). Event yang
// tidak tercantum untuk sebuah status sengaja ditolak.
function allowedFrom(from: ConversationStatus): Allowed {
	switch (from) {
		case "new":
			return { message_received: "bot_active" };
		case "bot_active":
			return {
				message_received: "bot_active",
				handoff_requested: "handoff_requested",
				agent_claimed: "human_active",
				resolved: "resolved",
			};
		case "handoff_requested":
			// Pesan tetap disimpan, tapi bot tidak aktif kembali.
			return {
				message_received: "handoff_requested",
				agent_claimed: "human_active",
				handoff_timed_out: "resolved",
			};
		case "human_active":
			return {
				message_received: "human_active",
				handed_back: "bot_active",
				resolved: "resolved",
			};
		case "resolved":
			// Aturan 24 jam (AC-2.3/2.4) diputuskan pemanggil sebelum mengirim
			// message_received; di sini hanya bentuk transisinya.
			return {
				message_received: "bot_active",
				inactivity_timeout: "closed",
			};
		case "closed":
			return {};
		default:
			return assertNever(from);
	}
}

export function transition(
	from: ConversationStatus,
	event: ConversationEvent,
): TransitionResult {
	const to = allowedFrom(from)[event];
	if (to === undefined) {
		return { ok: false, error: { kind: "invalid_transition", from, event } };
	}
	return { ok: true, status: to, controlOwner: controlOwnerFor(to) };
}
