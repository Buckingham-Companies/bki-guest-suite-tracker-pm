// Azure Static Web Apps injects this header on every request it proxies to a
// linked Functions API, once Okta is wired up as the auth provider in
// staticwebapp.config.json. It is NOT present when the Functions API is
// called directly (bypassing the SWA front door) — see the deployment note in
// infra/README.md about locking the Function App down to that.
const PRINCIPAL_HEADER = 'x-ms-client-principal';

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
        roles
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

function requireAdmin(request) {
    const user = requireUser(request);
    if (!user.isAdmin) {
        const err = new Error('Only Guest Suites admins can do this.');
        err.statusCode = 403;
        throw err;
    }
    return user;
}

module.exports = { getUser, requireUser, requireAdmin };
