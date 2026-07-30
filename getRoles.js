const { app } = require('@azure/functions');

// Azure Static Web Apps calls this after every Okta login (configured as
// auth.rolesSource in staticwebapp.config.json) and merges whatever roles it
// returns into the user's principal — that's where userRoles in auth.js comes
// from. Okta must be configured to put the user's group memberships into a
// "groups" claim on the ID token (see infra/README.md) for this to see them.
const ADMIN_GROUP = 'GuestSuites-Admin';

app.http('getRoles', {
    methods: ['POST'],
    route: 'getRoles',
    authLevel: 'anonymous',
    handler: async (request) => {
        const body = await request.json();
        const claims = body.claims || [];
        const groupsClaim = claims.find(c => c.typ === 'groups' || c.typ === 'okta_groups');
        const groups = groupsClaim ? (Array.isArray(groupsClaim.val) ? groupsClaim.val : [groupsClaim.val]) : [];

        const roles = groups.includes(ADMIN_GROUP) ? ['admin'] : [];
        return { jsonBody: { roles } };
    }
});
