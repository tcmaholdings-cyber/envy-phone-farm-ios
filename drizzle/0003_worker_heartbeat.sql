CREATE TABLE "scheduler"."worker_heartbeats" (
	"host" text PRIMARY KEY NOT NULL,
	"pid" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"beat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queues" integer DEFAULT 0 NOT NULL
);
