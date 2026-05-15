// Single endpoint for the four mutating actions in the admin dashboard:
//   POST /api/songs/:id/approve     { rating? }
//   POST /api/songs/:id/reject      { reasons[]? }
//   POST /api/songs/:id/regenerate  {}
//   POST /api/songs/:id/rate        { rating: 1..10 }
//
// Netlify routes /api/songs/:id/:action to this function via netlify.toml.
// We parse the :id and :action from the path.

const { sb, json, requireAdmin, handleOptions } = require("./_supabase");

const REJECT_REASONS = new Set([
  "vocal_ai", "generic", "weak_hook", "off_genre", "bad_mix",
  "wrong_gender_style", "vocal_gender_mismatch",
  // Hook + title tuning auto-flags (mirror review_flags values on songs).
  "hook_title_mismatch",
  "hook_missing", "title_mismatch", "chorus_forced",
  "title_random_sounding", "lyrics_generic",
  "boring", "low_quality", "too_repetitive", "other",
]);

async function getSong(id) {
  const rows = await sb(`/songs?id=eq.${encodeURIComponent(id)}&select=id,queue_id&limit=1`);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function updateSong(id, patch) {
  await sb(`/songs?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

async function updateQueue(queueId, patch) {
  await sb(`/songs_queue?id=eq.${encodeURIComponent(queueId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

async function logEvent(queueId, event, payload) {
  try {
    await sb("/queue_events", {
      method: "POST",
      body: JSON.stringify({
        queue_id: queueId,
        worker_id: "dashboard",
        event,
        payload,
      }),
    });
  } catch {
    // best-effort — don't fail the action if logging fails
  }
}

exports.handler = async (event) => {
  const opt = handleOptions(event);
  if (opt) return opt;
  const auth = await requireAdmin(event);
  if (auth.error) return auth.error;

  if (event.httpMethod !== "POST") {
    return json(405, { error: "method not allowed" });
  }

  // Route is /api/songs/:id/:action — extract from event.path
  // Netlify path comes through as e.g. "/api/songs/abc-123/approve"
  const path = event.path || "";
  const match = path.match(/\/songs\/([^/]+)\/([^/?]+)/);
  if (!match) return json(400, { error: "bad path; expected /songs/:id/:action" });
  const id = match[1];
  const action = match[2];

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: "invalid JSON body" });
  }

  try {
    const song = await getSong(id);
    if (!song) return json(404, { error: "song not found" });

    if (action === "approve") {
      const rating = typeof body.rating === "number" ? body.rating : null;
      await updateSong(id, {
        approval_status: "approved",
        is_live: true,
        approved_by_human: true,
        rating,
        reviewed_at: new Date().toISOString(),
        reviewed_by: auth.user?.email || "admin",
      });
      if (song.queue_id) {
        await updateQueue(song.queue_id, { status: "approved", approved: true, rating });
        await logEvent(song.queue_id, "approved", { songId: id, rating });
      }
      return json(200, { ok: true });
    }

    if (action === "reject") {
      const reasons = Array.isArray(body.reasons)
        ? body.reasons.filter((r) => typeof r === "string" && REJECT_REASONS.has(r))
        : [];
      await updateSong(id, {
        approval_status: "rejected",
        is_live: false,
        // Reset the human-approval bit so the song stops matching the
        // catalog SELECT policy. Without this, a song that was approved
        // and later rejected stayed visible via RLS (loadCatalog filtered
        // it out client-side, but the row was still leaking).
        approved_by_human: false,
        reviewed_at: new Date().toISOString(),
      });
      if (song.queue_id) {
        await updateQueue(song.queue_id, {
          status: "rejected",
          approved: false,
          rejection_reasons: reasons.length ? reasons : null,
        });
        await logEvent(song.queue_id, "rejected", { songId: id, reasons });
      }
      return json(200, { ok: true });
    }

    if (action === "regenerate") {
      await updateSong(id, {
        approval_status: "regenerate",
        is_live: false,
        approved_by_human: false,
        reviewed_at: new Date().toISOString(),
      });
      if (song.queue_id) {
        // Intentionally narrow: we only reset what's needed to re-run the
        // worker. song_concept / intended_title / intended_hook_phrase /
        // emotional_core stay put — Boulevard's pre-decided lyric intent
        // survives a regen so the new take stays on-concept. If the
        // reviewer wants a different concept, they reject (not regen) and
        // a fresh queue row gets created by the next batch.
        await updateQueue(song.queue_id, {
          status: "pending",
          attempts: 0,
          error_message: null,
          task_id: null,
        });
        await logEvent(song.queue_id, "regenerated", { songId: id });
      }
      return json(200, { ok: true });
    }

    if (action === "rate") {
      const rating = body.rating;
      if (typeof rating !== "number" || rating < 1 || rating > 10) {
        return json(400, { error: "rating must be a number 1-10" });
      }
      await updateSong(id, { rating });
      return json(200, { ok: true });
    }

    if (action === "retitle") {
      // Reviewer override: approve-with-rename in one go. The override is
      // persisted into both `title` (so the app shows it) and
      // `human_title_override` (so subsequent regenerations know not to
      // rewrite it back to the derived/intended title).
      const newTitle = typeof body.title === "string" ? body.title.trim() : "";
      if (newTitle.length < 1 || newTitle.length > 80) {
        return json(400, { error: "title must be 1-80 characters" });
      }
      await updateSong(id, {
        title: newTitle,
        human_title_override: newTitle,
      });
      if (song.queue_id) {
        await logEvent(song.queue_id, "retitled", { songId: id, newTitle });
      }
      return json(200, { ok: true });
    }

    return json(400, { error: `unknown action: ${action}` });
  } catch (e) {
    return json(e.status || 500, { error: e.message });
  }
};
