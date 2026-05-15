const { sb, json, requireAdmin, handleOptions } = require("./_supabase");

exports.handler = async (event) => {
  const opt = handleOptions(event);
  if (opt) return opt;
  const auth = await requireAdmin(event);
  if (auth.error) return auth.error;
  try {
    const rows = await sb("/queue_stats?select=*");
    // Distribution stage counts over the approved catalog. Bucketed
    // client-side from a single fetch so we don't fan out 4 queries.
    let stages = { new_test: 0, rising: 0, trending: 0, suppressed: 0 };
    try {
      const songs = await sb("/songs?select=distribution_stage&approved_by_human=eq.true");
      for (const r of songs || []) {
        const s = r.distribution_stage || "new_test";
        stages[s] = (stages[s] || 0) + 1;
      }
    } catch {
      // best-effort — older deployments may not have the column yet
    }
    // Last rollup timestamp — max(updated_at) from song_daily_stats tells us
    // when the hourly Netlify scheduled function last successfully wrote.
    // The dashboard renders a stale-warning if this is > 2h old.
    let last_rollup_at = null;
    try {
      const rows = await sb("/song_daily_stats?select=updated_at&order=updated_at.desc&limit=1");
      if (rows && rows[0]) last_rollup_at = rows[0].updated_at;
    } catch {
      // best-effort
    }
    return json(200, { rows, stages, last_rollup_at });
  } catch (e) {
    return json(e.status || 500, { error: e.message });
  }
};
