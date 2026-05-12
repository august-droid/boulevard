# Boulevard Music Factory — Handoff Brief

Production-ready AI music generation pipeline. Built on Sunor (Suno v5.5 API wrapper), Cloudflare R2 (audio storage), Supabase (queue + metadata + reviews), TypeScript/Node 20.

This document is the complete system overview. Pass it to any agent or engineer to extend or integrate with the Boulevard mobile/web app.

---

## 1. Goal

Mass-generate 2,000+ AI songs (10 genre buckets × 200 each), store them in R2, catalog them in Supabase, expose them to the Boulevard production app, capture user engagement, and use that engagement to drive the next generation of prompts.

Music criteria: vocals required, ≥120s, modern radio-quality, strong hook in first 8–15s, mainstream American archetypes (melodic rap, southern rap, female pop, dark alt-pop, psy-trap, dream pop, late-night R&B, dance pop, country pop, experimental fusion). No artist-name cloning.

---

## 2. Stack

| Layer | Service / Tech | Purpose |
|---|---|---|
| Prompt source | `prompts.csv` (2,000 rows) | seed data with title, genre, prompt, etc. |
| Queue | Supabase Postgres → `public.songs_queue` | pending/generating/completed/failed/approved/rejected |
| Generation | Sunor (sunor.cc) API → Suno v5.5 | actual audio synthesis |
| Audio storage | Cloudflare R2 (bucket `boulevard-songs`) | mp3 + cover image |
| Catalog | Supabase Postgres → `public.songs` (existing prod table) | only approved live songs |
| Logs / telemetry | `public.generation_logs`, `public.queue_stats` view | per-event audit |
| Review UI | Express + static HTML dashboard, `localhost:8787` | approve/reject/regenerate/rate 1–10 |
| Feedback loop | `public.archetype_performance` view | scores genre×subgenre×mood×cluster for next-gen prompts |
| Runtime | Node 20, TypeScript, ESM, `tsx`, `p-queue` (8 concurrent workers) | local CLI scripts |

---

## 3. End-to-end data flow

```
prompts.csv
   │ npm run import:prompts
   ▼
public.songs_queue (status=pending)
   │ npm run worker  (8 concurrent)
   │   1. claim_next_queue_row() — atomic FOR UPDATE SKIP LOCKED
   │   2. POST sunor.cc/api/v1/task         (10 credits ≈ $0.10)
   │   3. poll  sunor.cc/api/v1/task/{id}   (8s interval)
   │   4. download mp3 + cover from cdn1/cdn2.suno.ai
   │   5. upload  → R2 bucket boulevard-songs (songs/<genre>/<id>.mp3, covers/<genre>/<id>.png)
   │   6. INSERT  → public.songs (approval_status=pending, is_live=false)
   │   7. UPDATE  → songs_queue (status=completed, links song_id)
   │   8. LOG     → generation_logs (event=completed, durationMs, payload)
   │   * retries up to WORKER_RETRY_LIMIT (default 3), exponential-ish backoff
   ▼
Internal review dashboard (npm run dashboard)
   │ approve / reject / regenerate / rate 1–10
   │ approve  → songs.approval_status=approved, is_live=true; queue.status=approved
   │ reject   → songs.approval_status=rejected, is_live=false; queue.status=rejected
   │ regen    → songs.approval_status=regenerate; queue.status=pending, attempts=0
   ▼
Boulevard production app
   │ SELECT * FROM songs WHERE is_live = true AND approval_status = 'approved'
   │ stream audio_url from R2 (or R2_PUBLIC_BASE CDN)
   │ track plays in public.user_events, agg in public.song_daily_stats
   ▼
public.archetype_performance (view)  ←  used by next-gen prompt generator
   performance_score =
       0.40 * avg_replay
     + 0.25 * avg_completion
     + 0.20 * avg_save
     + 0.10 * avg_share
     - 0.30 * avg_skip
     + 0.05 * (avg_rating / 10)
```

---

## 4. Supabase project

- **Project ID:** `psmgmshfcjxgujfmsfcx`
- **URL:** `https://psmgmshfcjxgujfmsfcx.supabase.co`
- **Region:** `us-east-1`

### 4.1 Tables

#### `public.songs` — production catalog (PRE-EXISTING + EXTENDED)

Already in your Boulevard project before this work. We added review/lifecycle columns additively.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | default `uuid_generate_v4()` |
| `title` | text | song title |
| `audio_url` | text | R2 URL (public or signed) — production app streams from here |
| `cover_url` | text | R2 cover image |
| `genre` | text | primary genre bucket |
| `genres` | text[] | `[genre, subgenre]` |
| `bpm` | int | |
| `mood` | text | primary mood |
| `moods` | text[] | `[mood]` |
| `energy_score` | numeric (0–1) | |
| `vocal_type` | text | `instrumental | male | female | mixed` |
| `voice_gender` | text | |
| `similarity_cluster` | int | global cluster id (genre_idx*20 + n-1) |
| `drop_timestamps` | numeric[] | seconds — for visual cues |
| `intro_length` | numeric | seconds before hook |
| `activity_fit` | text[] | e.g. `{"gym warmup"}` |
| `duration_seconds` | int | |
| `is_featured` | bool | |
| `launch_score` | numeric (0–1) | |
| `created_at` | timestamptz | |
| **`approval_status`** | text | `pending | approved | rejected | regenerate` *(added)* |
| **`rating`** | smallint (1–10) | reviewer rating *(added)* |
| **`reviewed_by`** | text | *(added)* |
| **`reviewed_at`** | timestamptz | *(added)* |
| **`is_live`** | bool default false | **app filters on this** *(added)* |
| **`replayability_score`** | numeric default 0 | *(added)* |
| **`queue_id`** | uuid | link back to `songs_queue` *(added)* |
| **`lyrics`** | text | *(added)* |
| **`raw_metadata`** | jsonb | full Sunor response excerpt *(added)* |
| **`updated_at`** | timestamptz | *(added, trigger)* |

Existing FK references: `user_events.song_id`, `library.song_id`, `song_daily_stats.song_id` — preserved.

#### `public.songs_queue` — generation queue (NEW)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `title` | text NOT NULL | unique (dedup key for importer) |
| `genre`, `subgenre`, `vocal_gender`, `mood` | text | |
| `target_bpm` | int | |
| `energy_score` | numeric (0–1) | |
| `activity_fit` | text | |
| `hook_timing` | text | e.g. `"0:08"` |
| `style_influence`, `weirdness` | int (0–100) | |
| `minimum_duration_seconds` | int default 120 | |
| `vocals_required` | bool default true | |
| `similarity_cluster` | text | e.g. `"mains-c01"` |
| `suno_prompt` | text NOT NULL | the actual `gpt_description_prompt` sent to Sunor |
| `status` | text | `pending | generating | completed | failed | approved | rejected` |
| `task_id` | text | Sunor `data.task_id` |
| `raw_audio_url` | text | Suno CDN URL (before R2) |
| `r2_audio_url` | text | final R2 audio URL |
| `cover_url` | text | R2 cover URL |
| `lyrics` | text | from `data.output.result[*].prompt` |
| `duration_seconds` | numeric | from `data.output.result[*].duration` |
| `rating` | smallint | |
| `approved` | bool | mirror of `songs.is_live` |
| `attempts` | int default 0 | |
| `error_message` | text | |
| `raw_metadata` | jsonb | weirdness, style_influence, etc. |
| `song_id` | uuid → `public.songs(id)` | populated when generation completes |
| `worker_id` | text | which worker grabbed this row |
| `generation_started_at`, `generation_completed_at` | timestamptz | |
| `created_at`, `updated_at` | timestamptz | |

Indexes: `status`, `approved`, `genre`, `task_id`. **Unique index on `title`** for idempotent imports.

#### `public.generation_logs` — per-event audit (NEW)

| Column | Type |
|---|---|
| `id` | uuid PK |
| `queue_id` | uuid → `songs_queue(id) ON DELETE CASCADE` |
| `worker_id` | text |
| `event` | text — `submitted | poll | completed | failed | retry | uploaded | approved | rejected | regenerated` |
| `duration_ms` | int |
| `attempt` | int |
| `payload` | jsonb |
| `created_at` | timestamptz |

### 4.2 Functions

#### `public.claim_next_queue_row(p_worker_id text) → public.songs_queue`

Atomic claim — `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`. Sets status=`generating`, worker_id, increments `attempts`, sets `generation_started_at=now()`. Returns the claimed row, or NULL if queue empty.

Safe for many concurrent workers across machines.

### 4.3 Views

#### `public.queue_stats`
```sql
select status, count(*),
       avg(extract(epoch from (generation_completed_at - generation_started_at))) as avg_seconds
from songs_queue group by status;
```

#### `public.archetype_performance` — feedback loop

```sql
select s.genre, q.subgenre, s.mood, s.similarity_cluster,
       count(*), count(*) filter (where is_live),
       count(*) filter (where approval_status='approved'),
       avg(s.rating), avg(ds.avg_completion), avg(ds.skip_rate),
       avg(ds.replay_rate), avg(ds.save_rate), avg(ds.share_rate),
       /* performance_score = weighted blend */
from songs s
left join songs_queue q on q.song_id = s.id
left join song_daily_stats ds on ds.song_id = s.id
group by ...;
```

Use this to power the next iteration of prompt generation — pick top-N rows, generate more variations of those archetypes; suppress low-scoring ones.

### 4.4 Triggers

`tg_songs_set_updated_at()` — bumps `updated_at` on both `songs` and `songs_queue`.

### 4.5 RLS

- `songs` — RLS enabled (existing). Service role bypasses; add policies for client reads as needed.
- `songs_queue`, `generation_logs` — RLS disabled (admin-only access via service role from the worker).

---

## 5. Cloudflare R2

- **Account ID:** `e6849897b1cd5c2f381ae4603733f826`
- **Bucket:** `boulevard-songs` (private, 0 objects pre-pipeline)
- **S3 endpoint:** `https://e6849897b1cd5c2f381ae4603733f826.r2.cloudflarestorage.com`
- **API token:** `boulevard-s3` — currently account-wide; consider scoping to just this bucket later
- **Object layout:**
  - `songs/<genre-slug>/<song-id>.mp3`
  - `covers/<genre-slug>/<song-id>.{png|jpg}`
  - `<genre-slug>` = lowercase, hyphen-separated

URLs:
- Until you front the bucket with a custom domain, pipeline uses **7-day pre-signed URLs** via `@aws-sdk/s3-request-presigner`
- Set `R2_PUBLIC_BASE` env var (e.g. `https://cdn.boulevard.app`) once a CDN domain is configured — pipeline will switch to public URLs automatically.

---

## 6. Sunor (Suno v5.5) API

### 6.1 Endpoints (confirmed)

| Endpoint | Method | Purpose |
|---|---|---|
| `https://sunor.cc/api/v1/task` | POST | submit generation |
| `https://sunor.cc/api/v1/task/{task_id}` | GET | poll task |

**Auth:** `x-api-key: <key>` header (not Bearer).

### 6.2 Submit body

```json
{
  "model": "suno",
  "task_type": "music",
  "input": {
    "gpt_description_prompt": "Mainstream Melodic Rap, confident male lead vocal, …",
    "title": "Silent Halo Reborn",
    "make_instrumental": false,
    "duration_seconds_min": 120,
    "prompt": "<optional explicit lyrics — leave null for auto>"
  }
}
```

### 6.3 Submit response

```json
{
  "code": 202,
  "data": {
    "task_id": "37c786e0-1180-4aea-95ae-4513ecc87178",
    "type": "music",
    "status": "pending",
    "credits_charged": 10,
    "created_at": "2026-05-12T11:27:31.914Z"
  }
}
```

### 6.4 Poll response (completed)

```json
{
  "code": 200,
  "data": {
    "task_id": "…",
    "status": "success",
    "credits_cost": 10,
    "input": { … },
    "output": {
      "status": "completed",
      "progress": "100%",
      "fail_reason": null,
      "result": [
        {
          "id": "32f6ba7f-…",
          "title": "Four In My Chest",
          "status": "SUCCESS",
          "audio_url": "https://cdn1.suno.ai/32f6ba7f-…mp3",
          "image_url": "https://cdn2.suno.ai/image_32f6ba7f-….jpeg",
          "image_large_url": "https://cdn2.suno.ai/image_large_…jpeg",
          "duration": 182.68,
          "prompt": "[Verse 1]\nI been wide awake…",  ← LYRICS
          "model_name": "chirp-fenix",
          "major_model_version": "v5.5",
          "metadata": { "tags": "…", "stream": true, "history": null, … }
        },
        { "id": "7fb5b859-…", "duration": 173.88, … }   ← Suno generates 2 variations per task
      ]
    },
    "error": null,
    "completed_at": "2026-05-12T11:30:51.932Z"
  }
}
```

### 6.5 Cost

- **10 credits per task** ($0.10 at sunor.cc's $0.01/credit pricing)
- Each task returns **2 clip variations** (we pick one — by default the longer, or the first that meets `minimum_duration_seconds`)
- **Top-up:** USDC/USDT only, $5 minimum (500 credits)
- **Budget for 2,000 prompts: ~$200**

---

## 7. Repo: `~/Desktop/Boulevard AI/boulevard-music-factory/`

```
boulevard-music-factory/
├── package.json              # npm scripts + deps
├── tsconfig.json             # strict TS, ES2022, NodeNext
├── .env                      # SECRETS (gitignored)
├── .env.example              # template
├── .gitignore
├── prompts.csv               # 2,000 v1 prompts (mirror of ../boulevard_music_factory_prompts.csv)
├── README.md                 # ops doc
│
├── src/
│   ├── lib/
│   │   ├── env.ts            # zod-validated env
│   │   ├── types.ts          # SongsQueueRow, SunorClip, etc.
│   │   ├── logger.ts         # pino structured logs
│   │   ├── supabase.ts       # service-role client + claim/insert/log helpers
│   │   ├── r2.ts             # S3 SDK against R2, signed URL helper
│   │   ├── sunor.ts          # Sunor adapter — the one place provider-specific logic lives
│   │   └── metadata.ts       # auto-metadata heuristics (intro length, replayability score)
│   │
│   └── scripts/
│       ├── import-prompts.ts        # npm run import:prompts
│       ├── run-generation-worker.ts # npm run worker  (8 concurrent, retries, polling, R2 upload, Supabase insert)
│       ├── dashboard-server.ts      # npm run dashboard  (Express + static HTML)
│       ├── stats.ts                 # npm run stats
│       ├── test-sunor.ts            # npm run test:sunor  (spends 10 credits, validates adapter)
│       └── verify-extract.ts        # npm run verify -- <task_id>  (FREE check of an existing task)
│
└── dashboard/
    └── index.html            # vanilla HTML+TS SPA, paste-admin-token-on-open
```

### npm scripts

```
npm run import:prompts        # CSV → songs_queue (idempotent, dedup by title)
npm run worker                # 8 concurrent workers, runs until queue idle for ~30s
npm run worker:dry            # DRY_RUN=true — pulls rows, marks complete with stub URLs (no spend)
npm run test:sunor            # one real Sunor call (~10 credits, ~$0.10)
npm run verify -- <task_id>   # poll an existing task, no spend
npm run dashboard             # http://localhost:8787 — admin review UI
npm run stats                 # queue stats + top archetypes + failures
npm run typecheck             # tsc --noEmit
```

---

## 8. Environment variables

```
# Sunor
SUNOR_API_KEY=
SUNOR_API_BASE=https://sunor.cc
SUNOR_MODEL=suno
SUNOR_TASK_TYPE=music

# Supabase (project psmgmshfcjxgujfmsfcx)
SUPABASE_URL=https://psmgmshfcjxgujfmsfcx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_ANON_KEY=

# Cloudflare R2
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=boulevard-songs
R2_PUBLIC_BASE=                # set to your CDN domain once configured

# Worker tuning
WORKER_CONCURRENCY=8
WORKER_POLL_INTERVAL_MS=8000
WORKER_MAX_POLL_ATTEMPTS=90
WORKER_RETRY_LIMIT=3
WORKER_RETRY_BACKOFF_MS=15000
WORKER_BATCH_SIZE=10
WORKER_LOG_LEVEL=info

# Dashboard
DASHBOARD_PORT=8787
DASHBOARD_ADMIN_TOKEN=         # 48+ random chars

# Defaults
DEFAULT_MIN_DURATION_SECONDS=120
DEFAULT_VOCALS_REQUIRED=true
DRY_RUN=false
```

---

## 9. Boulevard production app integration

Your existing mobile/web app already reads from `public.songs`. **No app changes needed** other than respecting the two new flags:

```sql
SELECT id, title, audio_url, cover_url, genre, mood, bpm, energy_score,
       activity_fit, similarity_cluster, duration_seconds, intro_length, lyrics
FROM public.songs
WHERE is_live = true AND approval_status = 'approved'
ORDER BY launch_score DESC, created_at DESC;
```

That's it. New songs flow in automatically as you approve them in the dashboard. No App Store release required.

**Recommended client behaviours (for the recommendation loop):**

Already wired by the existing `public.user_events` event_type enum. Make sure the app emits:
- `song_started`, `song_completed`, `song_skipped` (with `skip_time_seconds`, `completion_percentage`)
- `saved`, `unsaved`, `replayed`, `shared`, `volume_changed`

`song_daily_stats` is the rolling aggregate. The pipeline's `archetype_performance` view reads from it — so engagement signal flows back into prompt-gen automatically once you wire stats updates.

---

## 10. The feedback loop (next phase)

`archetype_performance` exposes a ranked list of genre × subgenre × mood × similarity_cluster combos by performance. The next iteration of the prompt generator should:

1. Read top-N archetypes from `archetype_performance` (e.g. `performance_score > 0.6`)
2. Generate new prompt variations of those archetypes (via Claude / GPT / template engine)
3. Append to `prompts.csv` or insert directly into `songs_queue`
4. Suppress (`performance_score < 0.2`) archetypes — don't generate more
5. Worker picks up new rows automatically

There's no script written for step 1–4 yet. That's the recommendation-driven generation phase.

---

## 11. Known quirks / gotchas

- **`major_model_version: "v5.5"`** is returned by Sunor — confirms we're getting the latest model
- **2 clips per task** — we currently pick the longest that meets min duration; we could store both as alternates if you want A/B testing later
- **R2 token is account-wide** — works fine; for tighter security, replace with a bucket-scoped token
- **R2 URLs default to 7-day signed** until `R2_PUBLIC_BASE` is set — fine for a private app, but mobile clients caching past 7d will break. Front the bucket with a custom domain ASAP.
- **`status: "pending"` on first poll is normal** — Sunor takes 60–180s per task
- **Concurrency 8 is safe** with Sunor — they have queue capacity. You can push to 16–24 if you watch error rates.
- **Retry safety:** the atomic `claim_next_queue_row()` uses `FOR UPDATE SKIP LOCKED`, so even multiple workers across multiple machines won't double-claim a row.
- **`make_instrumental: false` is required** for vocals — Sunor flips this from `vocals_required` in our adapter.
- **`prompt` field on a clip = lyrics** (not the description). Confusing naming. Our adapter aliases it correctly.

---

## 12. Open work / what's NOT yet done

| Item | Status |
|---|---|
| Test:sunor smoke-test | ✅ passed |
| Adapter clip extraction | ✅ patched for `data.output.result` |
| 2,000 rows seeded into `songs_queue` | ⏳ run `npm run import:prompts` |
| Full pipeline smoke test (1 song end-to-end) | ⏳ run `WORKER_CONCURRENCY=1 npm run worker`, kill after 1 |
| Full production run (2,000 songs) | ⏳ requires ~$200 Sunor top-up |
| `R2_PUBLIC_BASE` CDN domain | ⏳ optional but recommended before public app launch |
| Prompt-regeneration feedback service | ⏳ next phase |
| App-side query updates (filter `is_live=true`) | ⏳ small client patch |
| Edge function for signed URL refresh (if not using CDN) | ⏳ optional |
| Generation analytics dashboard (charts) | ⏳ optional — `archetype_performance` data is there |
| Cost monitoring / budget cap | ⏳ optional — add to worker if you want |

---

## 13. Quick test commands (in order)

```bash
cd ~/Desktop/Boulevard\ AI/boulevard-music-factory

# 1. Verify Sunor adapter works on the existing completed task (free)
npm run verify -- 37c786e0-1180-4aea-95ae-4513ecc87178

# 2. Seed the queue (no spend)
npm run import:prompts

# 3. End-to-end smoke test — one song through Sunor → R2 → Supabase (~$0.10)
WORKER_CONCURRENCY=1 npm run worker
# Watch for one row to flip status=completed, then Ctrl+C.

# 4. Open the dashboard
npm run dashboard
# → http://localhost:8787 — paste DASHBOARD_ADMIN_TOKEN from .env

# 5. After approving the smoke-test song and confirming it plays:
#    Top up Sunor to ≥20,000 credits, then:
WORKER_CONCURRENCY=8 npm run worker
```

---

## 14. Files

All code at:
`/Users/augusttange/Desktop/Boulevard AI/boulevard-music-factory/`

This handoff doc:
`/Users/augusttange/Desktop/Boulevard AI/BOULEVARD_MUSIC_FACTORY_HANDOFF.md`

CSV (mirror in repo too):
`/Users/augusttange/Desktop/Boulevard AI/boulevard_music_factory_prompts.csv`
