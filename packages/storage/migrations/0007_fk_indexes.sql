CREATE INDEX "agent_runs_message_id_idx" ON "agent_runs" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "agent_runs_reply_message_id_idx" ON "agent_runs" USING btree ("reply_message_id");--> statement-breakpoint
CREATE INDEX "messages_sender_user_id_idx" ON "messages" USING btree ("sender_user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");