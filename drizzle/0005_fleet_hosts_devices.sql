CREATE SCHEMA "fleet";
--> statement-breakpoint
CREATE TABLE "fleet"."devices" (
	"udid" text PRIMARY KEY NOT NULL,
	"host_id" text NOT NULL,
	"name" text NOT NULL,
	"coordinate_profile" text,
	"wda_local_port" integer NOT NULL,
	"mjpeg_local_port" integer NOT NULL,
	"rack" text,
	"rack_slot" text,
	"model" text,
	"disabled" boolean DEFAULT false NOT NULL,
	"coordinates" jsonb,
	"plugin_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signing_team" text,
	"has_passcode" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_wda_port_range" CHECK ("fleet"."devices"."wda_local_port" between 1 and 65535),
	CONSTRAINT "devices_mjpeg_port_range" CHECK ("fleet"."devices"."mjpeg_local_port" between 1 and 65535)
);
--> statement-breakpoint
CREATE TABLE "fleet"."hosts" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"agent_url" text,
	"last_seen_at" timestamp with time zone,
	"version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fleet"."devices" ADD CONSTRAINT "devices_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "fleet"."hosts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_host_wda_port_idx" ON "fleet"."devices" USING btree ("host_id","wda_local_port");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_host_mjpeg_port_idx" ON "fleet"."devices" USING btree ("host_id","mjpeg_local_port");