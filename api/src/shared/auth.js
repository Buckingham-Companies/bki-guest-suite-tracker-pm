const { query } = require('./db');

// Azure Static Web Apps injects this header on every request it proxies to a
// linked Functions API, once Okta is wired up as the auth provider in
// staticwebapp.config.json. It is NOT present when the Functions API is
// called directly (bypassing the SWA front door) — see the deployment note in
// infra/README.md about locking the Function App down to that.
const PRINCIPAL_HEADER = 'x-ms-client-principal';

// principal.claims carries the same raw ID token claims that get POSTed to
// /api/getRoles at login (see getRoles.js) — it's how per-property scoping
// reaches every other route without a DB round trip just to read the user's
// own assignment. Matched loosely (case-insensitive, tolerant of a URI-style
// typ like ".../claims/YardiNumber") since IT controls the exact claim name
// on the Okta app integration's Sign On tab, not this code.
function findClaims(claims, name) {
    const needle = name.toLowerCase();
    const typ = claims.map(c => c.typ).find(t => t && (t.toLowerCase() === needle || t.toLowerCase().endsWith('/' + needle)));
    return typ ? claims.filter(c => c.typ === typ) : [];
}

// A Property Manager has one Yardi property; a VP, Regional, or Multi-Site
// Manager has several. We don't yet know whether Okta will send that as a
// true multi-value claim (repeated {typ, val} entries) or one delimited
// string ("1264,1271") on a single entry — this handles either, so nothing
// here needs to change once IT confirms which.
function parseYardiNumbers(claims) {
    return findClaims(claims, 'YardiNumber')
        .map(c => c.val)
        .flatMap(v => (Array.isArray(v) ? v : [v]))
        .flatMap(v => String(v).split(/[,;]/))
        .map(v => v.trim())
        .filter(Boolean);
}

function getUser(request) {
    const header = request.headers.get(PRINCIPAL_HEADER);
    if (!header) {
        return null;
    }
    const decoded = Buffer.from(header, 'base64').toString('utf-8');
    const principal = JSON.parse(decoded);
    const roles = principal.userRoles || [];
    return {
        email: principal.userDetails,
        isAdmin: roles.includes('admin'),
        roles,
        // Yardi Prop #s this user is assigned to, from the user.YardiNumber
        // Okta claim. This — not the "admin" role — is what actually governs
        // which properties they can see and act on; see requirePropertyAccess
        // and requireUnitAccess below.
        yardiNumbers: parseYardiNumbers(principal.claims || [])
    };
}

// Every write route calls this — never trust a role hidden in the UI alone.
function requireUser(request) {
    const user = getUser(request);
    if (!user) {
        const err = new Error('Not authenticated.');
        err.statusCode = 401;
        throw err;
    }
    return user;
}

// "admin" is a coarse, app-wide SWA role (granted to anyone with a qualifying
// title in Okta — see CLAUDE.md Okta Setup) used to gate the rate-writing
// routes at the platform level. It does NOT by itself mean the caller may
// write to any *particular* property — routes that take a propertyId/unitId
// must additionally call requirePropertyAccess/requireUnitAccess so a
// Regional Manager admin on 5 properties can't (accidentally or otherwise)
// write rates for a 6th they aren't assigned to.
function requireAdmin(request) {
    const user = requireUser(request);
    if (!user.isAdmin) {
        const err = new Error('Only Guest Suites admins can do this.');
        err.statusCode = 403;
        throw err;
    }
    return user;
}

async function requirePropertyAccess(user, propertyId) {
    const result = await query('SELECT YardiNumber FROM Properties WHERE PropertyId = @propertyId', { propertyId });
    const property = result.recordset[0];
    if (!property || !user.yardiNumbers.includes(property.YardiNumber)) {
        const err = new Error('You do not have access to this property.');
        err.statusCode = 403;
        throw err;
    }
}

async function requireUnitAccess(user, unitId) {
    const result = await query(`
        SELECT p.YardiNumber
        FROM Units u JOIN Properties p ON p.PropertyId = u.PropertyId
        WHERE u.UnitId = @unitId
    `, { unitId });
    const property = result.recordset[0];
    if (!property || !user.yardiNumbers.includes(property.YardiNumber)) {
        const err = new Error('You do not have access to this unit.');
        err.statusCode = 403;
        throw err;
    }
}

module.exports = { getUser, requireUser, requireAdmin, requirePropertyAccess, requireUnitAccess };
