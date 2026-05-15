// Scheduled function — every 2 minutes, drain pending notifications and
// deliver them via the Expo Push API.
//
// Triggers in Postgres (notify_on_reply / notify_on_like) write rows with
// pushed_at = null. This function picks up the unsent batch, joins each
// recipient against push_tokens, posts to Expo, then stamps pushed_at.
//
// Bad / expired tokens (Expo response "DeviceNotRegistered") are deleted
// from push_tokens so we stop retrying them.

const SUPABASE_URL = process.env.SUPABASE_URL || "https://psmgmshfcjxgujfmsfcx.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_PER_RUN = 100; // Expo accepts batches up to 100

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
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
  if (!res.ok) throw new Error(`sb ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// Look up a username (or the boulevard_xxxxx fallback) for actor display.
function actorLabel(profile, actorId) {
  if (profile?.username) return profile.username;
  if (profile?.display_name) return profile.display_name;
  return `boulevard_${actorId.slice(0, 6)}`;
}

const handler = async () => {
  const startedAt = Date.now();
  if (!SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "SUPABASE_SERVICE_ROLE_KEY not set" }) };
  }
  try {
    // 1. Pull pending notifications.
    const pending = await sb(
      `/notifications?select=*&pushed_at=is.null&order=created_at.asc&limit=${MAX_PER_RUN}`
    );
    if (!pending || pending.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, sent: 0, elapsedMs: Date.now() - startedAt }) };
    }

    // 2. Fan in push tokens + actor profiles in two batches.
    const recipientIds = Array.from(new Set(pending.map((n) => n.recipient_id)));
    const actorIds = Array.from(new Set(pending.map((n) => n.actor_id)));
    const tokenIn = recipientIds.map((id) => `"${id}"`).join(",");
    const actorIn = actorIds.map((id) => `"${id}"`).join(",");

    const [tokens, profiles] = await Promise.all([
      sb(`/push_tokens?select=user_id,expo_token,platform&user_id=in.(${tokenIn})`),
      sb(`/user_profiles?select=user_id,username,display_name&user_id=in.(${actorIn})`),
    ]);

    const tokenByUser = new Map((tokens || []).map((r) => [r.user_id, r.expo_token]));
    const profileByUser = new Map((profiles || []).map((r) => [r.user_id, r]));

    // 3. Build Expo messages. Skip recipients with no token.
    const messages = [];
    const messageMeta = []; // parallel array — notification ids
    for (const n of pending) {
      const expoToken = tokenByUser.get(n.recipient_id);
      if (!expoToken) {
        // No token on file. Mark pushed_at anyway so we don't retry forever.
        messageMeta.push({ id: n.id, skipped: "no_token" });
        continue;
      }
      const actor = profileByUser.get(n.actor_id);
      const who = actorLabel(actor, n.actor_id);
      let title, body;
      if (n.type === "comment_reply") {
        title = `${who} replied to you`;
        body = n.body_preview || "Tap to view the reply";
      } else {
        title = `${who} liked your comment`;
        body = n.body_preview ? `"${n.body_preview}"` : "Tap to see it";
      }
      messages.push({
        to: expoToken,
        title,
        body,
        sound: "default",
        data: {
          notification_id: n.id,
          type: n.type,
          song_id: n.song_id,
          comment_id: n.comment_id,
          parent_comment_id: n.parent_comment_id,
        },
        priority: "high",
        channelId: "default",
      });
      messageMeta.push({ id: n.id, expoToken });
    }

    // 4. Dispatch to Expo if we have anything to send.
    let expoResults = [];
    if (messages.length > 0) {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(messages),
      });
      const json = await res.json().catch(() => ({}));
      expoResults = json?.data || [];
    }

    // 5. Stamp pushed_at on every processed notification. Also evict dead
    //    tokens so future runs don't retry them.
    const deadTokens = new Set();
    let resultIdx = 0;
    const idsToMark = [];
    for (const meta of messageMeta) {
      idsToMark.push(meta.id);
      if (meta.skipped) continue;
      const result = expoResults[resultIdx++];
      if (result?.status === "error" && result?.details?.error === "DeviceNotRegistered") {
        deadTokens.add(meta.expoToken);
      }
    }
    if (idsToMark.length > 0) {
      const idsIn = idsToMark.map((id) => `"${id}"`).join(",");
      await sb(`/notifications?id=in.(${idsIn})`, {
        method: "PATCH",
        body: JSON.stringify({ pushed_at: new Date().toISOString() }),
      });
    }
    if (deadTokens.size > 0) {
      const tokenIn2 = [...deadTokens].map((t) => `"${t}"`).join(",");
      await sb(`/push_tokens?expo_token=in.(${tokenIn2})`, { method: "DELETE" });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        sent: messages.length,
        marked: idsToMark.length,
        dead_tokens: deadTokens.size,
        elapsedMs: Date.now() - startedAt,
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ ok: false, err: msg }));
    return { statusCode: 500, body: JSON.stringify({ ok: false, err: msg }) };
  }
};

exports.handler = handler;
// Every 2 minutes. Notifications feel near-realtime without becoming spam.
exports.config = { schedule: "*/2 * * * *" };
