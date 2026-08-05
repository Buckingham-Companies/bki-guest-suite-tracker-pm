-- Guest Suite Tracker — reporting views (Azure SQL Database)
-- Run after schema.sql. Consumed by /api/reports/* and safe to point Power BI
-- directly at for anything the in-app Reports tab doesn't cover.

-- One row per booked night, with that night's share of the booking's total price
-- (TotalPrice / nights of stay). This is what lets a multi-night stay that crosses
-- a month boundary contribute correctly to both months instead of dumping all its
-- revenue into the check-in month.
CREATE OR ALTER VIEW vw_BookingNights AS
WITH nights AS (
    SELECT
        BookingId, UnitId, CheckIn, CheckOut, TotalPrice,
        DATEDIFF(day, CheckIn, CheckOut) AS TotalNights,
        CheckIn AS NightDate,
        1 AS NightNum
    FROM Bookings
    WHERE IsDeleted = 0
    UNION ALL
    SELECT
        BookingId, UnitId, CheckIn, CheckOut, TotalPrice, TotalNights,
        DATEADD(day, 1, NightDate),
        NightNum + 1
    FROM nights
    WHERE NightNum < TotalNights
)
SELECT
    BookingId,
    UnitId,
    NightDate,
    CAST(ISNULL(TotalPrice, 0) AS DECIMAL(10,2)) / TotalNights AS ProratedNightlyRevenue
FROM nights;
-- Note: a single stay longer than 100 nights needs the caller to add
-- OPTION (MAXRECURSION 0) to its query — guest suites are short-stay by design,
-- so this hasn't come up, but it's worth knowing if a long block booking shows up.
GO

CREATE OR ALTER VIEW vw_OccupancyByUnitMonth AS
SELECT
    u.PropertyId,
    n.UnitId,
    YEAR(n.NightDate)  AS Yr,
    MONTH(n.NightDate) AS Mo,
    COUNT(*)            AS NightsBooked,
    MAX(DAY(EOMONTH(n.NightDate))) AS DaysInMonth,
    CAST(COUNT(*) AS DECIMAL(5,2)) / MAX(DAY(EOMONTH(n.NightDate))) * 100 AS OccupancyPct
FROM vw_BookingNights n
JOIN Units u ON u.UnitId = n.UnitId
GROUP BY u.PropertyId, n.UnitId, YEAR(n.NightDate), MONTH(n.NightDate);
GO

CREATE OR ALTER VIEW vw_RevenueByUnitMonth AS
SELECT
    u.PropertyId,
    n.UnitId,
    YEAR(n.NightDate)  AS Yr,
    MONTH(n.NightDate) AS Mo,
    SUM(n.ProratedNightlyRevenue) AS Revenue
FROM vw_BookingNights n
JOIN Units u ON u.UnitId = n.UnitId
GROUP BY u.PropertyId, n.UnitId, YEAR(n.NightDate), MONTH(n.NightDate);
GO
