-- Guest Suite Tracker — seed data for Portrait Midtown
-- Run once after schema.sql. Independent of seed_beverly.sql — property seed
-- files can run in any order, each is self-contained and safe to re-run.
--
-- Yardi Prop # 1264 (Property Listing export). YardiNumber is what Okta's
-- user.YardiNumber claim is matched against to grant a person access to this
-- property — see CLAUDE.md "Adding Another Property".

IF NOT EXISTS (SELECT 1 FROM Properties WHERE ShortCode = 'PORTRAIT_MIDTOWN')
INSERT INTO Properties (Name, ShortCode, YardiNumber) VALUES ('Portrait Midtown', 'PORTRAIT_MIDTOWN', '1264');
GO

DECLARE @PropertyId INT = (SELECT PropertyId FROM Properties WHERE ShortCode = 'PORTRAIT_MIDTOWN');

IF NOT EXISTS (SELECT 1 FROM Units WHERE PropertyId = @PropertyId AND UnitLabel = '301')
INSERT INTO Units (PropertyId, UnitLabel) VALUES (@PropertyId, '301');
GO

-- Nightly rates for Unit 301, Sept 1 – Dec 31 2026, from the pricing calendars
-- provided ("Reservation Tracker (Sept - Dec 2026) (september/october/november/
-- december).csv"). Expressed as contiguous same-price ranges and expanded to
-- one row per night via a generated date spine, then MERGEd so this is safe to
-- re-run (e.g. if a later month's file corrects a price).
DECLARE @UnitId INT = (
    SELECT u.UnitId FROM Units u
    JOIN Properties p ON p.PropertyId = u.PropertyId
    WHERE p.ShortCode = 'PORTRAIT_MIDTOWN' AND u.UnitLabel = '301'
);

;WITH RateRanges (StartDate, EndDate, NightlyRate) AS (
    SELECT CAST('2026-09-01' AS DATE), CAST('2026-09-04' AS DATE), 185.00
    UNION ALL SELECT '2026-09-05', '2026-09-07', 215.00
    UNION ALL SELECT '2026-09-08', '2026-10-29', 185.00
    UNION ALL SELECT '2026-10-30', '2026-11-01', 205.00
    UNION ALL SELECT '2026-11-02', '2026-11-24', 185.00
    UNION ALL SELECT '2026-11-25', '2026-11-25', 225.00
    UNION ALL SELECT '2026-11-26', '2026-11-27', 245.00
    UNION ALL SELECT '2026-11-28', '2026-11-28', 235.00
    UNION ALL SELECT '2026-11-29', '2026-11-29', 225.00
    UNION ALL SELECT '2026-11-30', '2026-12-22', 185.00
    UNION ALL SELECT '2026-12-23', '2026-12-23', 250.00
    UNION ALL SELECT '2026-12-24', '2026-12-25', 275.00
    UNION ALL SELECT '2026-12-26', '2026-12-26', 250.00
    UNION ALL SELECT '2026-12-27', '2026-12-29', 185.00
    UNION ALL SELECT '2026-12-30', '2026-12-30', 225.00
    UNION ALL SELECT '2026-12-31', '2026-12-31', 275.00
),
Numbers (n) AS (
    SELECT 0
    UNION ALL
    SELECT n + 1 FROM Numbers WHERE n < 121   -- Sept 1 to Dec 31 2026 inclusive = 122 nights
),
Nights (RateDate) AS (
    SELECT DATEADD(day, n, CAST('2026-09-01' AS DATE)) FROM Numbers
)
MERGE Rates AS target
USING (
    SELECT @UnitId AS UnitId, ni.RateDate, rr.NightlyRate
    FROM Nights ni
    JOIN RateRanges rr ON ni.RateDate BETWEEN rr.StartDate AND rr.EndDate
) AS src
ON target.UnitId = src.UnitId AND target.RateDate = src.RateDate
WHEN MATCHED THEN UPDATE SET NightlyRate = src.NightlyRate, CreatedBy = 'seed_portrait_midtown.sql', CreatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT (UnitId, RateDate, NightlyRate, CreatedBy)
    VALUES (src.UnitId, src.RateDate, src.NightlyRate, 'seed_portrait_midtown.sql')
OPTION (MAXRECURSION 200);
GO
