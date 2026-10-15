ALTER TABLE works ADD COLUMN "desc" TEXT NOT NULL DEFAULT '' CHECK (length("desc") <= 2000);
