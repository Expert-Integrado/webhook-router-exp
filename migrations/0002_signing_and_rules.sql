ALTER TABLE endpoints ADD COLUMN signing_secret TEXT;
UPDATE endpoints SET signing_secret = lower(hex(randomblob(32))) WHERE signing_secret IS NULL;
ALTER TABLE destinations ADD COLUMN filter_json TEXT;      -- NULL = sem filtro
ALTER TABLE destinations ADD COLUMN transform_json TEXT;   -- NULL = sem transformação
