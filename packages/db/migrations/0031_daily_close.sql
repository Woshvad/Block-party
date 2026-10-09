CREATE TABLE "daily_closes" (
	"bell_day" date PRIMARY KEY NOT NULL,
	"pages" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
