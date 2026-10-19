import type {
	Channel,
	ControlOwner,
	ConversationId,
	ConversationStatus,
	MessageId,
	SenderType,
} from "./entity";

// Kontrak 7: bentuk respons REST yang dibaca desk. Tinggal di domain supaya
// desk mengimpor dari sini, bukan dari api/storage. Semua waktu string ISO 8601
// UTC; konversi zona hanya saat render di browser.

export interface Page<T> {
	items: T[];
	page: number;
	pageSize: number;
	total: number;
}

export interface DeskMessage {
	id: MessageId;
	senderType: SenderType;
	content: string | null;
	sentAt: string;
}

export interface ConversationSummary {
	id: ConversationId;
	channel: Channel;
	status: ConversationStatus;
	controlOwner: ControlOwner;
	contactName: string | null;
	lastMessage: Omit<DeskMessage, "id"> | null;
	/** Pesan pelanggan terakhir — dasar "lama menunggu" di inbox. */
	lastInboundAt: string | null;
}

export interface ConversationDetail extends ConversationSummary {
	/** Dikirim balik saat claim (optimistic lock, Kontrak 3). */
	version: number;
	messages: DeskMessage[];
}
