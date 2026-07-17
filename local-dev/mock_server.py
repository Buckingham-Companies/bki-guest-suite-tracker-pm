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
    -> visit /mock/login/admin or /mock/login/staff to switch roles
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

CURRENT_ROLE = {"role": "admin"}  # flips via /mock/login/<role>; admin by default for convenience

ADMIN_USER = "marliss.davis@buckingham.com"
STAFF_USER = "front.desk@buckingham.com"


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS Properties (
            PropertyId INTEGER PRIMARY KEY AUTOINCREMENT,
            Name TEXT NOT NULL,
            ShortCode TEXT NOT NULL UNIQUE
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
    row = conn.execute("SELECT COUNT(*) c FROM Properties").fetchone()
    if row["c"] == 0:
        conn.execute("INSERT INTO Properties (Name, ShortCode) VALUES ('The Beverly', 'BEVERLY')")
        property_id = conn.execute("SELECT PropertyId FROM Properties WHERE ShortCode='BEVERLY'").fetchone()[0]
        for label in ("108", "124", "224"):
            conn.execute("INSERT INTO Units (PropertyId, UnitLabel) VALUES (?, ?)", (property_id, label))
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
        role = CURRENT_ROLE["role"]
        if role == "admin":
            return {"email": ADMIN_USER, "isAdmin": True}
        return {"email": STAFF_USER, "isAdmin": False}

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
            user = self.current_user()
            roles = ["authenticated"] + (["admin"] if user["isAdmin"] else [])
            self.send_json(200, {"clientPrincipal": {"userDetails": user["email"], "userRoles": roles}})
            return
        if path == "/.auth/logout":
            self.send_response(302); self.send_header("Location", "/"); self.end_headers()
            return
        if path.startswith("/mock/login/"):
            role = path.rsplit("/", 1)[-1]
            CURRENT_ROLE["role"] = "admin" if role == "admin" else "staff"
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
        conn = get_conn()
        props = {}
        rows = conn.execute("""
            SELECT p.PropertyId, p.Name, p.ShortCode, u.UnitId, u.UnitLabel
            FROM Properties p JOIN Units u ON u.PropertyId = p.PropertyId AND u.IsActive = 1
            ORDER BY p.Name, u.UnitLabel
        """).fetchall()
        for r in rows:
            props.setdefault(r["PropertyId"], {
                "propertyId": r["PropertyId"], "name": r["Name"], "shortCode": r["ShortCode"], "units": []
            })["units"].append({"unitId": r["UnitId"], "unitLabel": r["UnitLabel"]})
        conn.close()
        self.send_json(200, list(props.values()))

    def handle_bookings_list(self, query):
        property_id = query.get("propertyId", [None])[0]
        frm = query.get("from", [None])[0]
        to = query.get("to", [None])[0]
        conn = get_conn()
        sql = """
            SELECT b.* FROM Bookings b JOIN Units u ON u.UnitId = b.UnitId
            WHERE b.IsDeleted = 0
        """
        params = []
        if property_id:
            sql += " AND u.PropertyId = ?"; params.append(property_id)
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
        conn.execute("UPDATE Bookings SET IsDeleted=1, ModifiedBy=?, ModifiedAt=? WHERE BookingId=?",
                     (user["email"], now_iso(), booking_id))
        record_audit(conn, "Booking", booking_id, "Delete", user["email"], old_values=booking_row_to_json(before))
        conn.commit(); conn.close()
        self.send_no_content()

    def handle_rates_list(self, query):
        unit_id = query.get("unitId", [None])[0]
        property_id = query.get("propertyId", [None])[0]
        frm = query.get("from", [None])[0]
        to = query.get("to", [None])[0]
        conn = get_conn()
        sql = "SELECT r.UnitId, r.RateDate, r.NightlyRate FROM Rates r JOIN Units u ON u.UnitId = r.UnitId WHERE 1=1"
        params = []
        if unit_id:
            sql += " AND r.UnitId=?"; params.append(unit_id)
        if property_id:
            sql += " AND u.PropertyId=?"; params.append(property_id)
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
            existing = conn.execute("SELECT * FROM Rates WHERE UnitId=? AND RateDate BETWEEN ? AND ?",
                                     (unit_id, frm, to)).fetchall()
            conn.execute("DELETE FROM Rates WHERE UnitId=? AND RateDate BETWEEN ? AND ?", (unit_id, frm, to))
            for row in existing:
                record_audit(conn, "Rate", row["RateId"], "Delete", user["email"],
                             old_values={"unitId": row["UnitId"], "date": row["RateDate"], "rate": row["NightlyRate"]})
        conn.commit(); conn.close()
        self.send_no_content()

    def handle_report_occupancy(self, query):
        property_id = query.get("propertyId", [None])[0]
        year = query.get("year", [None])[0]
        conn = get_conn()
        rows = conn.execute("""
            SELECT b.UnitId, u.UnitLabel, b.CheckIn, b.CheckOut FROM Bookings b
            JOIN Units u ON u.UnitId = b.UnitId WHERE b.IsDeleted = 0
            AND (? IS NULL OR u.PropertyId = ?)
        """, (property_id, property_id)).fetchall()
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
        property_id = query.get("propertyId", [None])[0]
        year = query.get("year", [None])[0]
        conn = get_conn()
        rows = conn.execute("""
            SELECT b.UnitId, u.UnitLabel, b.CheckIn, b.CheckOut, b.TotalPrice FROM Bookings b
            JOIN Units u ON u.UnitId = b.UnitId WHERE b.IsDeleted = 0
            AND (? IS NULL OR u.PropertyId = ?)
        """, (property_id, property_id)).fetchall()
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
        property_id = query.get("propertyId", [None])[0]
        days = int(query.get("days", [14])[0])
        today_d = date.today()
        horizon = today_d + timedelta(days=days)
        conn = get_conn()
        rows = conn.execute("""
            SELECT b.BookingId, b.CheckIn, b.CheckOut, b.FirstName, b.LastName, u.UnitLabel FROM Bookings b
            JOIN Units u ON u.UnitId = b.UnitId WHERE b.IsDeleted = 0
            AND (? IS NULL OR u.PropertyId = ?)
            ORDER BY b.CheckIn
        """, (property_id, property_id)).fetchall()
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
        conn = get_conn()
        rows = conn.execute(
            "SELECT * FROM AuditLog WHERE EntityType=? AND EntityId=? ORDER BY ChangedAt DESC",
            (entity_type, entity_id),
        ).fetchall()
        conn.close()
        self.send_json(200, [{
            "action": r["Action"], "changedBy": r["ChangedBy"], "changedAt": r["ChangedAt"],
            "oldValues": json.loads(r["OldValues"]) if r["OldValues"] else None,
            "newValues": json.loads(r["NewValues"]) if r["NewValues"] else None,
        } for r in rows])


QA_WIDGET = b"""
<div id="qaWidget" style="position:fixed;bottom:10px;right:10px;background:#222;color:#fff;
  padding:8px 12px;border-radius:8px;font:12px sans-serif;z-index:999;display:flex;gap:8px;align-items:center">
  <span>LOCAL MOCK</span>
  <a href="/mock/login/admin" style="color:#9fe1cb">as admin</a>
  <a href="/mock/login/staff" style="color:#b5d4f4">as staff</a>
</div>
</body>
"""


def inject_qa_widget(html_bytes):
    return html_bytes.replace(b"</body>", QA_WIDGET, 1)


def main():
    init_db()
    server = ThreadingHTTPServer(("localhost", 8787), Handler)
    print("Guest Suite Tracker — local mock server (dev-only, not for production)")
    print("Serving at http://localhost:8787  (default role: admin)")
    print("Switch roles at /mock/login/admin or /mock/login/staff")
    server.serve_forever()


if __name__ == "__main__":
    main()
