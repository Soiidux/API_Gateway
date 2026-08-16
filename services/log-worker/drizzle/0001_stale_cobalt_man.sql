ALTER TABLE "logs" ADD COLUMN "request_id" text;--> statement-breakpoint
CREATE INDEX "logs_request_id_idx" ON "logs" USING btree ("request_id");