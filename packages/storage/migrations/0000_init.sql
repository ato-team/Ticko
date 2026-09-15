CREATE TYPE "public"."channel" AS ENUM('telegram', 'whatsapp');--> statement-breakpoint
CREATE TYPE "public"."control_owner" AS ENUM('bot', 'human', 'none');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('new', 'bot_active', 'handoff_requested', 'human_active', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."sender_type" AS ENUM('contact', 'bot', 'human', 'system');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'agent');--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "channel" NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"external_conversation_id" text NOT NULL,
	"status" "conversation_status" DEFAULT 'new' NOT NULL,
	"control_owner" "control_owner" DEFAULT 'none' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_status_control_owner_check" CHECK (("conversations"."status" = 'bot_active' AND "conversations"."control_owner" = 'bot')
			 OR ("conversations"."status" = 'human_active' AND "conversations"."control_owner" = 'human')
			 OR ("conversations"."status" IN ('new', 'handoff_requested', 'resolved', 'closed')
			     AND "conversations"."control_owner" = 'none'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_type" "sender_type" NOT NULL,
	"sender_user_id" uuid,
	"external_message_id" text,
	"content" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_external_message_id_unique" UNIQUE("external_message_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_channel_external_id_key" ON "contacts" USING btree ("channel","external_id");--> statement-breakpoint
CREATE INDEX "conversations_status_control_owner_idx" ON "conversations" USING btree ("status","control_owner");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_one_active_per_contact" ON "conversations" USING btree ("contact_id") WHERE "conversations"."status" <> 'closed';--> statement-breakpoint
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages" USING btree ("conversation_id","created_at");