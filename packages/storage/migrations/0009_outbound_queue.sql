CREATE TYPE "public"."outbound_queue_status" AS ENUM('pending', 'sent', 'failed', 'dead');--> statement-breakpoint
CREATE TABLE "outbound_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"recipient" text NOT NULL,
	"text" text NOT NULL,
	"status" "outbound_queue_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"external_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_queue_message_id_unique" UNIQUE("message_id"),
	CONSTRAINT "outbound_queue_sent_has_external_id_check" CHECK ("outbound_queue"."status" <> 'sent' OR "outbound_queue"."external_message_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "outbound_queue" ADD CONSTRAINT "outbound_queue_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_queue" ADD CONSTRAINT "outbound_queue_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbound_queue_conversation_id_idx" ON "outbound_queue" USING btree ("conversation_id");