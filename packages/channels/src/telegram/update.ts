import type { Attachment, InboundMessage } from "@ticko/domain";
import { z } from "zod";

// Hanya bagian Update Bot API yang dipakai. Field lain diabaikan (bukan strict)
// karena Telegram rutin menambah field baru.
const User = z.object({
	id: z.number(),
	first_name: z.string(),
	last_name: z.string().optional(),
});

const Message = z.object({
	message_id: z.number(),
	date: z.number(),
	chat: z.object({ id: z.number() }),
	from: User.optional(),
	text: z.string().optional(),
	caption: z.string().optional(),
	photo: z.array(z.object({ file_id: z.string() })).optional(),
	document: z
		.object({ file_id: z.string(), mime_type: z.string().optional() })
		.optional(),
	audio: z
		.object({ file_id: z.string(), mime_type: z.string().optional() })
		.optional(),
	video: z
		.object({ file_id: z.string(), mime_type: z.string().optional() })
		.optional(),
	voice: z
		.object({ file_id: z.string(), mime_type: z.string().optional() })
		.optional(),
});

export const TelegramUpdate = z.object({
	update_id: z.number(),
	message: Message.optional(),
});

export type ParseUpdateResult =
	| { ok: true; message: InboundMessage }
	// Update valid tapi bukan pesan baru (edited_message, callback, dsb.).
	| { ok: true; message: null }
	| { ok: false; error: string };

export function parseUpdate(body: unknown): ParseUpdateResult {
	const parsed = TelegramUpdate.safeParse(body);
	if (!parsed.success) {
		return { ok: false, error: z.prettifyError(parsed.error) };
	}
	const m = parsed.data.message;
	if (!m) return { ok: true, message: null };

	const name = m.from
		? [m.from.first_name, m.from.last_name].filter(Boolean).join(" ")
		: null;
	return {
		ok: true,
		message: {
			channel: "telegram",
			externalConversationId: String(m.chat.id),
			// message_id hanya unik per chat.
			externalMessageId: `${m.chat.id}:${m.message_id}`,
			senderExternalId: String(m.from?.id ?? m.chat.id),
			senderDisplayName: name,
			content: { text: m.text ?? m.caption ?? null },
			attachments: attachmentsOf(m),
			sentAt: new Date(m.date * 1000).toISOString(),
		},
	};
}

function attachmentsOf(m: z.infer<typeof Message>): Attachment[] {
	const out: Attachment[] = [];
	// Telegram mengirim beberapa ukuran; elemen terakhir yang terbesar.
	const photo = m.photo?.at(-1);
	if (photo) {
		out.push({ kind: "photo", externalFileId: photo.file_id, mimeType: null });
	}
	for (const kind of ["document", "audio", "video"] as const) {
		const f = m[kind];
		if (f) {
			out.push({
				kind,
				externalFileId: f.file_id,
				mimeType: f.mime_type ?? null,
			});
		}
	}
	if (m.voice) {
		out.push({
			kind: "audio",
			externalFileId: m.voice.file_id,
			mimeType: m.voice.mime_type ?? null,
		});
	}
	return out;
}
