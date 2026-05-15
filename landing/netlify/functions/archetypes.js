const { sb, json, requireAdmin, handleOptions } = require("./_supabase");

exports.handler = async (event) => {
  const opt = handleOptions(event);
  if (opt) return opt;
  const auth = await requireAdmin(event);
  if (auth.error) return auth.error;
  try {
    const rows = await sb("/archetype_performance?select=*&order=performance_score.desc&limit=50");
    return json(200, { rows });
  } catch (e) {
    return json(e.status || 500, { error: e.message });
  }
};
