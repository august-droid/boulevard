// Shared helpers for Boulevard admin Netlify Functions.
//
// We talk to Supabase via its REST/PostgREST endpoint with the service-role
// key. No @supabase/supabase-js dependency — keeps the function bundle tiny
// and deploys instantly. Service-role key bypasses RLS, so every function
// must enforce admin auth at the top.
//
// Auth model (2026-05-15): the dashboard signs users in via Supabase Auth
// (email/password or Google OAuth) and sends the resulting JWT as the
// Authorization header. We verify the JWT by hitting /auth/v1/user, then
// confirm the user is in public.admin_users. The legacy DASHBOARD_ADMIN_TOKEN
// path is gone; admins are managed via the in-app team panel.

const SUPABASE_URL = process.env.SUPABASE_URL || "https://psmgmshfcjxgujfmsfcx.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Comma-separated list of emails that get auto-promoted to admin on first
// sign-in. Used to bootstrap the very first admin before any rows exist in
// admin_users. After that, manage the team from the dashboard.
const BOOTSTRAP_ADMIN_EMAILS = (process.env.BOOTSTRAP_ADMIN_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

function json(statusCode, body) {
  return { statusCode, headers: corsHeaders(), body: JSON.stringify(body) };
}

function handleOptions(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }
  return null;
}

async function sb(path, init = {}) {
  if (!SERVICE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY env var is not set in Netlify");
  }
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: init.body ? "return=representation" : "",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = (body && body.message) || (typeof body === "string" ? body : res.statusText);
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Call a Supabase /auth/v1/* endpoint with the service-role key. Used for
// admin operations like inviteUserByEmail.
async function authAdmin(path, init = {}) {
  if (!SERVICE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY env var is not set in Netlify");
  }
  const res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = (body && body.msg) || (body && body.message) ||
      (typeof body === "string" ? body : res.statusText);
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Verify the bearer JWT by asking Supabase who it belongs to. Cheap and
// rock-solid — Supabase enforces signature + expiry + revocation for us.
async function verifyUser(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  if (!ANON_KEY) {
    throw new Error("SUPABASE_ANON_KEY env var is not set in Netlify");
  }
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

// Returns { user, admin } if the request is from a known admin, else null.
// Auto-promotes bootstrap emails on first sign-in and links pre-invited rows
// (rows with the email but no user_id yet) to the auth user.
async function getAdminFromRequest(event) {
  const user = await verifyUser(event);
  if (!user || !user.email) return null;
  const email = String(user.email).toLowerCase();

  const existing = await sb(
    `/admin_users?or=(user_id.eq.${encodeURIComponent(user.id)},email.eq.${encodeURIComponent(email)})&limit=1`
  );
  let admin = Array.isArray(existing) && existing.length ? existing[0] : null;

  if (admin) {
    // Pre-invited row: link to auth user on first sign-in.
    if (!admin.user_id || !admin.accepted_at) {
      const patched = await sb(`/admin_users?id=eq.${admin.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          user_id: user.id,
          email,
          accepted_at: admin.accepted_at || new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
        }),
      });
      admin = Array.isArray(patched) && patched[0] ? patched[0] : admin;
    } else {
      // Cheap heartbeat — fire-and-forget, don't block the request.
      sb(`/admin_users?id=eq.${admin.id}`, {
        method: "PATCH",
        body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
      }).catch(() => {});
    }
    return { user, admin };
  }

  // Bootstrap path: env-listed emails become admin on first sign-in.
  if (BOOTSTRAP_ADMIN_EMAILS.includes(email)) {
    const created = await sb("/admin_users", {
      method: "POST",
      body: JSON.stringify({
        email,
        user_id: user.id,
        role: "admin",
        invited_by_email: "bootstrap",
        accepted_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      }),
    });
    admin = Array.isArray(created) && created[0] ? created[0] : null;
    return admin ? { user, admin } : null;
  }

  return null;
}

// Guard helper for handlers. Returns a response object to short-circuit on
// failure, or { user, admin } on success.
async function requireAdmin(event) {
  try {
    const ctx = await getAdminFromRequest(event);
    if (!ctx) return { error: json(401, { error: "unauthorized" }) };
    return ctx;
  } catch (e) {
    return { error: json(500, { error: e.message }) };
  }
}

module.exports = {
  sb,
  authAdmin,
  json,
  corsHeaders,
  handleOptions,
  requireAdmin,
  SUPABASE_URL,
};
