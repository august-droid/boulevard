// Team management for the admin dashboard.
//
//   GET    /api/admin/team           list all admins + pending invites
//   POST   /api/admin/team           { email } → create pending invite row
//                                    and trigger Supabase auth invite email
//   DELETE /api/admin/team/:id       revoke admin / cancel invite
//
// Auth: every action requires the caller to already be an admin.

const { sb, authAdmin, json, handleOptions, requireAdmin } = require("./_supabase");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function listTeam() {
  const rows = await sb(
    "/admin_users?select=id,email,role,invited_by_email,invited_at,accepted_at,last_seen_at&order=invited_at.desc"
  );
  return rows || [];
}

exports.handler = async (event) => {
  const opt = handleOptions(event);
  if (opt) return opt;
  const auth = await requireAdmin(event);
  if (auth.error) return auth.error;

  const method = event.httpMethod;
  const path = event.path || "";

  try {
    if (method === "GET") {
      const rows = await listTeam();
      return json(200, { rows });
    }

    if (method === "POST") {
      let body = {};
      try { body = event.body ? JSON.parse(event.body) : {}; } catch {
        return json(400, { error: "invalid JSON body" });
      }
      const email = String(body.email || "").trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return json(400, { error: "invalid email" });

      // Refuse duplicates — case-insensitive on email.
      const existing = await sb(
        `/admin_users?email=eq.${encodeURIComponent(email)}&limit=1`
      );
      if (Array.isArray(existing) && existing.length) {
        return json(409, { error: "already on the team", row: existing[0] });
      }

      // Insert the allowlist row first so the invitee is approved the moment
      // they sign in, regardless of whether the Supabase invite email lands.
      const created = await sb("/admin_users", {
        method: "POST",
        body: JSON.stringify({
          email,
          role: "admin",
          invited_by: auth.user.id,
          invited_by_email: auth.user.email,
        }),
      });
      const row = Array.isArray(created) && created[0] ? created[0] : null;

      // Best-effort: ask Supabase to send the magic-link invite email. If
      // the user already exists this 422s — that's fine, they can just sign
      // in normally and we'll match them by email on first request.
      let emailSent = false;
      let emailError = null;
      try {
        await authAdmin("/admin/invite", {
          method: "POST",
          body: JSON.stringify({ email }),
        });
        emailSent = true;
      } catch (e) {
        emailError = e.message;
      }

      return json(200, { row, email_sent: emailSent, email_error: emailError });
    }

    if (method === "DELETE") {
      // Path is /api/admin/team/:id — match the trailing uuid.
      const m = path.match(/\/team\/([0-9a-f-]{36})\/?$/i);
      if (!m) return json(400, { error: "bad path; expected /team/:id" });
      const id = m[1];

      // Stop admins from locking themselves out by yanking their own row.
      if (id === auth.admin.id) {
        return json(400, { error: "cannot remove yourself" });
      }

      await sb(`/admin_users?id=eq.${id}`, { method: "DELETE" });
      return json(200, { ok: true });
    }

    return json(405, { error: "method not allowed" });
  } catch (e) {
    return json(e.status || 500, { error: e.message });
  }
};
