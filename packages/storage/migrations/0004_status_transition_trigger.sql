-- Lapis kedua Handoff Integrity untuk AC-2.2: CHECK constraint di 0000_init
-- hanya menjamin status cocok dengan control_owner, bukan bahwa transisinya
-- valid (mis. human_active -> new lolos CHECK selama control_owner ikut
-- diubah). Trigger ini menolak transisi yang tidak ada di
-- packages/domain/src/state.ts (fungsi allowedFrom). Daftar pasangan di
-- bawah WAJIB tetap sinkron dengan state.ts -- dijaga test 6x6 di
-- packages/storage/tests/schema.test.ts.
CREATE FUNCTION conversations_status_transition() RETURNS trigger AS $$
BEGIN
	IF NEW.status = OLD.status THEN
		RETURN NEW;
	END IF;

	IF (OLD.status, NEW.status) IN (
		('new', 'bot_active'),
		('bot_active', 'handoff_requested'),
		('bot_active', 'human_active'),
		('bot_active', 'resolved'),
		('handoff_requested', 'human_active'),
		('handoff_requested', 'resolved'),
		('human_active', 'bot_active'),
		('human_active', 'resolved'),
		('resolved', 'bot_active'),
		('resolved', 'closed')
	) THEN
		RETURN NEW;
	END IF;

	RAISE EXCEPTION 'transisi status tidak valid: % -> %', OLD.status, NEW.status
		USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER conversations_status_transition_trigger
	BEFORE UPDATE OF status ON conversations
	FOR EACH ROW
	EXECUTE FUNCTION conversations_status_transition();
