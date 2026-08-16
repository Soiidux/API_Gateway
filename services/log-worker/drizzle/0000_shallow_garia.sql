CREATE TABLE "logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"service" text NOT NULL,
	"method" text,
	"path" text,
	"status" integer,
	"latency_ms" integer,
	"user_id" text,
	"ip" text,
	"message" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE INDEX "logs_ts_idx" ON "logs" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "logs_status_idx" ON "logs" USING btree ("status");