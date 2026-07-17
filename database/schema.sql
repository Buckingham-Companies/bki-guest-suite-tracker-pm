-- Guest Suite Tracker — core schema (Azure SQL Database)
-- Run once against a new database. Safe to re-run: every CREATE is guarded.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Properties')
CREATE TABLE Properties (
    PropertyId      INT IDENTITY(1,1) PRIMARY KEY,
    Name            NVARCHAR(100)   NOT NULL,
    ShortCode       NVARCHAR(20)    NOT NULL UNIQUE,
    CreatedAt       DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Units')
CREATE TABLE Units (
    UnitId          INT IDENTITY(1,1) PRIMARY KEY,
    PropertyId      INT             NOT NULL REFERENCES Properties(PropertyId),
    UnitLabel       NVARCHAR(20)    NOT NULL,       -- e.g. "108"
    IsActive        BIT             NOT NULL DEFAULT 1,
    CreatedAt       DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_Units_Property_Label UNIQUE (PropertyId, UnitLabel)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Bookings')
CREATE TABLE Bookings (
    BookingId       UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    UnitId          INT             NOT NULL REFERENCES Units(UnitId),
    CheckIn         DATE            NOT NULL,
    CheckOut        DATE            NOT NULL,
    TotalPrice      DECIMAL(10,2)   NULL,
    FirstName       NVARCHAR(100)   NOT NULL,
    LastName        NVARCHAR(100)   NULL,
    Email           NVARCHAR(255)   NULL,
    Phone           NVARCHAR(30)    NULL,
    BirthMonth      NVARCHAR(20)    NULL,           -- month name only, per Katie's 25+ policy — no full DOB collected
    BirthYear       SMALLINT        NULL,
    IsDeleted       BIT             NOT NULL DEFAULT 0,
    CreatedBy       NVARCHAR(255)   NOT NULL,        -- Okta email/sub of the person who created it
    CreatedAt       DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME(),
    ModifiedBy      NVARCHAR(255)   NULL,
    ModifiedAt      DATETIME2       NULL,
    CONSTRAINT CK_Bookings_Dates CHECK (CheckOut > CheckIn)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Bookings_Unit_Dates')
CREATE INDEX IX_Bookings_Unit_Dates ON Bookings (UnitId, CheckIn, CheckOut) WHERE IsDeleted = 0;
GO

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Rates')
CREATE TABLE Rates (
    RateId          INT IDENTITY(1,1) PRIMARY KEY,
    UnitId          INT             NOT NULL REFERENCES Units(UnitId),
    RateDate        DATE            NOT NULL,
    NightlyRate     DECIMAL(10,2)   NOT NULL CHECK (NightlyRate >= 0),
    CreatedBy       NVARCHAR(255)   NOT NULL,
    CreatedAt       DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_Rates_Unit_Date UNIQUE (UnitId, RateDate)
);
GO

-- Every insert/update/delete against Bookings or Rates writes one row here from the
-- API layer (same request, same transaction). This is the change-history mechanism —
-- there are no application-level "versions" beyond what's reconstructable from this log.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'AuditLog')
CREATE TABLE AuditLog (
    AuditId         BIGINT IDENTITY(1,1) PRIMARY KEY,
    EntityType      NVARCHAR(20)    NOT NULL,       -- 'Booking' | 'Rate'
    EntityId        NVARCHAR(50)    NOT NULL,       -- BookingId (guid) or RateId (int), as string
    Action          NVARCHAR(10)    NOT NULL,       -- 'Insert' | 'Update' | 'Delete'
    ChangedBy       NVARCHAR(255)   NOT NULL,
    ChangedAt       DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME(),
    OldValues       NVARCHAR(MAX)   NULL,           -- JSON snapshot before the change
    NewValues       NVARCHAR(MAX)   NULL            -- JSON snapshot after the change
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_AuditLog_Entity')
CREATE INDEX IX_AuditLog_Entity ON AuditLog (EntityType, EntityId, ChangedAt);
GO
