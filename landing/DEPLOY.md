# Boulevard — Netlify Deployment

This folder is the full static site for **boulevardai.app** plus the admin
review panel at **/admin** (powered by Netlify Functions).

## What to deploy

Drag-and-drop or `git push` the **`landing/`** folder to Netlify. Netlify will
read `netlify.toml` and configure routing, redirects, headers, and Functions
automatically.

```
landing/
├── index.html               public homepage
├── articles/                10 SEO/AEO articles
│   ├── index.html           articles list page
│   └── *.html
├── admin/index.html         admin review dashboard (token-gated)
├── netlify/functions/       Netlify Functions (admin API)
├── icons/                   favicon set + OG image
├── styles.css               full site CSS (versioned via ?v=…)
├── netlify.toml             redirects, headers, functions config
├── robots.txt
└── sitemap.xml
```

## Environment variables to set in Netlify

In Netlify dashboard → Site settings → **Environment variables** → Add:

| Variable | Required for | Value |
| --- | --- | --- |
| `SUPABASE_URL` | /admin API | `https://psmgmshfcjxgujfmsfcx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | /admin API | Copy from Supabase → Project Settings → API |
| `DASHBOARD_ADMIN_TOKEN` | /admin API | Any long random string; what you'll paste at `/admin` to log in |

**Without these vars, the public site still works.** Only the admin
review tool needs them. The public homepage and articles are pure static.

After setting the vars, hit **Redeploy** so Functions pick them up.

## Using the admin panel

1. After deploy, visit `https://boulevardai.app/admin`.
2. Paste the `DASHBOARD_ADMIN_TOKEN` you set in Netlify.
3. You get the same approve / reject / regenerate / rate UI you had locally,
   just served from the internet.

Sessions are stored in `sessionStorage` (per-tab, cleared on tab close).

The token is sent as `Authorization: Bearer <token>` to four Netlify
Function endpoints:

- `/api/queue-stats`
- `/api/archetypes`
- `/api/review`
- `/api/songs/:id/:action` (approve | reject | regenerate | rate)

`netlify.toml` rewrites those to `/.netlify/functions/*`. Each function
validates the token before doing anything.

## Editing articles

Articles are generated from `articles/content.py`. To change one:

```bash
cd landing/articles
# edit content.py
python3 _generate.py
```

This regenerates the 10 HTML files. Commit and redeploy. Don't edit the
generated `.html` files directly — they'll be overwritten on the next run.

## Editing styles

`styles.css` covers everything: public site, articles, legal pages, admin
shell. After editing, bump the version query in HTML files (search for
`styles.css?v=` and increment) so users get the new CSS without waiting
for cache to expire. The `netlify.toml` already serves `/styles.css` with
`max-age=0, must-revalidate` so updates ship instantly anyway, but the
versioned URL is belt-and-suspenders.

## Robots / SEO

- `robots.txt` allows all major crawlers including GPTBot, ClaudeBot,
  PerplexityBot, Google-Extended, Applebot-Extended — Boulevard is an AI
  brand and we want our content surfaced in answer engines.
- `/admin/*` is `noindex, nofollow` via `X-Robots-Tag` header.
- `sitemap.xml` lists the homepage, articles index, all 10 articles, and
  legal pages.
- Open Graph + Twitter Card meta tags on every page.
- JSON-LD schema: Organization, MobileApplication, WebSite, FAQPage on
  the homepage; Article + FAQPage on each article page.

## Common gotchas

- **Admin panel shows "stats unavailable" or "error: unauthorized"** → the
  env vars aren't set yet, or `DASHBOARD_ADMIN_TOKEN` doesn't match what
  you pasted in the UI.
- **Old CSS still loading after a deploy** → hard-refresh once. The
  versioned `?v=` query in HTML force-busts pinned caches.
- **/articles/* returns 404** → make sure `netlify.toml` is at the root of
  the deployed folder. Netlify reads it only from the publish root.
