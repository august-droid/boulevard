// Server-side TikTok CompleteRegistration conversion (Events API).
//
// Why this exists: the browser TikTok Pixel (the ttq snippet in
// listen/index.html) is dropped by ad-blockers and Safari ITP, so TikTok
// receives only a fraction of real sign-ups. This function fires the SAME
// conversion server-to-server, where nothing can block it.
//
// The web app calls POST /api/tiktok-event right after a sign-up succeeds,
// passing the shared `event_id` so TikTok deduplicates the browser event and
// this server event into a single conversion.
//
// Correctness guarantees:
//   • Fires only for a verified, NON-anonymous Supabase user (a real account).
//   • Idempotent — the tiktok_registration_events table has user_id as its
//     primary key, so a returning login (or any double-fire) can never send
//     a second event.
//
// This function must NEVER affect the sign-up itself: the caller treats it as
// fire-and-forget and every failure path here returns a benign 200.
//
// Required env (Netlify):
//   TIKTOK_ACCESS_TOKEN      — Events API token (Events Manager → Settings).
//   SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, SUPABASE_URL.
// Optional env:
//   TIKTOK_PIXEL_ID          — defaults to the Boulevard pixel below.
//   TIKTOK_TEST_EVENT_CODE   — set to route events to the Events Manager
//                              "Test Events" tab; unset for production.

const crypto = require("crypto");
const { sb, json, handleOptions, verifyUser } = require("./_supabase");

const TIKTOK_API = "https://business-api.tiktok.com/open_api/v1.3/event/track/";
const PIXEL_ID = process.env.TIKTOK_PIXEL_ID || "D84T1TJC77U6I10KKE1G";
const ACCESS_TOKEN = process.env.TIKTOK_ACCESS_TOKEN;
const TEST_EVENT_CODE = process.env.TIKTOK_TEST_EVENT_CODE || "";

// TikTok requires identifiers SHA-256 hashed, lowercased and trimmed.
function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// Real visitor IP. Netlify sets x-nf-client-connection-ip; x-forwarded-for
// is the fallback (its first entry is the original client).
function clientIp(headers) {
  return (
    headers["x-nf-client-connection-ip"] ||
    (headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    ""
  );
}

exports.handler = async (event) => {
  const opt = handleOptions(event);
  if (opt) return opt;
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "method not allowed" });
  }

  // 1) Identify the caller from their Supabase JWT.
  let user;
  try {
    user = await verifyUser(event);
  } catch (e) {
    console.error("[tiktok-event] JWT verification error:", e.message);
    return json(200, { ok: false, skipped: "auth_error" });
  }
  if (!user || !user.id) {
    return json(200, { ok: false, skipped: "no_user" });
  }

  // 2) An anonymous session is not a registration.
  if (user.is_anonymous === true) {
    return json(200, { ok: false, skipped: "anonymous" });
  }

  // 3) Parse the client payload.
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(200, { ok: false, skipped: "bad_body" });
  }
  const eventId = String(body.event_id || "").trim();
  if (!eventId) {
    return json(200, { ok: false, skipped: "no_event_id" });
  }
  const method = body.method ? String(body.method) : null;

  // 4) Idempotency gate. INSERT ... ON CONFLICT DO NOTHING: the row is
  //    created only the first time we ever see this user. A returning login
  //    conflicts on the user_id primary key and is skipped here — this is
  //    what guarantees "fire only on first registration, never on re-login".
  let firstTime = false;
  try {
    const inserted = await sb("/tiktok_registration_events", {
      method: "POST",
      headers: { Prefer: "return=representation,resolution=ignore-duplicates" },
      body: JSON.stringify({
        user_id: user.id,
        event_id: eventId,
        signup_method: method,
      }),
    });
    // A fresh insert returns our row (carrying the event_id we just sent);
    // a conflict returns an empty array.
    firstTime =
      Array.isArray(inserted) &&
      inserted.length > 0 &&
      inserted[0].event_id === eventId;
  } catch (e) {
    // Table missing / DB unreachable — do not send (we cannot dedupe).
    console.error("[tiktok-event] idempotency insert failed:", e.message);
    return json(200, { ok: false, skipped: "db_error" });
  }
  if (!firstTime) {
    console.log(
      `[tiktok-event] user=${user.id} already recorded — skipping (returning login or duplicate)`
    );
    return json(200, { ok: true, skipped: "duplicate" });
  }

  // 5) Build and send the TikTok Events API payload.
  if (!ACCESS_TOKEN) {
    console.warn(
      "[tiktok-event] TIKTOK_ACCESS_TOKEN not set — user recorded but event NOT sent"
    );
    return json(200, { ok: false, skipped: "no_token" });
  }

  const userData = {
    ip: clientIp(event.headers),
    user_agent: event.headers["user-agent"] || "",
  };
  if (user.email) {
    userData.email = sha256(String(user.email).trim().toLowerCase());
  }
  if (body.ttclid) userData.ttclid = String(body.ttclid);
  if (body.ttp) userData.ttp = String(body.ttp);

  const payload = {
    event_source: "web",
    event_source_id: PIXEL_ID,
    data: [
      {
        event: "CompleteRegistration",
        event_time: Number(body.event_time) || Math.floor(Date.now() / 1000),
        event_id: eventId,
        user: userData,
        page: { url: body.url ? String(body.url) : "" },
      },
    ],
  };
  if (TEST_EVENT_CODE) payload.test_event_code = TEST_EVENT_CODE;

  let tiktokStatus = "unknown";
  try {
    const res = await fetch(TIKTOK_API, {
      method: "POST",
      headers: {
        "Access-Token": ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const result = await res.json().catch(() => ({}));
    // TikTok replies { code: 0, message: "OK" } on success.
    if (res.ok && result.code === 0) {
      tiktokStatus = "ok";
      console.log(
        `[tiktok-event] SENT CompleteRegistration user=${user.id} event_id=${eventId} method=${method} code=0`
      );
    } else {
      tiktokStatus = `error:${result.code != null ? result.code : res.status}`;
      console.error(
        `[tiktok-event] FAILED user=${user.id} event_id=${eventId} httpStatus=${res.status} code=${result.code} message=${result.message}`
      );
    }
  } catch (e) {
    tiktokStatus = "exception";
    console.error("[tiktok-event] TikTok API request threw:", e.message);
  }

  // Record the outcome on the row (best-effort — never fatal).
  try {
    await sb(
      `/tiktok_registration_events?user_id=eq.${encodeURIComponent(user.id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ tiktok_status: tiktokStatus }),
      }
    );
  } catch (e) {
    console.error("[tiktok-event] status write-back failed:", e.message);
  }

  return json(200, { ok: tiktokStatus === "ok", status: tiktokStatus });
};
