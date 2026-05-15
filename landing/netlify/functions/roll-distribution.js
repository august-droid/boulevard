// Scheduled function — runs the rollup + promotion-score recompute hourly.
//
// Why this instead of pg_cron: enabling pg_cron on Supabase requires
// dashboard-level admin action. Netlify scheduled functions ship with the
// site, so the rollup is live the moment you deploy.
//
// Schedule: top of every hour. Adjust by editing the `schedule` export.
// Adjust the schedule from the Netlify dashboard or by editing this file.

const SUPABASE_URL = process.env.SUPABASE_URL || "https://psmgmshfcjxgujfmsfcx.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function callRpc(name, body) {
  if (!SERVICE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set in Netlify env");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rpc ${name} ${res.status}: ${text}`);
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

const handler = async () => {
  const startedAt = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  try {
    await callRpc("roll_song_daily_stats", { target_day: today });
    const updated = await callRpc("compute_promotion_scores", {});
    const elapsedMs = Date.now() - startedAt;
    console.log(JSON.stringify({ ok: true, day: today, updated, elapsedMs }));
    return { statusCode: 200, body: JSON.stringify({ ok: true, day: today, updated, elapsedMs }) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ ok: false, err: msg }));
    return { statusCode: 500, body: JSON.stringify({ ok: false, err: msg }) };
  }
};

// Netlify scheduled-function config. Cron format: minute hour dom month dow.
// "0 * * * *" = top of every hour. Promotion is slow-moving — hourly is fine.
exports.handler = handler;
exports.config = { schedule: "0 * * * *" };
