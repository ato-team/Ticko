CREATE TABLE "conversation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"from_status" "conversation_status" NOT NULL,
	"to_status" "conversation_status" NOT NULL,
	"trigger" text NOT NULL,
	"triggered_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_triggered_by_user_id_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_events_conversation_id_idx" ON "conversation_events" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_events_triggered_by_user_id_idx" ON "conversation_events" USING btree ("triggered_by_user_id");