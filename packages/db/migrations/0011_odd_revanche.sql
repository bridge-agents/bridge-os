ALTER TABLE "workspaces" ADD COLUMN "default_model" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "default_reasoning" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "allowed_paths" jsonb DEFAULT '[]'::jsonb NOT NULL;