const { app } = require('@azure/functions');
const { query } = require('../shared/db');
const { requireUser } = require('../shared/auth');
const { withErrorHandling } = require('../shared/httpHandler');

// Reads vw_OccupancyByUnitMonth / vw_RevenueByUnitMonth (database/views.sql) —
// the same views Power BI can be pointed at directly for anything deeper than
// what these two endpoints show in-app.

app.http('reportsOccupancy', {
    methods: ['GET'],
    route: 'reports/occupancy',
    authLevel: 'anonymous',
    handler: withErrorHandling(async (request, context) => {
        requireUser(request);
        const propertyId = request.query.get('propertyId');
        const year = request.query.get('year');

        const result = await query(`
            SELECT u.UnitLabel, o.UnitId, o.Yr, o.Mo, o.NightsBooked, o.DaysInMonth, o.OccupancyPct
            FROM vw_OccupancyByUnitMonth o
            JOIN Units u ON u.UnitId = o.UnitId
            WHERE (@propertyId IS NULL OR o.PropertyId = @propertyId)
              AND (@year IS NULL OR o.Yr = @year)
            ORDER BY o.Yr, o.Mo, u.UnitLabel
        `, { propertyId, year });

        return {
            jsonBody: result.recordset.map(r => ({
                unitId: r.UnitId,
                unitLabel: r.UnitLabel,
                year: r.Yr,
                month: r.Mo,
                nightsBooked: r.NightsBooked,
                daysInMonth: r.DaysInMonth,
                occupancyPct: Math.round(r.OccupancyPct * 10) / 10
            }))
        };
    })
});

app.http('reportsRevenue', {
    methods: ['GET'],
    route: 'reports/revenue',
    authLevel: 'anonymous',
    handler: withErrorHandling(async (request, context) => {
        requireUser(request);
        const propertyId = request.query.get('propertyId');
        const year = request.query.get('year');

        const result = await query(`
            SELECT u.UnitLabel, r.UnitId, r.Yr, r.Mo, r.Revenue
            FROM vw_RevenueByUnitMonth r
            JOIN Units u ON u.UnitId = r.UnitId
            WHERE (@propertyId IS NULL OR r.PropertyId = @propertyId)
              AND (@year IS NULL OR r.Yr = @year)
            ORDER BY r.Yr, r.Mo, u.UnitLabel
        `, { propertyId, year });

        return {
            jsonBody: result.recordset.map(r => ({
                unitId: r.UnitId,
                unitLabel: r.UnitLabel,
                year: r.Yr,
                month: r.Mo,
                revenue: Math.round(r.Revenue * 100) / 100
            }))
        };
    })
});

app.http('reportsUpcoming', {
    methods: ['GET'],
    route: 'reports/upcoming',
    authLevel: 'anonymous',
    handler: withErrorHandling(async (request, context) => {
        requireUser(request);
        const propertyId = request.query.get('propertyId');
        const days = Number(request.query.get('days') || 14);

        const result = await query(`
            SELECT b.BookingId, b.CheckIn, b.CheckOut, b.FirstName, b.LastName, u.UnitLabel
            FROM Bookings b
            JOIN Units u ON u.UnitId = b.UnitId
            WHERE b.IsDeleted = 0
              AND (@propertyId IS NULL OR u.PropertyId = @propertyId)
              AND (b.CheckIn BETWEEN CAST(GETUTCDATE() AS DATE) AND DATEADD(day, @days, CAST(GETUTCDATE() AS DATE))
                   OR b.CheckOut BETWEEN CAST(GETUTCDATE() AS DATE) AND DATEADD(day, @days, CAST(GETUTCDATE() AS DATE)))
            ORDER BY b.CheckIn
        `, { propertyId, days });

        return {
            jsonBody: result.recordset.map(r => ({
                bookingId: r.BookingId,
                unitLabel: r.UnitLabel,
                checkin: r.CheckIn.toISOString().slice(0, 10),
                checkout: r.CheckOut.toISOString().slice(0, 10),
                guest: [r.FirstName, r.LastName].filter(Boolean).join(' ')
            }))
        };
    })
});
