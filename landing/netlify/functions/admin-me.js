// Returns { user, admin } for the current bearer JWT, or 401. The dashboard
// hits this right after sign-in to confirm the user is allowlisted before
// rendering the queue.

const { json, handleOptions, requireAdmin } = require("./_supabase");

exports.handler = async (event) => {
  const opt = handleOptions(event);
  if (opt) return opt;
  const auth = await requireAdmin(event);
  if (auth.error) return auth.error;
  return json(200, {
    user: { id: auth.user.id, email: auth.user.email },
    admin: {
      id: auth.admin.id,
      email: auth.admin.email,
      role: auth.admin.role,
      invited_by_email: auth.admin.invited_by_email,
      invited_at: auth.admin.invited_at,
      accepted_at: auth.admin.accepted_at,
    },
  });
};
