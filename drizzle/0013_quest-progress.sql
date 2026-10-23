CREATE SCHEMA "quests";
--> statement-breakpoint
CREATE TABLE "quests"."daily_progress" (
	"player_id" text NOT NULL,
	"day" text NOT NULL,
	"quest_id" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_progress_player_id_day_quest_id_pk" PRIMARY KEY("player_id","day","quest_id")
);
