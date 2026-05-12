# Boulevard

Mobile-first AI music streaming app. Dark, premium, instant, addictive.

## Stack

- React Native + Expo (SDK 51)
- TypeScript (strict)
- `expo-av` for audio
- Supabase for auth, song catalog, events, taste profile, library
- Anonymous local user id by default; Supabase auth optional

## Run

```bash
npm install
npx expo start
```

Open in iOS Simulator (`i`), Android emulator (`a`), or Expo Go on device.

> The first launch plays from the bundled seed catalog (32 songs streaming from `soundhelix.com`) so the app works with **no Supabase configuration**. Add Supabase to enable cloud sync.

### Supabase (optional)

1. Create a Supabase project.
2. Run `supabase/schema.sql` then `supabase/seed.sql` in the SQL editor.
3. Copy `.env.example` to `.env` and fill in:

```
EXPO_PUBLIC_SUPABASE_URL=...
EXPO_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...   # only used by the importer
```

4. Restart `expo start`.

When env is present, the app loads songs from `public.songs`, logs every interaction to `public.user_events`, and upserts the taste profile in `public.user_taste_profiles`.

### Catalog priority

At launch the app picks its catalog in this order:

1. `public.songs` from Supabase (if env is set and the query returns rows)
2. Bundled local JSON: [src/lib/seed/catalog.json](src/lib/seed/catalog.json) — always shipped
3. Empty (UI shows a loading state — unreachable in practice)

You can replace the bundled JSON manually, or let the importer write it for you.

## Admin: import songs from CSV

```bash
# Drop your songs into ./songs.csv (sample committed alongside the repo)
npm run import:songs

# Options
npm run import:songs -- --file my.csv     # alternate path
npm run import:songs -- --dry-run         # validate only, no writes
npm run import:songs -- --no-json         # skip writing catalog.json
```

The importer:

- Validates every row before writing anything (it refuses partial imports).
- Upserts to `public.songs` using the service role key.
- Writes the same set back to `src/lib/seed/catalog.json` so the bundled app's offline fallback stays in sync.

### CSV format

Header row required. Columns (order doesn't matter):

| column | required | notes |
|---|---|---|
| `title` | ✓ | |
| `audio_url` | ✓ | must be a reachable CDN URL |
| `cover_url` |  | square art recommended |
| `genre` | ✓ | primary genre (single value) |
| `genres` |  | optional, pipe-separated: `pop\|edm` |
| `mood` | ✓ | primary mood |
| `moods` |  | optional, pipe-separated |
| `bpm` |  | optional, integer 30..240 |
| `energy_score` | ✓ | **1..10** scale; stored internally as 0..1 |
| `vocal_type` |  | `instrumental` (default) \| `male` \| `female` \| `mixed` |
| `voice_gender` |  | free text |
| `similarity_cluster` |  | integer; defaults to 0 |
| `activity_fit` |  | pipe-separated; valid: `gym\|focus\|driving\|party\|sleep\|sad\|aggressive\|calm\|late_night\|euphoric` |
| `duration_seconds` | ✓ | positive integer |
| `drop_timestamps` |  | pipe-separated floats |
| `intro_length` |  | float seconds |

**Multi-value cells use `\|` as the separator**, not commas, so the CSV's own commas stay unambiguous.

A working example lives at [songs.csv](songs.csv).

## Generation pipeline (Suno v5.5)

Boulevard's catalog is meant to be **generated**, not manually curated. The pipeline runs server-side and the app only ever sees songs that have already cleared QA.

```
prompts.json  →  Suno v5.5  →  songs_queue (raw_audio_url)
                                     ↓
                              Quality filter
                                     ↓
                approve  →  promote_song_to_catalog()  →  public.songs (status='live')
                review   →  manual queue, status='completed'
                reject   →  status='rejected' with reason
```

### Run it

```bash
# Default — reads ./prompts.json, files everything as 'completed' for manual review
npm run generate:songs

# Process fewer at a time
npm run generate:songs -- --max 5

# Auto-promote any verdict='approve' rows directly to live
npm run generate:songs -- --auto-promote
```

Each prompt entry looks like:

```json
{
  "title": "Atrium Light",
  "genre": "neoclassical",
  "mood": "focused",
  "vocal_gender": "instrumental",
  "target_duration_seconds": 220,
  "suno_prompt": "Slow neoclassical piano with subtle warm strings…"
}
```

### Quality filter

[src/lib/generation/QualityFilter.ts](src/lib/generation/QualityFilter.ts) blends five per-dimension scores into a single `quality_score`:

| dimension | weight | hard floor (auto-reject below) |
|---|---|---|
| `intro_strength` | 0.15 | 0.30 |
| `hook_quality` | 0.25 | 0.30 |
| `vocal_quality` | 0.20 | 0.30 |
| `production_quality` | 0.15 | 0.30 |
| `replayability_score` | 0.25 | 0.30 |

Verdicts:

- `quality_score >= 0.70` → **approve** (promote or hold for manual depending on `--auto-promote`)
- `0.50 <= quality_score < 0.70` → **review** (sits in `status='completed'`)
- below 0.50, or any dimension below its hard floor → **reject** with a structured reason

The thresholds in [QualityFilter.ts](src/lib/generation/QualityFilter.ts) and the SQL function `public.auto_reject_weak_songs()` are mirrored. The SQL function can be scheduled (Supabase → Database → Cron) to scrub `completed` rows that slipped through.

### Manual review (human-approval gate)

**No song ever reaches the app without a human dashboard approval.** The app filters on:

```sql
where is_live = true
  and approval_status = 'approved'
  and approved_by_human = true
```

`approved_by_human` defaults to **false** for everything generated by the pipeline. The only path to flip it true is the Music Factory's review dashboard. Even `promote_song_to_catalog()` writes `approved_by_human=false` — automation can't bypass the gate.

**Dashboard contract** — the boulevard-music-factory review server's "Approve" button MUST run this exact update for the song to reach the app:

```sql
update public.songs
set is_live           = true,
    approval_status   = 'approved',
    approved_by_human = true,
    reviewed_by       = '<reviewer-id-or-handle>',
    reviewed_at       = now()
where id = $1;

-- And mirror on the queue row
update public.songs_queue
set status     = 'approved',
    approved   = true,
    updated_at = now()
where song_id = $1;
```

"Reject" sets `approval_status='rejected'`, leaves `approved_by_human=false`. "Regenerate" puts the queue row back to `pending` with `attempts=0`. The app never sees any of these states.

### In-app review queue (phone-friendly path)

The same approve / reject / regenerate flow is available inside the Boulevard app, gated to admin users. Profile → **Review Queue** opens a modal with:

- Every pending song's cover, title, genre/subgenre/mood/BPM
- The original Suno prompt (helps you spot which archetypes are landing)
- Per-dimension quality scores (Intro / Hook / Vocal / Mix / Replay, 0–100)
- Big **Approve** / **Reject** / **Regen** buttons
- Rate 1–10 — feeds `archetype_performance` for prompt-tuning

#### One-time setup: grant yourself admin

1. Open the app → **Profile**
2. Scroll to "Your user ID" — tap to copy
3. In the Supabase SQL editor, run:
   ```sql
   insert into public.admin_users (user_id) values ('<paste-your-id>');
   ```
4. Restart the app — **Review Queue** now appears on Profile

That's it. From then on you can review from your phone whenever you have 5 minutes. Tap the song's cover to play (uses the same player), tap Approve when it's a keeper, Reject when it isn't, Regenerate to try the prompt again. The row drops out of the queue the moment you act.

The underlying `review_song` RPC is `security definer` and self-guards by checking the caller against `admin_users`, so anonymous mobile users without an admin row get a hard SQL error if they try to call it. **All three flags (`is_live`, `approval_status`, `approved_by_human`) are written atomically** so there's no window where a song is "approved" but missing the human gate.

### Cloudflare R2 (audio hosting)

[scripts/generate-songs.mjs](scripts/generate-songs.mjs) leaves `uploadToR2()` as a stub. Fill it in with `@aws-sdk/client-s3` pointed at R2's S3-compatible endpoint, or with Cloudflare's native REST API. Set:

```
CLOUDFLARE_R2_ACCESS_KEY_ID=
CLOUDFLARE_R2_SECRET_ACCESS_KEY=
CLOUDFLARE_R2_ACCOUNT_ID=
CLOUDFLARE_R2_BUCKET=
CLOUDFLARE_R2_PUBLIC_URL=
```

Until R2 is wired, the pipeline stores Suno's CDN URL directly on the song row — works fine but isn't the long-term path (Suno URLs can rotate; R2 gives you durable + low-cost hosting + custom domain).

## Playback hardening

Things were added on top of the existing player without rewriting it:

- **`AudioPlayer.onLoadFailed`** (additive listener). When a song's audio fails to load — bad URL, network timeout, codec — PlayerContext auto-skips to the next preloaded song. Users never get stuck on a broken row.
- **Background catalog hydration** ([catalogHydration.ts](src/lib/catalog/catalogHydration.ts)). Polls `public.songs` every 4 minutes. New rows (status='live') are merged into the in-memory catalog silently; the recommendation engine picks them up on the next refill. No app restart required.
- **Status filter on catalog load**. Only `status='live'` rows are returned to the app — `pending_review`, `rejected`, `archived` never reach a user.
- **Pagination on load**. `loadCatalog` now pages through `songs` in 500-row chunks (caps at 10k songs) so the app scales past Supabase's default 1000-row limit.

## Bugs fixed in this pass

- **Skip race**: `skip()` now calls `audioRef.current?.suspendCurrent()` before its async work, closing the window where the outgoing song's `didJustFinish` could fire a competing auto-advance.
- **Daily-limit silent fail**: `playSpecific` and `setVibe` now check the limit *before* disrupting the current song. Combined with a new `auth.blockedAttempts` counter that bumps on each blocked attempt, the paywall re-opens every time a user hits the cap (instead of failing silently after first dismissal).
- **Library tap latency**: `LibraryStore.setSaved` and `addRecent` now fire-and-forget the Supabase mirror. Save taps are instant.

## Extension points (for future ML)

The schema and types are designed so a real recommendation/generation loop can plug in without touching app code:

- `songs.suppression_score` (0..1) — recommender already uses this; bump it from server-side analysis
- `songs.quality_score` (0..1) — populated by the generation pipeline
- `songs.launch_score` (0..1) — editorial signal for cold-start
- `song_daily_stats` table — already feeding Explore + the auto-suppression rule
- `songs_queue` carries the full `intro_strength / hook_quality / vocal_quality / production_quality / replayability_score` breakdown — when you train a real model, write into these fields instead of the heuristic and the rest of the pipeline keeps working unchanged

The recommender, queue manager, player, preloader, and event tracker were **not** rewritten — only the catalog source they read from has changed.

## Architecture

```
src/
├── theme/                — colors, spacing, font scale
├── types/                — Song, EventType, TasteProfile, Activity
├── lib/
│   ├── supabase.ts       — typed client (null when env missing)
│   ├── seed/songs.ts     — 32-song bundled catalog
│   ├── audio/
│   │   ├── AudioPlayer   — wraps one expo-av Sound
│   │   └── Preloader     — LRU of decoded next sounds (cap 3)
│   ├── queue/QueueManager — current + next 5..8, drives preloader
│   ├── recommendation/    — rule-based scorer + weighted sampler
│   ├── taste/             — online taste profile updates from signals
│   ├── events/            — buffered Supabase event insert
│   └── library/           — local + Supabase-mirrored Liked/Saved/Recent
├── contexts/
│   ├── AuthContext        — anonymous-by-default, engagement, trial
│   └── PlayerContext      — single source of truth for playback
├── components/            — BottomNav, ProgressBar, SongRow, Icon
├── screens/
│   ├── PlayerFeedScreen   — full-screen swipe player + vibe entry
│   ├── CreateVibeSheet    — bottom sheet, 10 vibes + Surprise me
│   ├── LibraryScreen      — Liked / Saved / Recent / Your Vibes
│   ├── ProfileScreen      — taste summary + AI Taste Profile level
│   └── PaywallScreen      — 3-day trial + monthly/yearly plans
└── navigation/RootNavigator — 3-tab nav (Home / Library / Profile)
```

### Playback / preload

- `AudioPlayer` owns the currently playing `expo-av` `Sound`.
- `Preloader` decodes the next 3 sounds in the background, capped to keep memory bounded on Android.
- `QueueManager` keeps a queue of 5–8 songs, asks a swappable `producer` for replacements when it drains, and tells the preloader which IDs to keep warm.
- On skip: log event → `queue.advance()` → instantly play the preloaded next → refill happens in the background.

### Recommendation

`src/lib/recommendation/RecommendationEngine.ts` scores every candidate song:

- baseline + genre + mood + cluster bonus + vocal preference
- BPM and energy "fit" curves (full credit near user's preference, fading by 25 BPM / 0.4 energy)
- activity scores
- big boost for the active vibe (e.g. Gym, Focus, Late Night)
- penalty for songs played recently
- small exploration noise so the feed doesn't lock in

We then **weighted-sample** from the top window rather than taking the strict max, so the feed stays fresh.

### Taste profile

`src/lib/taste/TasteProfile.ts` maps playback samples to discrete signals:

| Signal              | Weight |
|---------------------|--------|
| skip < 5s           | −2.0   |
| skip < 15s          | −1.0   |
| listen 30s          | +0.6   |
| listen 60s          | +1.2   |
| completion > 70%    | +2.0   |
| like                | +3.0   |
| save                | +3.0   |
| replay              | +4.0   |

Categorical maps (genre, mood, cluster, vocal type, activity) accumulate raw signed weights. Continuous prefs (BPM, energy) use an EMA pulled toward the song's values when the signal is positive.

### Events

`EventTracker` buffers and flushes every 4s (or at buffer cap). Falls back to dropping the buffer in local-only mode. All events also drive in-memory taste updates immediately so the queue reacts within one song.

### Auth / paywall

### Free vs Premium

| | Free | Premium |
|---|---|---|
| Listens / day | **20** (resets at midnight local) | unlimited |
| Personalization | basic | full taste profile, daily drops |
| Explore | ✓ | ✓ |
| Offline | — | coming soon |

### Gating timeline

1. **Launch — no signup required.** Anonymous UUID minted in AsyncStorage.
2. **After 10 songs heard → signup wall** ([SignupSheet.tsx](src/screens/SignupSheet.tsx)). Email + password via Supabase auth when configured; locally-marked otherwise. "Not now" is allowed (we never re-prompt) and the user can still listen as a free anonymous account.
3. **After 20 songs in one day → premium paywall** ([PaywallScreen.tsx](src/screens/PaywallScreen.tsx)). Counter resets at the next midnight. Premium bypasses entirely.

`startTrial()` flips an in-app entitlement flag for 3 days. Real payments belong behind RevenueCat / StoreKit / Play Billing — left as a hook in `PaywallScreen.tsx`.

## Explore tab

The Explore screen ([src/screens/ExploreScreen.tsx](src/screens/ExploreScreen.tsx)) is built around seven horizontal carousels and a hero card. Ranking lives in [src/lib/ranking/Trending.ts](src/lib/ranking/Trending.ts).

### Sections

- **Trending Now** — overall trending score
- **Rising Fast** — biased toward velocity (today vs yesterday)
- **Most Replayed** — replays/plays ratio dominates
- **Boulevard Picks** — high completion + low skip
- **New Today** — `created_at` bonus that decays over a week
- **Night Drive** — `activity_fit` includes `driving` or `late_night`
- **Gym Heat** — `activity_fit` includes `gym` or `aggressive`

### Ranking signals

A song's trending score is a weighted blend, **never just listens**:

| signal | weight |
|---|---|
| `plays_24h` (capped at 5,000) | 0.18 |
| `replay_rate = replays / plays` | 0.22 |
| `save_rate = saves / plays` | 0.18 |
| `completion_rate` (≥ 70% plays / plays) | 0.14 |
| `keep_rate = 1 - skip_rate` | 0.14 |
| `velocity = (today - yesterday) / yesterday` | 0.14 |

A small deterministic daily salt (±5%) keeps the list fresh day-to-day. Each section applies its own bias on top of the base score, then we sort and slice.

### Real vs synthetic metrics

When real per-song aggregates aren't available, the ranker uses synthesized priors derived from each song's metadata (genre popularity, mood "stickiness") + a day-salt RNG so Explore looks alive on day zero. The moment Supabase aggregations land in `realMetrics`, those values override the synthetic ones for matching songs — the rest of the catalog keeps its synthetic baseline.

### Daily listen tracking

[src/lib/limits/DailyLimiter.ts](src/lib/limits/DailyLimiter.ts) — local AsyncStorage is authoritative (so a slow network never lets a user past the cap). Each play also upserts `public.user_daily_listens` in the background for cross-device sync and analytics. Day boundary is local midnight; the next day's first play auto-resets.

## Replacing the audio CDN

Edit `src/lib/seed/songs.ts` (or `supabase/seed.sql`) and replace each `audio_url` with your real CDN URL. Cover art lives next to it — same swap.

## Notes / future work

- No `Create` tab — Home / Library / Profile per spec.
- TikTok-style swipe-up = next. Tap the cover = play/pause. Skip button works too.
- We deliberately avoid `@react-navigation` to keep the bundle and startup time minimal; if the app grows past 3 tabs, switch over.
- iOS background audio is on (`UIBackgroundModes`); Android needs no extra config for foreground playback.
