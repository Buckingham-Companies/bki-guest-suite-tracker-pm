-- Guest Suite Tracker — seed data for Beverly
-- Run once after schema.sql. Adding another property (e.g. Foundry) later is just
-- another seed file following this pattern (see seed_portrait_midtown.sql) — no
-- app code changes needed. YardiNumber ('1271' for Beverly) is what Okta's
-- user.YardiNumber claim is matched against to grant a person access to this
-- property; see CLAUDE.md "Adding Another Property".

IF NOT EXISTS (SELECT 1 FROM Properties WHERE ShortCode = 'BEVERLY')
INSERT INTO Properties (Name, ShortCode, YardiNumber) VALUES ('The Beverly', 'BEVERLY', '1271');
GO

-- Backfills YardiNumber on a Beverly row inserted before this column existed
-- (the already-deployed database, migrated by schema.sql's ALTER TABLE).
UPDATE Properties SET YardiNumber = '1271' WHERE ShortCode = 'BEVERLY' AND YardiNumber IS NULL;
GO

DECLARE @PropertyId INT = (SELECT PropertyId FROM Properties WHERE ShortCode = 'BEVERLY');

IF NOT EXISTS (SELECT 1 FROM Units WHERE PropertyId = @PropertyId AND UnitLabel = '108')
INSERT INTO Units (PropertyId, UnitLabel) VALUES (@PropertyId, '108');

IF NOT EXISTS (SELECT 1 FROM Units WHERE PropertyId = @PropertyId AND UnitLabel = '124')
INSERT INTO Units (PropertyId, UnitLabel) VALUES (@PropertyId, '124');

IF NOT EXISTS (SELECT 1 FROM Units WHERE PropertyId = @PropertyId AND UnitLabel = '224')
INSERT INTO Units (PropertyId, UnitLabel) VALUES (@PropertyId, '224');
GO
