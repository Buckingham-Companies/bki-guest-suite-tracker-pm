#!/usr/bin/env python3
"""
Dev-only stand-in for the real Azure Static Web App + Functions + Azure SQL
stack, used to click through frontend/ without needing Node.js, Docker, or a
real SQL Server installed. Implements the same /api/* contract as api/src/functions/*.js
against a local SQLite file instead of Azure SQL, and fakes /.auth/me the way
Azure Static Web Apps would after an Okta login.

NOT deployed. NOT part of the production app. Python stdlib only (sqlite3,
http.server) so it runs on a machine with nothing else installed.

Usage:
    python mock_server.py
    -> serves the app at http://localhost:8787
    -> visit /mock/login/<profile> to switch users — see MOCK_USERS below for the
       full list (single-property admin/staff at each of Beverly and Portrait
       Midtown, plus a multi-property regional admin) to exercise the
       user.YardiNumber-based access model without needing real Okta wiring.
"""

import json
import re
import sqlite3
import uuid
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
FRONTEND_DIR = ROOT.parent / "frontend"
DB_PATH = ROOT / "dev.db"

# Mirrors what the real app derives from the user.YardiNumber and title Okta
# claims (see api/src/shared/auth.js) — a property/multi-site manager's title
# determines "admin" (rate-setting) rights, YardiNumber determines which
# properties they see at all. Covers both properties plus a multi-site user so
# the property-scoping logic (not just the admin/staff split) gets exercised
# locally, without waiting on Shane's Okta claims work.
MOCK_USERS = {
    "admin-beverly": {"email": "marliss.davis@buckingham.com", "title": "Property Manager", "yardiNumbers": ["1271"]},
    "staff-beverly": {"email": "front.desk@buckingham.com", "title": "Leasing Consultant", "yardiNumbers": ["1271"]},
    "admin-portrait": {"email": "caty.downes@buckingham.com", "title": "Property Manager", "yardiNumbers": ["1264"]},
    "staff-portrait": {"email": "portrait.frontdesk@buckingham.com", "title": "Leasing Consultant", "yardiNumbers": ["1264"]},
    "regional-admin": {"email": "laurie.mann@buckingham.com", "title": "Regional Manager", "yardiNumbers": ["1271", "1264"]},
    "no-property": {"email": "new.hire@buckingham.com", "title": "Leasing Consultant", "yardiNumbers": []},
}
CURRENT_PROFILE = {"key": "admin-beverly"}  # flips via /mock/login/<profile>

ADMIN_TITLE_KEYWORDS = ("manager", "vp", "regional", "district")


def is_admin_title(title):
    t = title.lower()
    return any(k in t for k in ADMIN_TITLE_KEYWORDS)


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# Contiguous same-price date ranges for Portrait Midtown Unit 301, Sept 1 – Dec 31
# 2026 — transcribed from the "Reservation Tracker (Sept - Dec 2026)" pricing
# calendars, same source data as database/seed_portrait_midtown.sql. Kept here too
# (rather than just seeding Beverly) so the mock server can exercise a genuinely
# second, differently-priced property.
PORTRAIT_MIDTOWN_RATE_RANGES = [
    ("2026-09-01", "2026-09-04", 185.00),
    ("2026-09-05", "2026-09-07", 215.00),
    ("2026-09-08", "2026-10-29", 185.00),
    ("2026-10-30", "2026-11-01", 205.00),
    ("2026-11-02", "2026-11-24", 185.00),
    ("2026-11-25", "2026-11-25", 225.00),
    ("2026-11-26", "2026-11-27", 245.00),
    ("2026-11-28", "2026-11-28", 235.00),
    ("2026-11-29", "2026-11-29", 225.00),
    ("2026-11-30", "2026-12-22", 185.00),
    ("2026-12-23", "2026-12-23", 250.00),
    ("2026-12-24", "2026-12-25", 275.00),
    ("2026-12-26", "2026-12-26", 250.00),
    ("2026-12-27", "2026-12-29", 185.00),
    ("2026-12-30", "2026-12-30", 225.00),
    ("2026-12-31", "2026-12-31", 275.00),
]


def init_db():
    conn = get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS Properties (
            PropertyId INTEGER PRIMARY KEY AUTOINCREMENT,
            Name TEXT NOT NULL,
            ShortCode TEXT NOT NULL UNIQUE,
            YardiNumber TEXT UNIQUE
        );
        CREATE TABLE IF NOT EXISTS Units (
            UnitId INTEGER PRIMARY KEY AUTOINCREMENT,
            PropertyId INTEGER NOT NULL REFERENCES Properties(PropertyId),
            UnitLabel TEXT NOT NULL,
            IsActive INTEGER NOT NULL DEFAULT 1,
            UNIQUE(PropertyId, UnitLabel)
        );
        CREATE TABLE IF NOT EXISTS Bookings (
            BookingId TEXT PRIMARY KEY,
            UnitId INTEGER NOT NULL REFERENCES Units(UnitId),
            CheckIn TEXT NOT NULL,
            CheckOut TEXT NOT NULL,
            TotalPrice REAL,
            FirstName TEXT NOT NULL,
            LastName TEXT,
            Email TEXT,
            Phone TEXT,
            BirthMonth TEXT,
            BirthYear INTEGER,
            IsDeleted INTEGER NOT NULL DEFAULT 0,
            CreatedBy TEXT NOT NULL,
            CreatedAt TEXT NOT NULL,
            ModifiedBy TEXT,
            ModifiedAt TEXT
        );
        CREATE TABLE IF NOT EXISTS Rates (
            RateId INTEGER PRIMARY KEY AUTOINCREMENT,
            UnitId INTEGER NOT NULL REFERENCES Units(UnitId),
            RateDate TEXT NOT NULL,
            NightlyRate REAL NOT NULL,
            CreatedBy TEXT NOT NULL,
            CreatedAt TEXT NOT NULL,
            UNIQUE(UnitId, RateDate)
        );
        CREATE TABLE IF NOT EXISTS AuditLog (
            AuditId INTEGER PRIMARY KEY AUTOINCREMENT,
            EntityType TEXT NOT NULL,
            EntityId TEXT NOT NULL,
            Action TEXT NOT NULL,
            ChangedBy TEXT NOT NULL,
            ChangedAt TEXT NOT NULL,
            OldValues TEXT,
            NewValues TEXT
        );
    """)

    # Migrates a dev.db created before YardiNumber existed (mirrors the guarded
    # ALTER TABLE in database/schema.sql for the real database).
    existing_columns = {r["name"] for r in conn.execute("PRAGMA table_info(Properties)").fetchall()}
    if "YardiNumber" not in existing_columns:
        conn.execute("ALTER TABLE Properties ADD COLUMN YardiNumber TEXT")

    def ensure_property(name, short_code, yardi_number):
        conn.execute(
            "UPDATE Properties SET YardiNumber = ? WHERE ShortCode = ? AND YardiNumber IS NULL",
            (yardi_number, short_code),
        )
        row = conn.execute("SELECT PropertyId FROM Properties WHERE ShortCode = ?", (short_code,)).fetchone()
        if row:
            return row["PropertyId"]
        conn.execute(
            "INSERT INTO Properties (Name, ShortCode, YardiNumber) VALUES (?, ?, ?)",
            (name, short_code, yardi_number),
        )
        return conn.execute("SELECT PropertyId FROM Properties WHERE ShortCode = ?", (short_code,)).fetchone()["PropertyId"]

    def ensure_unit(property_id, label):
        row = conn.execute(
            "SELECT UnitId FROM Units WHERE PropertyId = ? AND UnitLabel = ?", (property_id, label)
        ).fetchone()
        if row:
            return row["UnitId"]
        conn.execute("INSERT INTO Units (PropertyId, UnitLabel) VALUES (?, ?)", (property_id, label))
        return conn.execute(
            "SELECT UnitId FROM Units WHERE PropertyId = ? AND UnitLabel = ?", (property_id, label)
        ).fetchone()["UnitId"]

    beverly_id = ensure_property("The Beverly", "BEVERLY", "1271")
    for label in ("108", "124", "224"):
        ensure_unit(beverly_id, label)

    portrait_id = ensure_property("Portrait Midtown", "PORTRAIT_MIDTOWN", "1264")
    portrait_unit_id = ensure_unit(portrait_id, "301")
    for start, end, rate in PORTRAIT_MIDTOWN_RATE_RANGES:
        for d in daterange(date.fromisoformat(start), date.fromisoformat(end) + timedelta(days=1)):
            ds = d.isoformat()
            conn.execute(
                """
                INSERT INTO Rates (UnitId, RateDate, NightlyRate, CreatedBy, CreatedAt) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(UnitId, RateDate) DO UPDATE SET NightlyRate = excluded.NightlyRate
                """,
                (portrait_unit_id, ds, rate, "mock_server.py seed", now_iso()),
            )

    conn.commit()
    conn.close()


def now_iso():
    return datetime.utcnow().isoformat()


def record_audit(conn, entity_type, entity_id, action, changed_by, old_values=None, new_values=None):
    conn.execute(
        "INSERT INTO AuditLog (EntityType, EntityId, Action, ChangedBy, ChangedAt, OldValues, NewValues) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (entity_type, str(entity_id), action, changed_by, now_iso(),
         json.dumps(old_values) if old_values is not None else None,
         json.dumps(new_values) if new_values is not None else None),
    )


def compute_auto_price(conn, unit_id, checkin, checkout):
    rows = conn.execute(
        "SELECT NightlyRate FROM Rates WHERE UnitId=? AND RateDate>=? AND RateDate<?",
        (unit_id, checkin, checkout),
    ).fetchall()
    if not rows:
        return None
    return sum(r["NightlyRate"] for r in rows)


def booking_row_to_json(r):
    return {
        "id": r["BookingId"], "unitId": r["UnitId"], "checkin": r["CheckIn"], "checkout": r["CheckOut"],
        "price": r["TotalPrice"], "firstName": r["FirstName"], "lastName": r["LastName"], "email": r["Email"],
        "phone": r["Phone"], "birthMonth": r["BirthMonth"], "birthYear": r["BirthYear"],
        "createdBy": r["CreatedBy"], "createdAt": r["CreatedAt"], "modifiedBy": r["ModifiedBy"],
        "modifiedAt": r["ModifiedAt"],
    }


def daterange(start, end):
    cur = start
    while cur < end:
        yield cur
        cur += timedelta(days=1)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # keep console output readable during manual QA

    # ---- helpers -----------------------------------------------------
    def current_user(self):
        u = MOCK_USERS[CURRENT_PROFILE["key"]]
        return {
            "email": u["email"],
            "isAdmin": is_admin_title(u["title"]),
            "yardiNumbers": u["yardiNumbers"],   # mirrors auth.js's parsed user.YardiNumber claim
        }

    # A unit/property the current user isn't assigned to (by YardiNumber) 404s
    # rather than 403s — matches nothing in their queries the same way the real
    # API's property-scoped WHERE clauses do, so this mirrors that instead of
    # leaking whether the id exists at all.
    def property_yardi_number(self, conn, property_id):
        row = conn.execute("SELECT YardiNumber FROM Properties WHERE PropertyId = ?", (property_id,)).fetchone()
        return row["YardiNumber"] if row else None

    def unit_yardi_number(self, conn, unit_id):
        row = conn.execute(
            "SELECT p.YardiNumber FROM Units u JOIN Properties p ON p.PropertyId = u.PropertyId WHERE u.UnitId = ?",
            (unit_id,),
        ).fetchone()
        return row["YardiNumber"] if row else None

    def send_json(self, status, body):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def send_no_content(self):
        self.send_response(204)
        self.end_headers()

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length))

    def serve_static(self, path):
        if path == "/" or path == "":
            path = "/index.html"
        file_path = FRONTEND_DIR / path.lstrip("/")
        if not file_path.exists() or not file_path.is_file():
            self.send_response(404)
            self.end_headers()
            return
        content = file_path.read_bytes()
        if file_path.name == "index.html":
            content = inject_qa_widget(content)
        content_type = {
            ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
        }.get(file_path.suffix, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    # ---- routing -------------------------------------------------------
    def do_GET(self):
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)

        if path == "/.auth/me":
            u = MOCK_USERS[CURRENT_PROFILE["key"]]
            user = self.current_user()
            roles = ["authenticated"] + (["admin"] if user["isAdmin"] else [])
            # claims mirrors what the real SWA principal carries once Shane adds
            # YardiNumber/title as ID token claims (see CLAUDE.md Okta Setup) —
            # api/src/shared/auth.js reads this same shape from principal.claims.
            claims = [{"typ": "title", "val": u["title"]}]
            claims += [{"typ": "YardiNumber", "val": yn} for yn in u["yardiNumbers"]]
            self.send_json(200, {
                "clientPrincipal": {"userDetails": user["email"], "userRoles": roles, "claims": claims}
            })
            return
        if path == "/.auth/logout":
            self.send_response(302); self.send_header("Location", "/"); self.end_headers()
            return
        if path.startswith("/mock/login/"):
            profile = path.rsplit("/", 1)[-1]
            if profile in MOCK_USERS:
                CURRENT_PROFILE["key"] = profile
            self.send_response(302); self.send_header("Location", "/"); self.end_headers()
            return
        if path == "/api/properties":
            return self.handle_properties()
        if path == "/api/bookings":
            return self.handle_bookings_list(query)
        if path == "/api/rates":
            return self.handle_rates_list(query)
        if path == "/api/reports/occupancy":
            return self.handle_report_occupancy(query)
        if path == "/api/reports/revenue":
            return self.handle_report_revenue(query)
        if path == "/api/reports/upcoming":
            return self.handle_report_upcoming(query)
        m = re.match(r"^/api/audit/(Booking|Rate)/(.+)$", path)
        if m:
            return self.handle_audit(m.group(1), m.group(2))

        return self.serve_static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/bookings":
            return self.handle_bookings_create()
        if path == "/api/rates/bulk":
            return self.handle_rates_bulk_set()
        if path == "/api/rates":
            return self.handle_rates_set()
        self.send_response(404); self.end_headers()

    def do_PUT(self):
        path = urlparse(self.path).path
        m = re.match(r"^/api/bookings/(.+)$", path)
        if m:
            return self.handle_bookings_update(m.group(1))
        self.send_response(404); self.end_headers()

    def do_DELETE(self):
        path = urlparse(self.path).path
        m = re.match(r"^/api/bookings/(.+)$", path)
        if m:
            return self.handle_bookings_delete(m.group(1))
        if path == "/api/rates":
            return self.handle_rates_clear()
        self.send_response(404); self.end_headers()

    # ---- handlers -------------------------------------------------------
    def handle_properties(self):
        user = self.current_user()
        conn = get_conn()
        props = {}
        if not user["yardiNumbers"]:
            conn.close()
            return self.send_json(200, [])
        placeholders = ",".join("?" * len(user["yardiNumbers"]))
        rows = conn.execute(f"""
            SELECT p.PropertyId, p.Name, p.ShortCode, u.UnitId, u.UnitLabel
            FROM Properties p JOIN Units u ON u.PropertyId = p.PropertyId AND u.IsActive = 1
            WHERE p.YardiNumber IN ({placeholders})
            ORDER BY p.Name, u.UnitLabel
        """, user["yardiNumbers"]).fetchall()
        for r in rows:
            props.setdefault(r["PropertyId"], {
                "propertyId": r["PropertyId"], "name": r["Name"], "shortCode": r["ShortCode"], "units": []
            })["units"].append({"unitId": r["UnitId"], "unitLabel": r["UnitLabel"]})
        conn.close()
        self.send_json(200, list(props.values()))

    def handle_bookings_list(self, query):
        user = self.current_user()
        property_id = query.get("propertyId", [None])[0]
        frm = query.get("from", [None])[0]
        to = query.get("to", [None])[0]
        conn = get_conn()

        if property_id:
            if self.property_yardi_number(conn, property_id) not in user["yardiNumbers"]:
                conn.close()
                return self.send_json(403, {"error": "You do not have access to this property."})
        elif not user["yardiNumbers"]:
            conn.close()
            return self.send_json(200, [])

        sql = """
            SELECT b.* FROM Bookings b
            JOIN Units u ON u.UnitId = b.UnitId
            JOIN Properties p ON p.PropertyId = u.PropertyId
            WHERE b.IsDeleted = 0
        """
        params = []
        if property_id:
            sql += " AND u.PropertyId = ?"; params.append(property_id)
        else:
            sql += f" AND p.YardiNumber IN ({','.join('?' * len(user['yardiNumbers']))})"
            params += user["yardiNumbers"]
        if frm:
            sql += " AND b.CheckOut > ?"; params.append(frm)
        if to:
            sql += " AND b.CheckIn < ?"; params.append(to)
        sql += " ORDER BY b.CheckIn"
        rows = conn.execute(sql, params).fetchall()
        conn.close()
        self.send_json(200, [booking_row_to_json(r) for r in rows])

    def handle_bookings_create(self):
        user = self.current_user()
        body = self.read_json_body()
        required = ("unitId", "checkin", "checkout", "firstName")
        if not all(body.get(k) for k in required):
            return self.send_json(400, {"error": "unitId, checkin, checkout and firstName are required."})
        if body["checkin"] >= body["checkout"]:
            return self.send_json(400, {"error": "checkout must be after checkin."})

        conn = get_conn()
        if self.unit_yardi_number(conn, body["unitId"]) not in user["yardiNumbers"]:
            conn.close()
            return self.send_json(403, {"error": "You do not have access to this unit."})
        auto_price = compute_auto_price(conn, body["unitId"], body["checkin"], body["checkout"])
        final_price = body.get("totalPrice") if (user["isAdmin"] and body.get("totalPrice") is not None) else auto_price
        booking_id = str(uuid.uuid4())
        created_at = now_iso()
        conn.execute("""
            INSERT INTO Bookings (BookingId, UnitId, CheckIn, CheckOut, TotalPrice, FirstName, LastName,
                                   Email, Phone, BirthMonth, BirthYear, CreatedBy, CreatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (booking_id, body["unitId"], body["checkin"], body["checkout"], final_price, body["firstName"],
              body.get("lastName"), body.get("email"), body.get("phone"), body.get("birthMonth"),
              body.get("birthYear"), user["email"], created_at))
        row = conn.execute("SELECT * FROM Bookings WHERE BookingId=?", (booking_id,)).fetchone()
        record_audit(conn, "Booking", booking_id, "Insert", user["email"], new_values=booking_row_to_json(row))
        conn.commit(); conn.close()
        self.send_json(201, booking_row_to_json(row))

    def handle_bookings_update(self, booking_id):
        user = self.current_user()
        body = self.read_json_body()
        required = ("unitId", "checkin", "checkout", "firstName")
        if not all(body.get(k) for k in required):
            return self.send_json(400, {"error": "unitId, checkin, checkout and firstName are required."})
        if body["checkin"] >= body["checkout"]:
            return self.send_json(400, {"error": "checkout must be after checkin."})

        conn = get_conn()
        before = conn.execute("SELECT * FROM Bookings WHERE BookingId=? AND IsDeleted=0", (booking_id,)).fetchone()
        if not before:
            conn.close()
            return self.send_json(404, {"error": "Booking not found."})
        # Check both the unit it's being moved to and the one it's currently on
        # — same reasoning as bookings.js requireUnitAccess(before.UnitId).
        if self.unit_yardi_number(conn, body["unitId"]) not in user["yardiNumbers"] \
                or self.unit_yardi_number(conn, before["UnitId"]) not in user["yardiNumbers"]:
            conn.close()
            return self.send_json(403, {"error": "You do not have access to this unit."})

        auto_price = compute_auto_price(conn, body["unitId"], body["checkin"], body["checkout"])
        final_price = body.get("totalPrice") if (user["isAdmin"] and body.get("totalPrice") is not None) else auto_price
        modified_at = now_iso()
        conn.execute("""
            UPDATE Bookings SET UnitId=?, CheckIn=?, CheckOut=?, TotalPrice=?, FirstName=?, LastName=?,
                                 Email=?, Phone=?, BirthMonth=?, BirthYear=?, ModifiedBy=?, ModifiedAt=?
            WHERE BookingId=?
        """, (body["unitId"], body["checkin"], body["checkout"], final_price, body["firstName"],
              body.get("lastName"), body.get("email"), body.get("phone"), body.get("birthMonth"),
              body.get("birthYear"), user["email"], modified_at, booking_id))
        after = conn.execute("SELECT * FROM Bookings WHERE BookingId=?", (booking_id,)).fetchone()
        record_audit(conn, "Booking", booking_id, "Update", user["email"],
                     old_values=booking_row_to_json(before), new_values=booking_row_to_json(after))
        conn.commit(); conn.close()
        self.send_json(200, booking_row_to_json(after))

    def handle_bookings_delete(self, booking_id):
        user = self.current_user()
        conn = get_conn()
        before = conn.execute("SELECT * FROM Bookings WHERE BookingId=? AND IsDeleted=0", (booking_id,)).fetchone()
        if not before:
            conn.close()
            return self.send_json(404, {"error": "Booking not found."})
        if self.unit_yardi_number(conn, before["UnitId"]) not in user["yardiNumbers"]:
            conn.close()
            return self.send_json(403, {"error": "You do not have access to this unit."})
        conn.execute("UPDATE Bookings SET IsDeleted=1, ModifiedBy=?, ModifiedAt=? WHERE BookingId=?",
                     (user["email"], now_iso(), booking_id))
        record_audit(conn, "Booking", booking_id, "Delete", user["email"], old_values=booking_row_to_json(before))
        conn.commit(); conn.close()
        self.send_no_content()

    def handle_rates_list(self, query):
        user = self.current_user()
        unit_id = query.get("unitId", [None])[0]
        property_id = query.get("propertyId", [None])[0]
        frm = query.get("from", [None])[0]
        to = query.get("to", [None])[0]
        conn = get_conn()

        if unit_id:
            if self.unit_yardi_number(conn, unit_id) not in user["yardiNumbers"]:
                conn.close()
                return self.send_json(403, {"error": "You do not have access to this unit."})
        elif property_id:
            if self.property_yardi_number(conn, property_id) not in user["yardiNumbers"]:
                conn.close()
                return self.send_json(403, {"error": "You do not have access to this property."})
        elif not user["yardiNumbers"]:
            conn.close()
            return self.send_json(200, [])

        sql = """
            SELECT r.UnitId, r.RateDate, r.NightlyRate FROM Rates r
            JOIN Units u ON u.UnitId = r.UnitId
            JOIN Properties p ON p.PropertyId = u.PropertyId
            WHERE 1=1
        """
        params = []
        if unit_id:
            sql += " AND r.UnitId=?"; params.append(unit_id)
        elif property_id:
            sql += " AND u.PropertyId=?"; params.append(property_id)
        else:
            sql += f" AND p.YardiNumber IN ({','.join('?' * len(user['yardiNumbers']))})"
            params += user["yardiNumbers"]
        if frm:
            sql += " AND r.RateDate>=?"; params.append(frm)
        if to:
            sql += " AND r.RateDate<=?"; params.append(to)
        rows = conn.execute(sql, params).fetchall()
        conn.close()
        self.send_json(200, [{"unitId": r["UnitId"], "date": r["RateDate"], "rate": r["NightlyRate"]} for r in rows])

    def handle_rates_set(self):
        user = self.current_user()
        if not user["isAdmin"]:
            return self.send_json(403, {"error": "Only Guest Suites admins can do this."})
        body = self.read_json_body()
        unit_ids = body.get("unitIds") or []
        frm, to, rate = body.get("from"), body.get("to"), body.get("rate")
        if not unit_ids or not frm or not to or rate is None or rate < 0:
            return self.send_json(400, {"error": "unitIds (array), from, to and a non-negative rate are required."})

        conn = get_conn()
        for unit_id in unit_ids:
            if self.unit_yardi_number(conn, unit_id) not in user["yardiNumbers"]:
                conn.close()
                return self.send_json(403, {"error": "You do not have access to this unit."})
        start, end = date.fromisoformat(frm), date.fromisoformat(to)
        for unit_id in unit_ids:
            for d in daterange(start, end + timedelta(days=1)):
                ds = d.isoformat()
                existing = conn.execute("SELECT * FROM Rates WHERE UnitId=? AND RateDate=?", (unit_id, ds)).fetchone()
                conn.execute("""
                    INSERT INTO Rates (UnitId, RateDate, NightlyRate, CreatedBy, CreatedAt) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(UnitId, RateDate) DO UPDATE SET NightlyRate=excluded.NightlyRate,
                        CreatedBy=excluded.CreatedBy, CreatedAt=excluded.CreatedAt
                """, (unit_id, ds, rate, user["email"], now_iso()))
                after = conn.execute("SELECT * FROM Rates WHERE UnitId=? AND RateDate=?", (unit_id, ds)).fetchone()
                record_audit(conn, "Rate", after["RateId"], "Update" if existing else "Insert", user["email"],
                             old_values={"rate": existing["NightlyRate"]} if existing else None,
                             new_values={"unitId": unit_id, "date": ds, "rate": rate})
        conn.commit(); conn.close()
        self.send_no_content()

    def handle_rates_bulk_set(self):
        user = self.current_user()
        if not user["isAdmin"]:
            return self.send_json(403, {"error": "Only Guest Suites admins can do this."})
        body = self.read_json_body()
        rows = body.get("rates") or []
        if not rows:
            return self.send_json(400, {"error": '"rates" must be a non-empty array of {unitId, date, rate}.'})
        if len(rows) > 5000:
            return self.send_json(400, {"error": "Too many rows in one import (max 5000) — split into smaller files."})

        conn = get_conn()
        # A row for a unit outside this admin's assigned properties is a security
        # violation, not a data-quality issue — fail the whole import loudly
        # rather than silently skipping it as a "bad row" (see rates.js).
        distinct_unit_ids = {r.get("unitId") for r in rows if r.get("unitId")}
        for unit_id in distinct_unit_ids:
            if self.unit_yardi_number(conn, unit_id) not in user["yardiNumbers"]:
                conn.close()
                return self.send_json(403, {"error": "You do not have access to this unit."})

        # Fetched once up front so an unknown unitId is a normal per-row error
        # instead of a foreign-key IntegrityError that would otherwise kill the
        # whole request (SQLite raises on the INSERT since PRAGMA foreign_keys
        # is on — same real-world failure mode the real API guards against).
        valid_unit_ids = {r["UnitId"] for r in conn.execute("SELECT UnitId FROM Units").fetchall()}
        imported = 0
        errors = []
        for i, row in enumerate(rows):
            unit_id, ds, rate = row.get("unitId"), row.get("date"), row.get("rate")
            row_num = i + 2
            if not unit_id or not ds or not re.match(r"^\d{4}-\d{2}-\d{2}$", str(ds)) or rate is None or rate < 0:
                errors.append({"row": row_num, "reason": "Missing or invalid unit/date/rate."})
                continue
            if unit_id not in valid_unit_ids:
                errors.append({"row": row_num, "reason": f"Unit {unit_id} does not exist."})
                continue
            existing = conn.execute("SELECT * FROM Rates WHERE UnitId=? AND RateDate=?", (unit_id, ds)).fetchone()
            conn.execute("""
                INSERT INTO Rates (UnitId, RateDate, NightlyRate, CreatedBy, CreatedAt) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(UnitId, RateDate) DO UPDATE SET NightlyRate=excluded.NightlyRate,
                    CreatedBy=excluded.CreatedBy, CreatedAt=excluded.CreatedAt
            """, (unit_id, ds, rate, user["email"], now_iso()))
            after = conn.execute("SELECT * FROM Rates WHERE UnitId=? AND RateDate=?", (unit_id, ds)).fetchone()
            record_audit(conn, "Rate", after["RateId"], "Update" if existing else "Insert", user["email"],
                         old_values={"rate": existing["NightlyRate"]} if existing else None,
                         new_values={"unitId": unit_id, "date": ds, "rate": rate, "source": "csv-import"})
            imported += 1
        conn.commit(); conn.close()
        self.send_json(200, {"imported": imported, "errors": errors})

    def handle_rates_clear(self):
        user = self.current_user()
        if not user["isAdmin"]:
            return self.send_json(403, {"error": "Only Guest Suites admins can do this."})
        body = self.read_json_body()
        unit_ids = body.get("unitIds") or []
        frm, to = body.get("from"), body.get("to")
        if not unit_ids or not frm or not to:
            return self.send_json(400, {"error": "unitIds (array), from and to are required."})

        conn = get_conn()
        for unit_id in unit_ids:
            if self.unit_yardi_number(conn, unit_id) not in user["yardiNumbers"]:
                conn.close()
                return self.send_json(403, {"error": "You do not have access to this unit."})
        for unit_id in unit_ids:
            existing = conn.execute("SELECT * FROM Rates WHERE UnitId=? AND RateDate BETWEEN ? AND ?",
                                     (unit_id, frm, to)).fetchall()
            conn.execute("DELETE FROM Rates WHERE UnitId=? AND RateDate BETWEEN ? AND ?", (unit_id, frm, to))
            for row in existing:
                record_audit(conn, "Rate", row["RateId"], "Delete", user["email"],
                             old_values={"unitId": row["UnitId"], "date": row["RateDate"], "rate": row["NightlyRate"]})
        conn.commit(); conn.close()
        self.send_no_content()

    # Shared by the three reports below: validates/derives which PropertyIds are
    # in scope for this request, mirroring reports.js's YardiNumber filtering.
    # Returns ("error", None), ("empty", None), or ("ok", (clause, params)) —
    # a plain status tag rather than None/exception, since "no access" and "no
    # properties assigned at all" both need to short-circuit differently
    # (403 vs. empty 200) and neither should be confused with "proceed".
    def _reports_property_filter(self, conn, user, property_id):
        if property_id:
            if self.property_yardi_number(conn, property_id) not in user["yardiNumbers"]:
                return "error", None
            return "ok", ("AND u.PropertyId = ?", [property_id])
        if not user["yardiNumbers"]:
            return "empty", None
        placeholders = ",".join("?" * len(user["yardiNumbers"]))
        rows = conn.execute(f"SELECT PropertyId FROM Properties WHERE YardiNumber IN ({placeholders})", user["yardiNumbers"]).fetchall()
        property_ids = [r["PropertyId"] for r in rows]
        if not property_ids:
            return "empty", None
        return "ok", (f"AND u.PropertyId IN ({','.join('?' * len(property_ids))})", property_ids)

    def handle_report_occupancy(self, query):
        user = self.current_user()
        property_id = query.get("propertyId", [None])[0]
        year = query.get("year", [None])[0]
        conn = get_conn()
        status, scope = self._reports_property_filter(conn, user, property_id)
        if status == "error":
            conn.close()
            return self.send_json(403, {"error": "You do not have access to this property."})
        if status == "empty":
            conn.close()
            return self.send_json(200, [])
        clause, params = scope
        rows = conn.execute(f"""
            SELECT b.UnitId, u.UnitLabel, b.CheckIn, b.CheckOut FROM Bookings b
            JOIN Units u ON u.UnitId = b.UnitId WHERE b.IsDeleted = 0
            {clause}
        """, params).fetchall()
        conn.close()
        nights_by_key = {}
        for r in rows:
            start, end = date.fromisoformat(r["CheckIn"]), date.fromisoformat(r["CheckOut"])
            for d in daterange(start, end):
                if year and d.year != int(year):
                    continue
                key = (r["UnitId"], r["UnitLabel"], d.year, d.month)
                nights_by_key[key] = nights_by_key.get(key, 0) + 1
        results = []
        for (unit_id, label, yr, mo), nights in sorted(nights_by_key.items(), key=lambda kv: (kv[0][2], kv[0][3])):
            days_in_month = (date(yr + (mo == 12), (mo % 12) + 1, 1) - date(yr, mo, 1)).days
            results.append({
                "unitId": unit_id, "unitLabel": label, "year": yr, "month": mo,
                "nightsBooked": nights, "daysInMonth": days_in_month,
                "occupancyPct": round(nights / days_in_month * 100, 1)
            })
        self.send_json(200, results)

    def handle_report_revenue(self, query):
        user = self.current_user()
        property_id = query.get("propertyId", [None])[0]
        year = query.get("year", [None])[0]
        conn = get_conn()
        status, scope = self._reports_property_filter(conn, user, property_id)
        if status == "error":
            conn.close()
            return self.send_json(403, {"error": "You do not have access to this property."})
        if status == "empty":
            conn.close()
            return self.send_json(200, [])
        clause, params = scope
        rows = conn.execute(f"""
            SELECT b.UnitId, u.UnitLabel, b.CheckIn, b.CheckOut, b.TotalPrice FROM Bookings b
            JOIN Units u ON u.UnitId = b.UnitId WHERE b.IsDeleted = 0
            {clause}
        """, params).fetchall()
        conn.close()
        revenue_by_key = {}
        for r in rows:
            start, end = date.fromisoformat(r["CheckIn"]), date.fromisoformat(r["CheckOut"])
            total_nights = (end - start).days
            per_night = (r["TotalPrice"] or 0) / total_nights if total_nights else 0
            for d in daterange(start, end):
                if year and d.year != int(year):
                    continue
                key = (r["UnitId"], r["UnitLabel"], d.year, d.month)
                revenue_by_key[key] = revenue_by_key.get(key, 0) + per_night
        results = [
            {"unitId": k[0], "unitLabel": k[1], "year": k[2], "month": k[3], "revenue": round(v, 2)}
            for k, v in sorted(revenue_by_key.items(), key=lambda kv: (kv[0][2], kv[0][3]))
        ]
        self.send_json(200, results)

    def handle_report_upcoming(self, query):
        user = self.current_user()
        property_id = query.get("propertyId", [None])[0]
        days = int(query.get("days", [14])[0])
        today_d = date.today()
        horizon = today_d + timedelta(days=days)
        conn = get_conn()
        status, scope = self._reports_property_filter(conn, user, property_id)
        if status == "error":
            conn.close()
            return self.send_json(403, {"error": "You do not have access to this property."})
        if status == "empty":
            conn.close()
            return self.send_json(200, [])
        clause, params = scope
        rows = conn.execute(f"""
            SELECT b.BookingId, b.CheckIn, b.CheckOut, b.FirstName, b.LastName, u.UnitLabel FROM Bookings b
            JOIN Units u ON u.UnitId = b.UnitId WHERE b.IsDeleted = 0
            {clause}
            ORDER BY b.CheckIn
        """, params).fetchall()
        conn.close()
        results = []
        for r in rows:
            checkin, checkout = date.fromisoformat(r["CheckIn"]), date.fromisoformat(r["CheckOut"])
            if today_d <= checkin <= horizon or today_d <= checkout <= horizon:
                results.append({
                    "bookingId": r["BookingId"], "unitLabel": r["UnitLabel"],
                    "checkin": r["CheckIn"], "checkout": r["CheckOut"],
                    "guest": " ".join(filter(None, [r["FirstName"], r["LastName"]]))
                })
        self.send_json(200, results)

    def handle_audit(self, entity_type, entity_id):
        user = self.current_user()
        conn = get_conn()
        rows = conn.execute(
            "SELECT * FROM AuditLog WHERE EntityType=? AND EntityId=? ORDER BY ChangedAt DESC",
            (entity_type, entity_id),
        ).fetchall()
        if rows:
            # Mirrors audit.js: AuditLog has no PropertyId, so pull unitId out of
            # the snapshot JSON (works even for a hard-deleted Rate) instead of
            # joining back through a live Units row.
            snapshot = json.loads(rows[0]["NewValues"] or rows[0]["OldValues"] or "{}")
            unit_id = snapshot.get("unitId")
            if not unit_id or self.unit_yardi_number(conn, unit_id) not in user["yardiNumbers"]:
                conn.close()
                return self.send_json(403, {"error": "You do not have access to this history."})
        conn.close()
        self.send_json(200, [{
            "action": r["Action"], "changedBy": r["ChangedBy"], "changedAt": r["ChangedAt"],
            "oldValues": json.loads(r["OldValues"]) if r["OldValues"] else None,
            "newValues": json.loads(r["NewValues"]) if r["NewValues"] else None,
        } for r in rows])


def qa_widget_html():
    current = CURRENT_PROFILE["key"]
    links = "".join(
        f'<a href="/mock/login/{key}" style="color:{"#ffd479" if key == current else "#9fe1cb" if is_admin_title(u["title"]) else "#b5d4f4"}">'
        f'{key}{" (active)" if key == current else ""}</a>'
        for key, u in MOCK_USERS.items()
    )
    return f"""
<div id="qaWidget" style="position:fixed;bottom:10px;right:10px;background:#222;color:#fff;
  padding:8px 12px;border-radius:8px;font:12px sans-serif;z-index:999;display:flex;gap:8px;
  align-items:center;flex-wrap:wrap;max-width:360px">
  <span>LOCAL MOCK</span>
  {links}
</div>
</body>
""".encode("utf-8")


def inject_qa_widget(html_bytes):
    return html_bytes.replace(b"</body>", qa_widget_html(), 1)


def main():
    init_db()
    server = ThreadingHTTPServer(("localhost", 8787), Handler)
    print("Guest Suite Tracker — local mock server (dev-only, not for production)")
    print(f"Serving at http://localhost:8787  (default user: {CURRENT_PROFILE['key']})")
    print("Switch users at /mock/login/<profile> — profiles:", ", ".join(MOCK_USERS))
    server.serve_forever()


if __name__ == "__main__":
    main()
