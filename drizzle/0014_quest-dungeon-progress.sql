CREATE TABLE "quests"."game_players" (
	"game_id" text NOT NULL,
	"player_id" text NOT NULL,
	CONSTRAINT "game_players_game_id_player_id_pk" PRIMARY KEY("game_id","player_id")
);
