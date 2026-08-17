CREATE TABLE "knowledge_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"from_id" text NOT NULL,
	"to_id" text NOT NULL,
	"relation" text DEFAULT 'related to' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_edges_unique" UNIQUE("from_id","to_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"title" text NOT NULL,
	"kind" text DEFAULT 'fact' NOT NULL,
	"body" text NOT NULL,
	"confidence" numeric(3, 2) DEFAULT '0.5' NOT NULL,
	"mentions" integer DEFAULT 1 NOT NULL,
	"source_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_nodes_title_unique" UNIQUE("agent_id","title")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD COLUMN "consolidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_from_id_knowledge_nodes_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."knowledge_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_to_id_knowledge_nodes_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."knowledge_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_nodes" ADD CONSTRAINT "knowledge_nodes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_nodes" ADD CONSTRAINT "knowledge_nodes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_edges_from_idx" ON "knowledge_edges" USING btree ("from_id");--> statement-breakpoint
CREATE INDEX "knowledge_edges_to_idx" ON "knowledge_edges" USING btree ("to_id");--> statement-breakpoint
CREATE INDEX "knowledge_nodes_agent_idx" ON "knowledge_nodes" USING btree ("workspace_id","agent_id","updated_at");