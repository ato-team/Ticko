CREATE TABLE "dead_letter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "channel" NOT NULL,
	"payload" text NOT NULL,
	"error" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "dead_letter_created_at_idx" ON "dead_letter" USING btree ("created_at");