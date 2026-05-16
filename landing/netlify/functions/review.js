const { sb, json, requireAdmin, handleOptions } = require("./_supabase");

const FIELDS = [
  "id", "title", "artist_name", "genre", "genres", "mood", "bpm",
  "duration_seconds", "audio_url", "cover_url", "lyrics",
  "rating", "approval_status", "replayability_score",
  "energy_score", "vocal_type", "voice_gender", "similarity_cluster",
  "created_at", "queue_id",
  // Microtag + distribution columns surfaced in the dashboard.
  "microtags", "primary_listener_contexts", "skip_risks",
  "hook_strength", "mainstream_fit", "uniqueness_score_v2",
  "distribution_stage", "promotion_score", "impression_count",
  "lifetime_unique_listeners", "suppression_reason",
  // Pre-decided lyric intent — surfaced so the reviewer can see what
  // Boulevard asked for and whether Sunor honored the hook directive.
  "song_concept", "intended_title", "intended_hook_phrase",
  "emotional_core", "needs_review_hook_mismatch",
  // Lyric tuning pass 2: auto-flags + chorus-repeat count + human override.
  "chorus_repeat_count", "review_flags", "human_title_override",
].join(",");

exports.handler = async (event) => {
  const opt = handleOptions(event);
  if (opt) return opt;
  const auth = await requireAdmin(event);
  if (auth.error) return auth.error;
  try {
    const q = event.queryStringParameters || {};
    const genre = q.genre || "";
    const minRating = parseInt(q.minRating || "0", 10);
    const search = (q.search || "").trim();
    const status = (q.status || "pending").trim();
    const limit = Math.min(parseInt(q.limit || "50", 10), 200);

    const parts = [`select=${FIELDS}`, "order=created_at.desc", `limit=${limit}`];
    if (status && status !== "all") parts.push(`approval_status=eq.${encodeURIComponent(status)}`);
    if (genre) parts.push(`genre=eq.${encodeURIComponent(genre)}`);
    if (minRating > 0) parts.push(`rating=gte.${minRating}`);
    if (search) parts.push(`title=ilike.${encodeURIComponent("%" + search + "%")}`);

    const rows = await sb(`/songs?${parts.join("&")}`);
    return json(200, { rows });
  } catch (e) {
    return json(e.status || 500, { error: e.message });
  }
};
