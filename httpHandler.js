// Wraps a Functions v4 handler so errors thrown with a `.statusCode` (401 from
// requireUser, 403 from requireAdmin, 404 for "not found", 400 for bad input)
// come back as that status with just the message, instead of a generic 500
// with a stack trace leaking to the client.
function withErrorHandling(handler) {
    return async (request, context) => {
        try {
            return await handler(request, context);
        } catch (err) {
            const status = err.statusCode || 500;
            if (status === 500) {
                context.error(err);
            }
            return { status, jsonBody: { error: status === 500 ? 'Something went wrong.' : err.message } };
        }
    };
}

module.exports = { withErrorHandling };
