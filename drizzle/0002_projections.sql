CREATE TABLE "platform"."projections" (
	"name" text PRIMARY KEY NOT NULL,
	"position" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
