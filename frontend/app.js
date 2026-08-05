const UNIT_COLOR_CLASSES = ['unit-color-0', 'unit-color-1', 'unit-color-2'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOWS = ['Su','Mo','Tu','We','Th','Fr','Sa'];

let currentUser = null;      // { email, isAdmin }
let properties = [];         // [{propertyId, name, shortCode, units:[{unitId, unitLabel}]}]
let selectedPropertyId = null;
let bookings = [];            // active bookings for the selected property + visible range
let rates = {};               // `${unitId}__${date}` -> rate
let editId = null;
let calStart = null;          // Date, first of the month the calendar starts on

function dk(y, m, d) { return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function rateKey(unitId, date) { return `${unitId}__${date}`; }
function unitColorClass(units, unitId) {
    const idx = units.findIndex(u => u.unitId === unitId);
    return UNIT_COLOR_CLASSES[idx % UNIT_COLOR_CLASSES.length];
}

// `new Date("2026-07-01")` parses that as UTC midnight, which shifts to the
// previous day once converted to a local timezone west of UTC (e.g. US time
// zones) — silently turning "check-out is the day after check-in" into
// "check-out equals check-in". Every "YYYY-MM-DD" string from a <input
// type=date> or from the API must go through this instead of `new Date(str)`.
function parseDateKey(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
}

async function api(path, options = {}) {
    const res = await fetch(path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    if (!res.ok) {
        let message = `Request failed (${res.status})`;
        try { const body = await res.json(); if (body.error) message = body.error; } catch (_) {}
        throw new Error(message);
    }
    if (res.status === 204) return null;
    return res.json();
}

async function loadCurrentUser() {
    const info = await fetch('/.auth/me').then(r => r.json()).catch(() => null);
    const principal = info && info.clientPrincipal;
    if (!principal) {
        currentUser = null;
        return;
    }
    currentUser = {
        email: principal.userDetails,
        isAdmin: (principal.userRoles || []).includes('admin')
    };
}

function applyRoleToUI() {
    const isAdmin = !!(currentUser && currentUser.isAdmin);
    document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin));
    document.getElementById('mPrice').disabled = !isAdmin;
    document.getElementById('whoami').textContent = currentUser
        ? `${currentUser.email}${isAdmin ? ' · admin' : ''}`
        : 'Not signed in';
}

function currentProperty() {
    return properties.find(p => p.propertyId === selectedPropertyId);
}

function calendarRangeMonths() {
    const months = [];
    for (let i = 0; i < 12; i++) {
        const d = new Date(calStart.getFullYear(), calStart.getMonth() + i, 1);
        months.push({ y: d.getFullYear(), m: d.getMonth() });
    }
    return months;
}

function calendarRangeBounds() {
    const months = calendarRangeMonths();
    const first = months[0];
    const last = months[months.length - 1];
    const from = dk(first.y, first.m, 1);
    const lastDim = new Date(last.y, last.m + 1, 0).getDate();
    const to = dk(last.y, last.m, lastDim);
    return { from, to };
}

async function loadPropertyData() {
    const property = currentProperty();
    if (!property) return;
    const { from, to } = calendarRangeBounds();

    const [bookingsRes, ratesRes] = await Promise.all([
        api(`/api/bookings?propertyId=${property.propertyId}&from=${from}&to=${to}`),
        api(`/api/rates?propertyId=${property.propertyId}&from=${from}&to=${to}`)
    ]);

    bookings = bookingsRes;
    rates = {};
    ratesRes.forEach(r => { rates[rateKey(r.unitId, r.date)] = r.rate; });
}

function getBookingFor(date, unitId) {
    return bookings.find(b => b.unitId === unitId && b.checkin <= date && b.checkout > date);
}

function getRate(unitId, date) { return rates[rateKey(unitId, date)] || null; }

function calcPresetTotal(unitId, checkin, checkout) {
    if (!checkin || !checkout || checkin >= checkout) return null;
    let total = 0, hasAny = false;
    const cur = parseDateKey(checkin), end = parseDateKey(checkout);
    while (cur < end) {
        const r = getRate(Number(unitId), dk(cur.getFullYear(), cur.getMonth(), cur.getDate()));
        if (r) { total += r; hasAny = true; }
        cur.setDate(cur.getDate() + 1);
    }
    return hasAny ? total : null;
}

function addDays(dateStr, n) {
    const d = parseDateKey(dateStr);
    d.setDate(d.getDate() + n);
    return dk(d.getFullYear(), d.getMonth(), d.getDate());
}

const today = new Date();
const todayKey = dk(today.getFullYear(), today.getMonth(), today.getDate());

function renderPropertySelect() {
    const sel = document.getElementById('propertySelect');
    sel.innerHTML = properties.map(p => `<option value="${p.propertyId}">${p.name}</option>`).join('');
    sel.value = selectedPropertyId;
}

function renderLegendAndUnitSelects() {
    const property = currentProperty();
    const legend = document.getElementById('legend');
    legend.innerHTML = property.units.map((u, i) =>
        `<span class="leg-item"><span class="leg-dot unit-color-${i % 3}"></span>Unit ${u.unitLabel}</span>`
    ).join('');

    const unitOptions = property.units.map(u => `<option value="${u.unitId}">Unit ${u.unitLabel}</option>`).join('');
    document.getElementById('mUnit').innerHTML = unitOptions;
    document.getElementById('rUnit').innerHTML = unitOptions + '<option value="ALL">All units</option>';

    document.getElementById('calTitle').textContent = `Rental Calendar — ${property.name}`;
}

function renderCalendar() {
    const property = currentProperty();
    const grid = document.getElementById('monthGrid');
    grid.innerHTML = '';

    calendarRangeMonths().forEach(({ y, m }) => {
        const dim = new Date(y, m + 1, 0).getDate();
        const fdow = new Date(y, m, 1).getDay();
        const card = document.createElement('div');
        card.className = 'month-card';
        let html = `<div class="month-name">${MONTHS[m]} ${y}</div>`;
        html += `<div class="dow-row">${DOWS.map(d => `<div class="dow-cell">${d}</div>`).join('')}</div>`;
        html += `<div class="days-grid">`;
        for (let e = 0; e < fdow; e++) html += `<div class="day-cell empty"></div>`;
        for (let d = 1; d <= dim; d++) {
            const dateStr = dk(y, m, d);
            const isToday = dateStr === todayKey;
            html += `<div class="day-cell">`;
            html += `<div class="day-num${isToday ? ' today-n' : ''}">${d}</div>`;
            property.units.forEach(unit => {
                const b = getBookingFor(dateStr, unit.unitId);
                const colorClass = unitColorClass(property.units, unit.unitId);
                const unitRate = getRate(unit.unitId, dateStr);
                if (b) {
                    const isFirst = b.checkin === dateStr;
                    const label = isFirst ? (b.firstName || '▶') : '';
                    const priceStr = isFirst && b.price ? ` $${Math.round(b.price)}` : '';
                    html += `<div class="unit-row ${colorClass}" title="${b.firstName || ''} ${b.lastName || ''}${b.price ? ' · $' + b.price : ''}" data-bid="${b.id}">${label}${priceStr}</div>`;
                } else {
                    const rateLabel = unitRate ? `$${Math.round(unitRate)}` : '';
                    html += `<div class="unit-row ${colorClass} vacant" data-date="${dateStr}" data-unit="${unit.unitId}" style="font-size:8px;justify-content:center">${rateLabel}</div>`;
                }
            });
            html += `</div>`;
        }
        html += `</div>`;
        card.innerHTML = html;
        grid.appendChild(card);
    });

    grid.querySelectorAll('.unit-row[data-bid]').forEach(el => {
        el.addEventListener('click', (e) => { e.stopPropagation(); openEditModal(el.dataset.bid); });
    });
    grid.querySelectorAll('.unit-row.vacant').forEach(el => {
        el.addEventListener('click', (e) => { e.stopPropagation(); openAddModal(el.dataset.date, Number(el.dataset.unit)); });
    });
}

function clearForm() {
    ['mFirst', 'mLast', 'mEmail', 'mPhone', 'mBirthYear', 'mPrice'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('mBirthMonth').value = '';
}

function updatePriceHint() {
    const unit = document.getElementById('mUnit').value;
    const checkin = document.getElementById('mIn').value;
    const checkout = document.getElementById('mOut').value;
    const preset = calcPresetTotal(unit, checkin, checkout);
    const hint = document.getElementById('priceHint');
    const priceInput = document.getElementById('mPrice');
    const isAdmin = !!(currentUser && currentUser.isAdmin);

    if (preset !== null) {
        if (!isAdmin) priceInput.value = Math.round(preset);
        hint.textContent = isAdmin
            ? `Preset total from nightly rates: $${Math.round(preset)} — click to use`
            : `Price is set from the nightly rates on file: $${Math.round(preset)}`;
        hint.style.cursor = isAdmin ? 'pointer' : 'default';
        hint.style.color = isAdmin ? '#185FA5' : 'var(--color-text-tertiary)';
        hint.onclick = isAdmin ? () => { priceInput.value = Math.round(preset); } : null;
    } else {
        hint.textContent = isAdmin
            ? 'No nightly rates set for these dates — enter a price manually.'
            : 'No nightly rates set for these dates yet — ask an admin to set pricing.';
        hint.style.cursor = 'default';
        hint.onclick = null;
    }
}

async function renderHistory(entityType, entityId) {
    const section = document.getElementById('historySection');
    const list = document.getElementById('historyList');
    if (!entityId) { section.style.display = 'none'; list.innerHTML = ''; return; }
    section.style.display = '';
    list.innerHTML = '<div class="history-row">Loading…</div>';
    try {
        const history = await api(`/api/audit/${entityType}/${entityId}`);
        list.innerHTML = history.length
            ? history.map(h => `<div class="history-row">${new Date(h.changedAt).toLocaleString()} — ${h.action} by ${h.changedBy}</div>`).join('')
            : '<div class="history-row">No history yet.</div>';
    } catch (err) {
        list.innerHTML = `<div class="history-row">Could not load history: ${err.message}</div>`;
    }
}

function openAddModal(date, unitId) {
    editId = null;
    document.getElementById('mHdr').textContent = 'Add booking';
    document.getElementById('mSub').textContent = date;
    document.getElementById('mUnit').value = unitId;
    document.getElementById('mIn').value = date;
    document.getElementById('mOut').value = addDays(date, 1);
    document.getElementById('mDel').style.display = 'none';
    clearForm();
    updatePriceHint();
    renderHistory(null, null);
    document.getElementById('modalOverlay').classList.add('open');
}

function openEditModal(bid) {
    const b = bookings.find(x => x.id === bid);
    if (!b) return;
    editId = bid;
    document.getElementById('mHdr').textContent = 'Edit booking';
    document.getElementById('mSub').textContent = '';
    document.getElementById('mUnit').value = b.unitId;
    document.getElementById('mIn').value = b.checkin;
    document.getElementById('mOut').value = b.checkout;
    document.getElementById('mPrice').value = b.price || '';
    document.getElementById('mFirst').value = b.firstName || '';
    document.getElementById('mLast').value = b.lastName || '';
    document.getElementById('mEmail').value = b.email || '';
    document.getElementById('mPhone').value = b.phone || '';
    document.getElementById('mBirthMonth').value = b.birthMonth || '';
    document.getElementById('mBirthYear').value = b.birthYear || '';
    document.getElementById('mDel').style.display = '';
    updatePriceHint();
    renderHistory('Booking', bid);
    document.getElementById('modalOverlay').classList.add('open');
}

function closeModal() { document.getElementById('modalOverlay').classList.remove('open'); }

async function saveBooking() {
    const isAdmin = !!(currentUser && currentUser.isAdmin);
    const payload = {
        unitId: Number(document.getElementById('mUnit').value),
        checkin: document.getElementById('mIn').value,
        checkout: document.getElementById('mOut').value,
        firstName: document.getElementById('mFirst').value.trim(),
        lastName: document.getElementById('mLast').value.trim(),
        email: document.getElementById('mEmail').value.trim(),
        phone: document.getElementById('mPhone').value.trim(),
        birthMonth: document.getElementById('mBirthMonth').value,
        birthYear: document.getElementById('mBirthYear').value ? Number(document.getElementById('mBirthYear').value) : null
    };
    if (isAdmin) {
        const priceVal = document.getElementById('mPrice').value;
        payload.totalPrice = priceVal ? Number(priceVal) : null;
    }
    if (!payload.checkin || !payload.checkout || payload.checkin >= payload.checkout) {
        alert('Check-out must be after check-in.'); return;
    }
    if (!payload.firstName) { alert('Please enter a first name.'); return; }

    try {
        if (editId) await api(`/api/bookings/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
        else await api('/api/bookings', { method: 'POST', body: JSON.stringify(payload) });
        closeModal();
        await loadPropertyData();
        renderCalendar();
    } catch (err) {
        alert(`Could not save booking: ${err.message}`);
    }
}

async function deleteBooking() {
    if (!editId) return;
    if (!confirm('Delete this booking?')) return;
    try {
        await api(`/api/bookings/${editId}`, { method: 'DELETE' });
        closeModal();
        await loadPropertyData();
        renderCalendar();
    } catch (err) {
        alert(`Could not delete booking: ${err.message}`);
    }
}

async function applyRate() {
    const unitVal = document.getElementById('rUnit').value;
    const from = document.getElementById('rFrom').value;
    const to = document.getElementById('rTo').value;
    const rate = parseFloat(document.getElementById('rRate').value);
    if (!from || !to || from > to || isNaN(rate) || rate < 0) {
        alert('Please fill in a valid date range and rate.'); return;
    }
    const property = currentProperty();
    const unitIds = unitVal === 'ALL' ? property.units.map(u => u.unitId) : [Number(unitVal)];
    try {
        await api('/api/rates', { method: 'POST', body: JSON.stringify({ unitIds, from, to, rate }) });
        await loadPropertyData();
        renderCalendar();
    } catch (err) {
        alert(`Could not set rate: ${err.message}`);
    }
}

async function clearRates() {
    if (!confirm('Clear all preset rates for the visible range?')) return;
    const property = currentProperty();
    const { from, to } = calendarRangeBounds();
    try {
        await api('/api/rates', { method: 'DELETE', body: JSON.stringify({ unitIds: property.units.map(u => u.unitId), from, to }) });
        await loadPropertyData();
        renderCalendar();
    } catch (err) {
        alert(`Could not clear rates: ${err.message}`);
    }
}

// -- CSV rate import/export -------------------------------------------------
// Template columns are deliberately "Unit,Date,Rate" (one row per unit per
// night) rather than a from/to range — the whole point is to match Katie's
// seasonal pricing spreadsheet, where the rate can be different every single
// day, not a flat number across a range.

function parseCsvText(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // Excel prepends a UTF-8 BOM to saved CSVs
    const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim() !== '');
    if (lines.length === 0) return { headers: [], rows: [] };
    const splitLine = (line) => {
        const cells = [];
        let cur = '', inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (inQuotes) {
                if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
                else if (c === '"') { inQuotes = false; }
                else { cur += c; }
            } else if (c === '"') { inQuotes = true; }
            else if (c === ',') { cells.push(cur); cur = ''; }
            else { cur += c; }
        }
        cells.push(cur);
        return cells.map(c => c.trim());
    };
    const headers = splitLine(lines[0]).map(h => h.toLowerCase());
    return { headers, rows: lines.slice(1).map(splitLine) };
}

function downloadRateTemplate() {
    const property = currentProperty();
    const unitVal = document.getElementById('rUnit').value;
    const from = document.getElementById('rFrom').value;
    const to = document.getElementById('rTo').value;
    if (!from || !to || from > to) { alert('Pick a valid From/To range above first.'); return; }

    const units = unitVal === 'ALL' ? property.units : property.units.filter(u => u.unitId === Number(unitVal));
    const lines = ['Unit,Date,Rate'];
    const start = parseDateKey(from), end = parseDateKey(to);
    units.forEach(unit => {
        const cur = new Date(start);
        while (cur <= end) {
            const ds = dk(cur.getFullYear(), cur.getMonth(), cur.getDate());
            const existing = getRate(unit.unitId, ds);
            lines.push(`${unit.unitLabel},${ds},${existing || ''}`);
            cur.setDate(cur.getDate() + 1);
        }
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${property.shortCode || property.name}-rates-${from}-to-${to}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function importRateCsv() {
    const fileInput = document.getElementById('csvFile');
    const file = fileInput.files[0];
    if (!file) { alert('Choose a CSV file first.'); return; }

    const text = await file.text();
    const { headers, rows } = parseCsvText(text);
    const dateIdx = headers.indexOf('date');
    // Accepts either the simple downloaded template ("rate") or a richer
    // research sheet like a seasonal pricing worksheet ("nightly_rate"), plus
    // whatever extra columns that sheet has (day_of_week, rate_type, ...) —
    // those are read but not stored; see the "available" handling below.
    const rateIdx = headers.indexOf('rate') !== -1 ? headers.indexOf('rate') : headers.indexOf('nightly_rate');
    const unitIdx = headers.indexOf('unit');
    const availableIdx = headers.indexOf('available');
    if (dateIdx === -1 || rateIdx === -1) {
        alert('CSV must have at least a Date column and a Rate (or nightly_rate) column.');
        return;
    }

    const property = currentProperty();
    const labelToId = {};
    property.units.forEach(u => { labelToId[String(u.unitLabel).trim()] = u.unitId; });

    // No Unit column means "same price for every unit" — apply to whichever
    // unit(s) are picked in the toolbar above (including "All units"), the
    // same selector the regular Apply button already uses.
    let impliedUnitIds = null;
    if (unitIdx === -1) {
        const unitVal = document.getElementById('rUnit').value;
        impliedUnitIds = unitVal === 'ALL' ? property.units.map(u => u.unitId) : [Number(unitVal)];
    }

    const validRows = [];
    const clientErrors = [];
    rows.forEach((cells, i) => {
        const rowNum = i + 2; // +1 for 0-index, +1 for the header row
        const dateStr = (cells[dateIdx] || '').trim();
        const rateRaw = (cells[rateIdx] || '').trim();
        const unitLabel = unitIdx !== -1 ? (cells[unitIdx] || '').trim() : null;
        if (!dateStr && !rateRaw && !unitLabel) return; // fully blank row
        if (!rateRaw) return; // blank rate = "leave this day alone", not an error

        // A day explicitly marked unavailable (e.g. blocked for maintenance) —
        // the app doesn't enforce blackout dates yet, but importing a price
        // for a day meant to be off-limits would be actively misleading, so
        // this skips pricing it rather than treating the column as an error.
        if (availableIdx !== -1 && (cells[availableIdx] || '').trim().toUpperCase() === 'FALSE') return;

        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { clientErrors.push(`Row ${rowNum}: bad date "${dateStr}"`); return; }
        const rate = parseFloat(rateRaw.replace(/[$,]/g, '')); // tolerate "$150" / "1,370"-style formatting
        if (isNaN(rate) || rate < 0) { clientErrors.push(`Row ${rowNum}: bad rate "${rateRaw}"`); return; }

        if (impliedUnitIds) {
            impliedUnitIds.forEach(unitId => validRows.push({ unitId, date: dateStr, rate }));
        } else {
            const unitId = labelToId[unitLabel];
            if (!unitId) { clientErrors.push(`Row ${rowNum}: unknown unit "${unitLabel}"`); return; }
            validRows.push({ unitId, date: dateStr, rate });
        }
    });

    if (validRows.length === 0) {
        alert(clientErrors.length
            ? `No valid rows to import.\n\n${clientErrors.slice(0, 10).join('\n')}`
            : 'No rows found in that file.');
        return;
    }

    try {
        const result = await api('/api/rates/bulk', { method: 'POST', body: JSON.stringify({ rates: validRows }) });
        const allErrors = [...clientErrors, ...(result.errors || []).map(e => `Row ${e.row}: ${e.reason}`)];
        let msg = `Imported ${result.imported} rate(s).`;
        if (allErrors.length) {
            msg += `\n\n${allErrors.length} row(s) skipped:\n${allErrors.slice(0, 10).join('\n')}`;
            if (allErrors.length > 10) msg += `\n...and ${allErrors.length - 10} more.`;
        }
        alert(msg);
        fileInput.value = '';
        await loadPropertyData();
        renderCalendar();
    } catch (err) {
        alert(`Import failed: ${err.message}`);
    }
}

function monthLabel(month) { return MONTHS[month - 1].slice(0, 3); }

async function renderReports() {
    const property = currentProperty();
    if (!property) return;
    const year = new Date().getFullYear();

    const [occ1, occ2, rev1, rev2, upcoming] = await Promise.all([
        api(`/api/reports/occupancy?propertyId=${property.propertyId}&year=${year}`),
        api(`/api/reports/occupancy?propertyId=${property.propertyId}&year=${year + 1}`),
        api(`/api/reports/revenue?propertyId=${property.propertyId}&year=${year}`),
        api(`/api/reports/revenue?propertyId=${property.propertyId}&year=${year + 1}`),
        api(`/api/reports/upcoming?propertyId=${property.propertyId}&days=14`)
    ]);

    const occRows = [...occ1, ...occ2];
    const revRows = [...rev1, ...rev2];

    document.getElementById('occupancyTable').innerHTML =
        '<tr><th>Unit</th><th>Month</th><th>Nights booked</th><th>Occupancy</th></tr>' +
        occRows.map(r => `<tr><td>${r.unitLabel}</td><td>${monthLabel(r.month)} ${r.year}</td><td>${r.nightsBooked}/${r.daysInMonth}</td><td>${r.occupancyPct}%</td></tr>`).join('');

    document.getElementById('revenueTable').innerHTML =
        '<tr><th>Unit</th><th>Month</th><th>Revenue</th></tr>' +
        revRows.map(r => `<tr><td>${r.unitLabel}</td><td>${monthLabel(r.month)} ${r.year}</td><td>$${r.revenue.toFixed(2)}</td></tr>`).join('');

    document.getElementById('upcomingTable').innerHTML =
        '<tr><th>Unit</th><th>Check-in</th><th>Check-out</th><th>Guest</th></tr>' +
        upcoming.map(r => `<tr><td>${r.unitLabel}</td><td>${r.checkin}</td><td>${r.checkout}</td><td>${r.guest}</td></tr>`).join('');
}

function wireTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
            document.getElementById(`tab-${btn.dataset.tab}`).style.display = '';
            if (btn.dataset.tab === 'reports') renderReports();
        });
    });
}

function wireStaticControls() {
    document.getElementById('propertySelect').addEventListener('change', async (e) => {
        selectedPropertyId = Number(e.target.value);
        renderLegendAndUnitSelects();
        await loadPropertyData();
        renderCalendar();
    });
    document.getElementById('applyRateBtn').addEventListener('click', applyRate);
    document.getElementById('clearRatesBtn').addEventListener('click', clearRates);
    document.getElementById('downloadTemplateBtn').addEventListener('click', downloadRateTemplate);
    document.getElementById('importCsvBtn').addEventListener('click', importRateCsv);
    document.getElementById('mCancel').addEventListener('click', closeModal);
    document.getElementById('mSave').addEventListener('click', saveBooking);
    document.getElementById('mDel').addEventListener('click', deleteBooking);
    ['mIn', 'mOut', 'mUnit'].forEach(id => document.getElementById(id).addEventListener('change', updatePriceHint));
    document.getElementById('modalOverlay').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
}

async function init() {
    await loadCurrentUser();
    if (!currentUser) {
        document.body.innerHTML = '<div style="padding:2rem;font-family:sans-serif">Please <a href="/.auth/login/okta">sign in</a> to continue.</div>';
        return;
    }
    applyRoleToUI();

    properties = await api('/api/properties');
    if (properties.length === 0) {
        document.getElementById('monthGrid').innerHTML = '<p>No properties configured yet.</p>';
        return;
    }
    selectedPropertyId = properties[0].propertyId;
    calStart = new Date(today.getFullYear(), today.getMonth(), 1);

    renderPropertySelect();
    renderLegendAndUnitSelects();
    wireTabs();
    wireStaticControls();

    await loadPropertyData();
    renderCalendar();
}

init();
