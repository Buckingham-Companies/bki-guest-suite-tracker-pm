-- Guest Suite Tracker — seed data for Beverly
-- Run once after schema.sql. Adding another property (e.g. Foundry) later is just
-- another INSERT into Properties/Units — no code changes needed anywhere else.

IF NOT EXISTS (SELECT 1 FROM Properties WHERE ShortCode = 'BEVERLY')
INSERT INTO Properties (Name, ShortCode) VALUES ('The Beverly', 'BEVERLY');
GO

DECLARE @PropertyId INT = (SELECT PropertyId FROM Properties WHERE ShortCode = 'BEVERLY');

IF NOT EXISTS (SELECT 1 FROM Units WHERE PropertyId = @PropertyId AND UnitLabel = '108')
INSERT INTO Units (PropertyId, UnitLabel) VALUES (@PropertyId, '108');

IF NOT EXISTS (SELECT 1 FROM Units WHERE PropertyId = @PropertyId AND UnitLabel = '124')
INSERT INTO Units (PropertyId, UnitLabel) VALUES (@PropertyId, '124');

IF NOT EXISTS (SELECT 1 FROM Units WHERE PropertyId = @PropertyId AND UnitLabel = '224')
INSERT INTO Units (PropertyId, UnitLabel) VALUES (@PropertyId, '224');
GO
