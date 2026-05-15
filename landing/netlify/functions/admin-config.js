// Public bootstrap config for the admin SPA. Returns the Supabase URL and
// anon key so the page can call supabase-js without hardcoding either value.
// The anon key is safe to expose — Supabase's whole auth model assumes it
// lives in client code. RLS protects the data; service-role only runs here
// in Functions.

const { json, corsHeaders, handleOptions, SUPABASE_URL } = require("./_supabase");

exports.handler = async (event) => {
  const opt = handleOptions(event);
  if (opt) return opt;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!anonKey) {
    return json(500, { error: "SUPABASE_ANON_KEY env var is not set in Netlify" });
  }
  return {
    statusCode: 200,
    headers: { ...corsHeaders(), "Cache-Control": "public, max-age=300" },
    body: JSON.stringify({ supabase_url: SUPABASE_URL, supabase_anon_key: anonKey }),
  };
};
