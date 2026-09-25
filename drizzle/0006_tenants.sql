-- Tenants, platform staff, phone ownership, an append-only audit log and a
-- shared sign-in throttle (docs/tenants.md). Hand-written: drizzle-kit would
-- emit ALTER TYPE ... ADD VALUE, whose new value cannot be used inside the
-- single transaction the migrator runs in.
--
-- Backfill: the deployment becomes tenant "beloura" (a fixed id, which the
-- new tenant_id columns default to). Every existing schedule, execution, asset,
-- group and operator is assigned to it, and a phone with no auth.tenant_devices
-- row belongs to it, so the current farm keeps working unchanged.
--
-- Roles: every existing ADMIN BECOMES PLATFORM (Beloura staff, no tenant).
-- Tenant admins are new and are created by platform users afterwards.
CREATE TYPE "auth"."tenant_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "auth"."tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" "auth"."tenant_status" DEFAULT 'active' NOT NULL,
	"quotas" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_slug_format" CHECK ("auth"."tenants"."slug" ~ '^[a-z0-9][a-z0-9-]{1,39}$')
);
--> statement-breakpoint
INSERT INTO "auth"."tenants" ("id", "slug", "name") VALUES ('00000000-0000-0000-0000-000000000001', 'beloura', 'Beloura') ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Roles: recreate the enum (see the header) and map admin -> platform explicitly.
ALTER TYPE "auth"."user_role" RENAME TO "user_role_pre_tenants";--> statement-breakpoint
CREATE TYPE "auth"."user_role" AS ENUM('platform', 'admin', 'operator');--> statement-breakpoint
ALTER TABLE "auth"."users" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "auth"."users" ALTER COLUMN "role" TYPE "auth"."user_role"
	USING (CASE WHEN "role"::text = 'admin' THEN 'platform' ELSE "role"::text END)::"auth"."user_role";--> statement-breakpoint
ALTER TABLE "auth"."users" ALTER COLUMN "role" SET DEFAULT 'operator';--> statement-breakpoint
DROP TYPE "auth"."user_role_pre_tenants";--> statement-breakpoint

-- Users: operators join the default tenant; platform staff belong to none.
ALTER TABLE "auth"."users" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;--> statement-breakpoint
UPDATE "auth"."users" SET "tenant_id" = NULL WHERE "role" = 'platform';--> statement-breakpoint
ALTER TABLE "auth"."users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "auth"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."users" ADD CONSTRAINT "users_tenant_matches_role" CHECK (("auth"."users"."role" = 'platform') = ("auth"."users"."tenant_id" is null));--> statement-breakpoint
CREATE INDEX "users_tenant_idx" ON "auth"."users" USING btree ("tenant_id");--> statement-breakpoint

-- Groups: names are unique within a tenant, not across the farm.
ALTER TABLE "auth"."groups" DROP CONSTRAINT "groups_name_unique";--> statement-breakpoint
ALTER TABLE "auth"."groups" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "auth"."groups" ADD CONSTRAINT "groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "auth"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "groups_tenant_name_idx" ON "auth"."groups" USING btree ("tenant_id","name");--> statement-breakpoint

-- Phones: an explicit owner per UDID; no row means the default tenant.
CREATE TABLE "auth"."tenant_devices" (
	"udid" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."tenant_devices" ADD CONSTRAINT "tenant_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "auth"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_devices_tenant_idx" ON "auth"."tenant_devices" USING btree ("tenant_id");--> statement-breakpoint

-- Scheduler rows: adding the column with its default assigns every existing row to the default tenant.
ALTER TABLE "scheduler"."schedules" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduler"."executions" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduler"."assets" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduler"."assets" ADD COLUMN "uploaded_by" uuid;--> statement-breakpoint
ALTER TABLE "scheduler"."schedules" ADD CONSTRAINT "schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "auth"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler"."executions" ADD CONSTRAINT "executions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "auth"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler"."assets" ADD CONSTRAINT "assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "auth"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler"."assets" ADD CONSTRAINT "assets_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedules_tenant_idx" ON "scheduler"."schedules" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "executions_tenant_idx" ON "scheduler"."executions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "assets_tenant_idx" ON "scheduler"."assets" USING btree ("tenant_id");--> statement-breakpoint

-- Audit log: append-only. UPDATE and TRUNCATE are always refused; DELETE only
-- for rows older than 30 days, which is what retention pruning needs. No
-- foreign keys, so rows outlive the users and tenants they name.
CREATE TABLE "auth"."audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "auth"."audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	"actor_user_id" uuid,
	"actor_role" text,
	"ip" text,
	"method" text,
	"route" text,
	"event" text DEFAULT 'http' NOT NULL,
	"target_udid" text,
	"target_ids" jsonb,
	"status" integer,
	"request_id" text,
	"detail" text
);
--> statement-breakpoint
CREATE INDEX "audit_log_tenant_idx" ON "auth"."audit_log" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "auth"."audit_log" USING btree ("at");--> statement-breakpoint
CREATE FUNCTION "auth"."audit_log_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD."at" < now() - interval '30 days' THEN
			RETURN OLD;
		END IF;
	END IF;
	RAISE EXCEPTION 'auth.audit_log is append-only: % refused', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_log_append_only" BEFORE UPDATE OR DELETE ON "auth"."audit_log" FOR EACH ROW EXECUTE FUNCTION "auth"."audit_log_append_only"();--> statement-breakpoint
CREATE TRIGGER "audit_log_no_truncate" BEFORE TRUNCATE ON "auth"."audit_log" FOR EACH STATEMENT EXECUTE FUNCTION "auth"."audit_log_append_only"();--> statement-breakpoint
-- A deployment that runs the app as a separate, non-owner role named
-- phone_farm_app gets the stronger guarantee: no UPDATE/DELETE/TRUNCATE at all.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'phone_farm_app') THEN
		REVOKE UPDATE, DELETE, TRUNCATE ON "auth"."audit_log" FROM phone_farm_app;
	END IF;
END;
$$;--> statement-breakpoint

-- Sign-in throttle shared by every web replica (src/auth/throttle.ts).
CREATE TABLE "auth"."login_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer NOT NULL,
	"last_failure_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "login_throttle_last_failure_idx" ON "auth"."login_throttle" USING btree ("last_failure_at");
