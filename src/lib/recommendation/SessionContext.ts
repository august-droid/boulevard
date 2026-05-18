import type { Song } from '@/types';
import type { TasteIdentityProfile } from './TasteIdentityProfile';

// ============================================================
// Contextual Session Engine — a COMPLEMENTARY intent layer.
//
// WHAT THIS IS
// ------------
// A lightweight, in-memory layer that captures the user's CURRENT intent
// ("I'm inside this artist's universe", "I'm in a late-night mood", "I'm
// searching for EDM") and temporarily biases ranking toward it — then
// gracefully decays back to long-term taste.
//
// WHAT THIS IS NOT
// ----------------
// It does NOT replace or mutate anything: the lifetime TasteProfile, the
// SessionProfile + its decay, microtag scoring, the onboarding slate,
// Explore lanes, diversity rules, artist spacing, the 24h exposure log and
// the RecommendationEngine all keep running exactly as before. This engine
// only produces a TEMPORARY additive score delta (`contextBoost`) that the
// ranker adds on top. When the mode is `default`, the delta is 0 and the
// system behaves identically to before this engine existed.
//
// It also never writes to the long-term profile — a 4-minute artist binge
// must not permanently rewrite who the user is.
//
// DESIGN
// ------
// • 7 session modes, each with its own bias profile.
// • Confidence (0..1) — rises with reinforcement, falls with skip streaks.
// • Progressive time decay — strong → partial → blend → stale (NOT a hard
//   30-minute reset).
// • Effective `weight = confidence × decay`. The ranker multiplies every
//   context boost by this, so the bias fades smoothly into long-term taste.
// • Anti-fatigue — a rolling window penalises artist / cluster / BPM overload
//   even while a mode is boosting that very dimension.
// • Pure module (only the Song *type* is imported) — fast, no model calls,
//   trivially unit-testable.
// ============================================================

export type SessionMode =
  | 'default'
  | 'artist_focus'
  | 'mood_focus'
  | 'genre_focus'
  | 'playlist_focus'
  | 'search_focus'
  | 'discovery_focus';

export type DecayPhase = 'strong' | 'partial' | 'blend' | 'stale';

/** What a mode is anchored to. Every field optional — the caller fills what
 *  it knows, so the engine stays data-agnostic and standalone-testable. */
export interface ContextAnchor {
  artistId?: string | null;
  genre?: string | null;
  moodId?: string | null;
  /** Descriptor microtags for a mood/world (from moodCatalog). */
  anchorMicrotags?: string[];
  /** Mood words for a mood/world. */
  anchorMoodWords?: string[];
  /** Target energy 0..1 for energy-coherence scoring. */
  anchorEnergy?: number | null;
  /** Representative songs — used for vocal / tempo / production similarity. */
  refSongs?: Song[];
  /** Human-readable label, for debug + Explore "worlds". */
  label?: string;
  /** Genre-name keyword lists for a GENRE-anchored world. When set, the
   *  autoplay tail of a mood_focus session stays genre-coherent (Explore
   *  genre worlds). Left undefined for mood worlds — they stay cross-genre. */
  primaryGenres?: string[];
  adjacentGenres?: string[];
}

/** A live, decayed context snapshot — the only thing the ranker consumes.
 *  Pure data so `contextBoost` can be a pure function. */
export interface ActiveSessionContext {
  mode: SessionMode;
  anchor: ContextAnchor;
  /** confidence × decay, 0..1 — every boost is multiplied by this. */
  weight: number;
  confidence: number;
  decayPhase: DecayPhase;
  ageSeconds: number;
  /** Anti-fatigue rolling window (most-recent-first). */
  recentArtistIds: string[];
  recentClusters: string[];
  recentBpmBands: number[];
}

// ---- progressive decay (spec #4) ---------------------------------------
//
// 0–15 min   → strong   (full strength)
// 15–60 min  → partial  (1.0 → 0.45)
// 1–6 h      → blend    (0.45 → 0.12, session blends into long-term taste)
// > 6 h      → stale    (0.05 — effectively a fresh next-day session)

export function decayWeight(ageSeconds: number): { weight: number; phase: DecayPhase } {
  const min = ageSeconds / 60;
  if (min <= 15) return { weight: 1.0, phase: 'strong' };
  if (min <= 60) return { weight: 1.0 - ((min - 15) / 45) * 0.55, phase: 'partial' };
  if (min <= 360) return { weight: 0.45 - ((min - 60) / 300) * 0.33, phase: 'blend' };
  return { weight: 0.05, phase: 'stale' };
}

/** Past this age a restored session is treated as gone — "next day = fresh". */
export const SESSION_MAX_RESTORE_SECONDS = 12 * 60 * 60;

const INITIAL_CONFIDENCE = 0.62;
const SKIP_STREAK_LIMIT = 3;          // 3 skips in a row → confidence collapse
const ANTI_FATIGUE_WINDOW = 7;        // rolling window length

// ---- Explore "worlds" (spec #5) ----------------------------------------
//
// Named emotional worlds. Each is a mood-focus anchor the Explore page can
// surface as a tile; activating one drops the user into that emotional
// world. Stable emotional context, varied texture underneath.

export interface SessionWorld {
  id: string;
  label: string;
  /** 'genre' worlds stay anchored to their genre family; 'mood' worlds are
   *  intentionally cross-genre (a feeling, not a sound). */
  kind: 'genre' | 'mood';
  moodWords: string[];
  microtags: string[];
  energy: number;
  /** Genre-name keyword lists, lowercased substring match. GENRE worlds set
   *  these; MOOD worlds leave them undefined and stay cross-genre by design. */
  primaryGenres?: string[];
  adjacentGenres?: string[];
}

// moodWords + microtags below are matched against the LIVE catalog's actual
// analyzer vocabulary (SongAnalyzer tags + the per-song `mood` / `moods`
// fields). moodWords are matched as word tokens, so they catch the catalog's
// frequent comma-joined moods ("aggressive, festival, electric") too.
export const SESSION_WORLDS: SessionWorld[] = [
  // ---- MOOD worlds — a feeling, intentionally cross-genre. ----
  { id: 'night_drive', label: 'Night Drive', kind: 'mood',
    moodWords: ['longing', 'wistful', 'introspective', 'nostalgic', 'yearning', 'detached', 'lonely'],
    microtags: ['late_night_imagery', 'late_night_tempo', 'reverb_wash', 'synth_pad', 'mid_tempo', 'dreamy_lyrics'],
    energy: 0.55 },
  { id: 'main_character', label: 'Main Character Energy', kind: 'mood',
    moodWords: ['confident', 'triumphant', 'defiant', 'luxurious', 'glamorous', 'reckless', 'arrogant'],
    microtags: ['flex_lyrics', 'belted_vocal', 'vocal_harmony', 'peak_energy', 'high_energy', 'restrained_chorus'],
    energy: 0.8 },
  { id: 'heartbreak_spiral', label: 'Heartbreak Spiral', kind: 'mood',
    moodWords: ['vulnerable', 'longing', 'haunted', 'grief', 'hurt', 'lonely', 'aching', 'regret', 'betrayed', 'bittersweet', 'wistful'],
    microtags: ['melancholic_lyrics', 'piano_loop', 'intimate_vocal', 'close_mic_vocal', 'very_slow_tempo', 'reverb_wash'],
    energy: 0.4 },
  { id: 'sad_gym', label: 'Sad Gym', kind: 'mood',
    moodWords: ['defiant', 'reckless', 'relentless', 'menacing', 'raw', 'cold', 'gritty', 'sweaty'],
    microtags: ['aggressive_lyrics', 'flex_lyrics', 'trap_hihats', 'peak_energy', 'sub_bass'],
    energy: 0.88 },

  // ---- GENRE worlds — named after a genre, must stay genre-coherent. ----
  { id: 'euphoric_edm', label: 'Euphoric EDM', kind: 'genre',
    moodWords: ['euphoric', 'uplifting', 'ecstatic', 'hypnotic', 'rave', 'relentless'],
    microtags: ['dance_tempo', 'club_lyrics', 'peak_energy', 'high_energy', 'four_on_the_floor', 'melodic_bass'],
    energy: 0.9,
    primaryGenres: ['edm', 'house', 'techno', 'electronic', 'dance', 'trance', 'dubstep', 'rave', 'garage'],
    adjacentGenres: ['bass', 'electro', 'synthwave', 'dnb', 'drum and bass', 'breakbeat'] },
  { id: 'floating_indie', label: 'Floating Indie', kind: 'genre',
    moodWords: ['tender', 'longing', 'wistful', 'introspective', 'dreamy', 'content', 'nostalgic'],
    microtags: ['reverb_wash', 'close_mic_vocal', 'conversational_vocal', 'dry_live_drums', 'bass_led_groove', 'dreamy_lyrics'],
    energy: 0.58,
    primaryGenres: ['indie', 'bedroom', 'dream pop', 'dream-pop', 'shoegaze'],
    adjacentGenres: ['alt', 'folk', 'jangle', 'art pop', 'post-punk', 'lo-fi', 'lofi'] },
  { id: 'rage_trap', label: 'Rage Trap', kind: 'genre',
    moodWords: ['reckless', 'defiant', 'menacing', 'relentless', 'raw', 'cold', 'rage', 'focused', 'triumphant'],
    microtags: ['aggressive_lyrics', 'flex_lyrics', 'trap_hihats', 'peak_energy', 'autotuned_vocal'],
    energy: 0.9,
    primaryGenres: ['trap', 'rage', 'drill', 'phonk'],
    adjacentGenres: ['hip hop', 'hip-hop', 'hiphop', 'rap', 'hyperpop'] },
  { id: 'sunset_afrobeats', label: 'Sunset Afrobeats', kind: 'genre',
    moodWords: ['warm', 'euphoric', 'playful', 'sultry', 'groovy', 'carefree', 'joyful', 'hypnotic', 'spiritual'],
    microtags: ['mid_tempo', 'romantic_lyrics', 'club_lyrics', 'high_energy', 'vocal_harmony'],
    energy: 0.68,
    primaryGenres: ['afro', 'afrobeat', 'afrobeats', 'amapiano', 'afropop', 'afroswing'],
    adjacentGenres: ['dancehall', 'reggaeton', 'soca', 'highlife', 'r&b', 'rnb'] },
];

/** Build a mood-focus anchor from a world definition. Genre worlds carry
 *  their genre keyword lists into the anchor so the autoplay tail stays
 *  genre-coherent; mood worlds leave them undefined and stay cross-genre. */
export function worldToAnchor(world: SessionWorld): ContextAnchor {
  return {
    moodId: world.id,
    label: world.label,
    anchorMicrotags: world.microtags,
    anchorMoodWords: world.moodWords,
    anchorEnergy: world.energy,
    primaryGenres: world.primaryGenres,
    adjacentGenres: world.adjacentGenres,
  };
}

// ---- genre coherence helpers (Explore worlds) --------------------------

/** Lowercased genre text for a song — joins multi-genre rows. */
function songGenreText(s: Song): string {
  return ((s.genres && s.genres.length > 0 ? s.genres.join(' ') : s.genre) || '').toLowerCase();
}

/** Word tokens of a song's mood. The catalog's `mood` field is frequently a
 *  comma- or hyphen-joined phrase ("aggressive, festival, electric",
 *  "introspective-with-quiet-rage"); splitting into tokens lets a world's
 *  mood word match even when it is buried inside such a phrase. */
function moodTokens(s: Song): string[] {
  const raw = [s.mood ?? '', ...(s.moods ?? [])].join(' ').toLowerCase();
  return raw.split(/[^a-z]+/).filter(Boolean);
}

/** True when any of `moodWords` appears as a token of the song's mood. */
function matchesMoodWords(s: Song, moodWords: string[] | undefined): boolean {
  if (!moodWords || moodWords.length === 0) return false;
  const toks = moodTokens(s);
  return moodWords.some((w) => toks.includes(w.toLowerCase()));
}

/** Genre tier of a song against a world's primary / adjacent keyword lists.
 *  Keyword substring match — cheap, no embedding lookup. */
function classifyGenre(
  s: Song,
  primary?: string[],
  adjacent?: string[],
): 'primary' | 'adjacent' | 'outside' {
  const g = songGenreText(s);
  if ((primary ?? []).some((k) => g.includes(k))) return 'primary';
  if ((adjacent ?? []).some((k) => g.includes(k))) return 'adjacent';
  return 'outside';
}

/** A world below this many strict-fit songs relaxes its gate so it is never
 *  near-empty on a genre/theme-sparse catalog. */
const MIN_WORLD_SIZE = 8;

/**
 * Build an Explore "world" playlist from the live catalog. Dynamically
 * generated from the world's microtags / mood words / energy — emotionally
 * consistent, with artist diversity (max 2 per artist) and room for adjacent
 * sonic exploration. A small random term rotates the list so reopening a
 * world feels fresh. Pure: no network, no model, no mutation.
 *
 * `identity` (optional): once the behavioural identity profile has
 * confidence, an identity-fit modifier skews each world AWAY from strong
 * identity mismatches while keeping it emotionally distinct — e.g. the
 * "Energy" worlds stay energetic but skew to the user's identity (gym rap /
 * dark electronic for a mature listener, not childish party pop).
 */
export function buildWorldPlaylist(
  catalog: Song[],
  world: SessionWorld,
  limit = 28,
  identity?: TasteIdentityProfile | null,
): Song[] {
  const tagSet = new Set(world.microtags);
  const isGenreWorld = world.kind === 'genre';

  interface Scored {
    song: Song;
    score: number;
    /** Genre tier for a genre world ('primary' for every song in a mood world). */
    tier: 'primary' | 'adjacent' | 'outside';
    /** True when the song has a real emotional hit (microtag or mood word) —
     *  energy proximity alone never sets this. */
    themed: boolean;
  }
  const scored: Scored[] = [];

  for (const s of catalog) {
    if (!s.audio_url) continue;
    if ((s.distribution_stage ?? 'new_test') === 'suppressed') continue;

    // Emotional fit — the world's identity axes.
    let tagHits = 0;
    for (const t of s.microtags ?? []) if (tagSet.has(t)) tagHits++;
    const moodHit = matchesMoodWords(s, world.moodWords);
    // A real theme hit is a microtag OR a mood-word match. Energy proximity
    // is a SOFT enhancer only — on its own it can never qualify a song into a
    // world (Fix 2: emotional matching enhances coherence, never replaces it).
    const themed = tagHits > 0 || moodHit;

    let emotional = tagHits * 2;
    if (moodHit) emotional += 3;
    const dE = Math.abs(s.energy_score - world.energy);
    if (dE <= 0.18) emotional += 2;
    else if (dE <= 0.34) emotional += 0.5;

    // Genre coherence (Fix 1). Genre worlds strongly boost their own genre,
    // lightly allow adjacent families (healthy discovery), and push outside
    // genres far down — so e.g. Afrobeats never drifts into K-pop / Festival
    // House. Mood worlds set no genres and treat every song as eligible.
    const tier = isGenreWorld
      ? classifyGenre(s, world.primaryGenres, world.adjacentGenres)
      : 'primary';
    let genreScore = 0;
    if (isGenreWorld) {
      genreScore = tier === 'primary' ? 6 : tier === 'adjacent' ? 2 : -1000;
    }

    const quality = (s.hook_strength ?? 0) * 1.5 + (s.mainstream_fit ?? 0) * 0.5;
    // Identity-fit modifier — skews the world away from identity mismatches
    // while staying on-theme. Applied without explicit-softening (the user
    // chose the WORLD, not the mismatched songs inside it).
    const identityBoost = identity ? identity.evaluate(s, {}).boost : 0;
    // Random term → freshness / adjacent exploration on every open.
    scored.push({
      song: s,
      score: emotional + quality + identityBoost + genreScore + Math.random() * 1.4,
      tier,
      themed,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  // Strict pass. Genre worlds keep only primary/adjacent songs (no outside
  // genres). Mood worlds keep only songs with a real theme hit (energy-only
  // is excluded). The relax fallback only triggers when the catalog is too
  // genre/theme-sparse to fill a usable world — strict songs still rank
  // first, the rest are last-resort filler so a world is never near-empty.
  const strict = scored.filter((x) => (isGenreWorld ? x.tier !== 'outside' : x.themed));
  let ordered: Scored[];
  if (strict.length >= Math.min(limit, MIN_WORLD_SIZE)) {
    ordered = strict;
  } else {
    const strictIds = new Set(strict.map((x) => x.song.id));
    ordered = [...strict, ...scored.filter((x) => !strictIds.has(x.song.id))];
  }

  // Artist diversity — max 2 per artist (mirrors the catalog-wide rule).
  const perArtist = new Map<string, number>();
  const out: Song[] = [];
  for (const { song } of ordered) {
    const aid = song.artist_id ?? '__none__';
    if ((perArtist.get(aid) ?? 0) >= 2) continue;
    perArtist.set(aid, (perArtist.get(aid) ?? 0) + 1);
    out.push(song);
    if (out.length >= limit) break;
  }
  return out;
}

// ---- small pure helpers ------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const bpmBand = (bpm: number | null | undefined) => (bpm == null ? -1 : Math.round(bpm / 12));
// Genre-first cluster key — `similarity_cluster` is often a single default
// value across the whole catalog, so keying anti-fatigue on it alone would
// flag every song as the same cluster. Genre is the reliable signal.
const clusterKey = (s: Song) => (s.genre || String(s.similarity_cluster));
function sharedTagCount(a: string[] | undefined, b: string[] | undefined): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const set = new Set(b);
  let n = 0;
  for (const t of a) if (set.has(t)) n++;
  return n;
}

// ============================================================

let DEBUG = false;
/** Toggle verbose console output (used by the verification harness). */
export function setSessionDebug(on: boolean) { DEBUG = on; }
function log(...args: unknown[]) { if (DEBUG) console.log('[session-ctx]', ...args); }

export class SessionContextEngine {
  private mode: SessionMode = 'default';
  private anchor: ContextAnchor = {};
  private activatedAt = 0;
  private confidence = 0;
  private skipStreak = 0;
  private reinforceCount = 0;
  // Anti-fatigue rolling windows (most-recent-first).
  private recentArtistIds: string[] = [];
  private recentClusters: string[] = [];
  private recentBpmBands: number[] = [];

  // ---- activation (spec #1, #6) -----------------------------------------

  /**
   * Activate a session mode. This is also the real-time "pivot": calling it
   * with a new mode/anchor immediately drops the previous context (spec #6 —
   * "user leaves sad music and searches gym" pivots instantly).
   */
  activate(mode: SessionMode, anchor: ContextAnchor = {}, now: number = Date.now()): void {
    const sameContext = this.mode === mode && this.sameAnchor(anchor);
    this.mode = mode;
    this.anchor = anchor;
    this.activatedAt = now;
    this.skipStreak = 0;
    // Re-entering the SAME context keeps a little built-up confidence;
    // a genuine pivot starts fresh.
    this.confidence = mode === 'default'
      ? 0
      : sameContext
        ? Math.max(INITIAL_CONFIDENCE, this.confidence)
        : INITIAL_CONFIDENCE;
    this.reinforceCount = sameContext ? this.reinforceCount : 0;
    log('activate', mode, anchor.label ?? anchor.artistId ?? anchor.moodId ?? anchor.genre ?? '');
  }

  /** Drop back to the neutral default mode (pure long-term taste). */
  reset(): void {
    this.mode = 'default';
    this.anchor = {};
    this.confidence = 0;
    this.skipStreak = 0;
    this.reinforceCount = 0;
  }

  private sameAnchor(a: ContextAnchor): boolean {
    return (a.artistId ?? null) === (this.anchor.artistId ?? null)
      && (a.moodId ?? null) === (this.anchor.moodId ?? null)
      && (a.genre ?? null) === (this.anchor.genre ?? null);
  }

  // ---- outcomes (spec #6 real-time switching) ---------------------------

  /**
   * Feed a played song's signal kinds back in. Reinforces the mode on a
   * positive, and — after a streak of skips — collapses confidence so the
   * ranker widens its exploration radius and the mode fades fast.
   *
   * `ended` = true when the song finished/was-skipped (counts it once into
   * the anti-fatigue window). Pass false for mid-song signals (like / save /
   * replay / share) so the same song is not double-counted for fatigue.
   */
  registerOutcome(
    song: Song,
    kinds: string[],
    ended: boolean = true,
    now: number = Date.now(),
  ): void {
    // Anti-fatigue rolling window — count a song once, when it ends.
    if (ended) this.pushFatigue(song);

    if (this.mode === 'default') return;

    const skipped = kinds.includes('skip_under_5') || kinds.includes('skip_under_15');
    const hardSkip = kinds.includes('skip_under_5');
    const positive = kinds.some((k) =>
      k === 'completion_over_70' || k === 'listen_60s' ||
      k === 'replay' || k === 'save' || k === 'like' || k === 'share');

    if (positive) {
      this.skipStreak = 0;
      this.reinforceCount += 1;
      // Replays / saves are the strongest in-context confirmations.
      const strong = kinds.includes('replay') || kinds.includes('save') || kinds.includes('share');
      this.confidence = clamp(this.confidence + (strong ? 0.16 : 0.08), 0, 1);
      // A live reinforcement also freshens the clock a little so an engaged
      // session doesn't decay out from under an actively-listening user.
      this.activatedAt = Math.max(this.activatedAt, now - 8 * 60 * 1000);
      log('reinforce', this.mode, '→ confidence', this.confidence.toFixed(2));
    } else if (skipped) {
      this.skipStreak += hardSkip ? 2 : 1;
      this.confidence = clamp(this.confidence - (hardSkip ? 0.12 : 0.06), 0, 1);
      if (this.skipStreak >= SKIP_STREAK_LIMIT) {
        // 3 skips in the current mode → the user is rejecting it. Collapse
        // confidence so the bias shrinks and exploration widens.
        this.confidence *= 0.35;
        this.skipStreak = 0;
        log('skip-streak collapse →', this.mode, 'confidence', this.confidence.toFixed(2));
      }
    }
  }

  private pushFatigue(song: Song): void {
    const push = <T>(arr: T[], v: T) => {
      arr.unshift(v);
      if (arr.length > ANTI_FATIGUE_WINDOW) arr.pop();
    };
    if (song.artist_id) push(this.recentArtistIds, song.artist_id);
    push(this.recentClusters, clusterKey(song));
    push(this.recentBpmBands, bpmBand(song.bpm));
  }

  // ---- live snapshot -----------------------------------------------------

  /** The decayed, ranker-facing context. `weight` already folds in decay. */
  current(now: number = Date.now()): ActiveSessionContext {
    const ageSeconds = this.mode === 'default' ? 0 : Math.max(0, (now - this.activatedAt) / 1000);
    const { weight: decay, phase } = decayWeight(ageSeconds);
    return {
      mode: this.mode,
      anchor: this.anchor,
      confidence: this.confidence,
      weight: this.mode === 'default' ? 0 : clamp(this.confidence * decay, 0, 1),
      decayPhase: phase,
      ageSeconds,
      recentArtistIds: [...this.recentArtistIds],
      recentClusters: [...this.recentClusters],
      recentBpmBands: [...this.recentBpmBands],
    };
  }

  // ---- freshness persistence (spec #9) ----------------------------------

  /** Serialize for AsyncStorage so a reopened app preserves session DIRECTION
   *  (not the exact feed). Restored with decay applied → "still fits me, but
   *  there's something new". */
  serialize(): string {
    return JSON.stringify({
      mode: this.mode,
      anchor: this.anchor,
      activatedAt: this.activatedAt,
      confidence: this.confidence,
    });
  }

  /** Restore a persisted session. Returns false (and stays default) when the
   *  snapshot is too old — a next-day open should feel fresh. */
  restore(raw: string | null | undefined, now: number = Date.now()): boolean {
    if (!raw) return false;
    try {
      const p = JSON.parse(raw) as {
        mode: SessionMode; anchor: ContextAnchor; activatedAt: number; confidence: number;
      };
      if (!p || p.mode === 'default' || typeof p.activatedAt !== 'number') return false;
      if ((now - p.activatedAt) / 1000 > SESSION_MAX_RESTORE_SECONDS) return false;
      this.mode = p.mode;
      this.anchor = p.anchor ?? {};
      this.activatedAt = p.activatedAt; // decay continues from the original time
      this.confidence = clamp(p.confidence ?? INITIAL_CONFIDENCE, 0, 1);
      log('restored', this.mode, 'age', Math.round((now - p.activatedAt) / 60000), 'min');
      return true;
    } catch {
      return false;
    }
  }

  // ---- debug (spec #11) --------------------------------------------------

  debugSnapshot(now: number = Date.now()) {
    const c = this.current(now);
    return {
      mode: c.mode,
      anchor: c.anchor.label ?? c.anchor.artistId ?? c.anchor.moodId ?? c.anchor.genre ?? null,
      confidence: Number(c.confidence.toFixed(3)),
      decayPhase: c.decayPhase,
      ageMinutes: Number((c.ageSeconds / 60).toFixed(1)),
      effectiveWeight: Number(c.weight.toFixed(3)),
      skipStreak: this.skipStreak,
      reinforceCount: this.reinforceCount,
      antiFatigue: {
        recentArtists: this.recentArtistIds,
        recentClusters: this.recentClusters,
      },
    };
  }
}

// ============================================================
// contextBoost — the temporary additive score delta.
//
// Pure function. Returns ~[-12, +12] BEFORE the weight multiply, then scales
// by `ctx.weight` (confidence × decay) so the influence fades smoothly. The
// RecommendationEngine adds this on top of its normal score; with `default`
// mode or weight 0 it returns 0 and the ranker is untouched.
// ============================================================

/** Per-mode reasons, surfaced by explainContextBoost for debug (spec #11). */
export function contextBoost(song: Song, ctx: ActiveSessionContext): number {
  if (ctx.mode === 'default' || ctx.weight <= 0.02) return 0;
  const raw = rawBoost(song, ctx) - antiFatiguePenalty(song, ctx);
  return raw * ctx.weight;
}

/** Human-readable explanation of a song's context boost (spec #11 debug). */
export function explainContextBoost(song: Song, ctx: ActiveSessionContext): string {
  if (ctx.mode === 'default' || ctx.weight <= 0.02) return 'no active context';
  const raw = rawBoost(song, ctx);
  const fatigue = antiFatiguePenalty(song, ctx);
  const total = (raw - fatigue) * ctx.weight;
  return `${ctx.mode} raw ${raw.toFixed(1)} − fatigue ${fatigue.toFixed(1)} ` +
    `× weight ${ctx.weight.toFixed(2)} = ${total.toFixed(2)}`;
}

function rawBoost(song: Song, ctx: ActiveSessionContext): number {
  const a = ctx.anchor;
  const ref = a.refSongs && a.refSongs.length > 0 ? a.refSongs[0] : null;

  switch (ctx.mode) {
    // ---- ARTIST FOCUS (spec #2) ----
    // "Inside this artist's universe": same artist boosted, BUT adjacent
    // artists (same genre + shared microtags / vocal) also boosted so the
    // feed never collapses into a static playlist. Anti-fatigue (below) caps
    // any same-artist run → ~20-40% adjacent emerges naturally.
    case 'artist_focus': {
      let b = 0;
      if (a.artistId && song.artist_id === a.artistId) {
        b += 6; // same artist — allowed more often
      } else if (ref) {
        const sameGenre = song.genre === ref.genre;
        const tagOverlap = sharedTagCount(song.microtags, ref.microtags);
        if (sameGenre && tagOverlap >= 1) b += 4;       // adjacent artist
        else if (sameGenre || tagOverlap >= 2) b += 2;  // loosely adjacent
      }
      if (ref) {
        if (song.vocal_type === ref.vocal_type) b += 1.5;        // vocal style
        b += Math.min(3, sharedTagCount(song.microtags, ref.microtags)); // production
      }
      return b;
    }

    // ---- MOOD FOCUS (spec #3) ----
    // Stable emotional context, changing texture. Reward emotional fit;
    // PENALISE an abrupt mood break (a song with zero emotional overlap).
    case 'mood_focus': {
      let b = 0;
      const tagHits = sharedTagCount(song.microtags, a.anchorMicrotags);
      b += Math.min(4, tagHits * 1.6);
      const moodWordHit = matchesMoodWords(song, a.anchorMoodWords);
      if (moodWordHit) b += 2;
      if (a.anchorEnergy != null) {
        const dE = Math.abs(song.energy_score - a.anchorEnergy);
        b += dE <= 0.18 ? 2 : dE <= 0.32 ? 0.5 : -2;     // energy coherence
      }
      if (tagHits === 0 && !moodWordHit) b -= 5;          // abrupt mood break
      // Genre coherence for the autoplay tail (Fix 3). A GENRE world carries
      // primaryGenres on its anchor — once the 28-song curated playlist runs
      // out, the ranker must keep producing on-genre songs, not drift into
      // generic high-engagement tracks. MOOD worlds set no primaryGenres, so
      // this is a no-op for them and they stay cross-genre by design.
      if (a.primaryGenres && a.primaryGenres.length > 0) {
        const tier = classifyGenre(song, a.primaryGenres, a.adjacentGenres);
        b += tier === 'primary' ? 5 : tier === 'adjacent' ? 1.5 : -8;
      }
      return b;
    }

    // ---- GENRE FOCUS (spec #7) ----
    case 'genre_focus': {
      let b = 0;
      if (a.genre && song.genre === a.genre) b += 5;
      else if (a.genre && song.genre && adjacentGenre(song.genre, a.genre)) b += 2;
      else b -= 2;                                        // off-genre
      if (ref && song.bpm != null && ref.bpm != null &&
          Math.abs(song.bpm - ref.bpm) <= 14) b += 1.5;   // same BPM range
      return b;
    }

    // ---- SEARCH FOCUS (spec #7) ----
    // High direct relevance, high confidence, LOW exploration.
    case 'search_focus': {
      let b = 0;
      const relevant =
        (a.genre && song.genre === a.genre) ||
        (a.artistId && song.artist_id === a.artistId) ||
        sharedTagCount(song.microtags, a.anchorMicrotags) >= 2;
      b += relevant ? 6 : -3;
      b += (song.mainstream_fit ?? 0) * 2 + (song.hook_strength ?? 0) * 1;
      b -= (song.weirdness_score ?? 0) * 3;               // suppress novelty
      return b;
    }

    // ---- DISCOVERY FOCUS (spec #7) ----
    // Wider novelty radius, emerging songs, hidden gems.
    case 'discovery_focus': {
      let b = 0;
      const stage = song.distribution_stage ?? 'new_test';
      if (stage === 'new_test' || stage === 'rising') b += 3; // emerging
      b += (song.uniqueness_score_v2 ?? 0) * 2.5;             // hidden gems
      if (stage === 'trending' && (song.mainstream_fit ?? 0) > 0.7) b -= 1.5; // over-familiar
      return b;
    }

    // ---- PLAYLIST FOCUS ----
    // The curated queue already owns ordering — only a gentle coherence nudge.
    case 'playlist_focus': {
      if (!ref) return 0;
      return Math.min(2, sharedTagCount(song.microtags, ref.microtags) * 0.7);
    }

    default:
      return 0;
  }
}

/**
 * Anti-fatigue penalty (spec #8). Even while a mode boosts a dimension, this
 * stops it overloading: it punishes a candidate that would extend an already
 * long run of the same artist / cluster / BPM band. This is what keeps
 * artist_focus feeling like a "universe", not a stuck record.
 */
function antiFatiguePenalty(song: Song, ctx: ActiveSessionContext): number {
  let p = 0;
  if (song.artist_id) {
    const n = ctx.recentArtistIds.filter((id) => id === song.artist_id).length;
    if (n >= 2) p += 4 + (n - 2) * 2;          // artist overload
  }
  const cl = clusterKey(song);
  const nc = ctx.recentClusters.filter((c) => c === cl).length;
  if (nc >= 3) p += 3 + (nc - 3) * 1.5;        // same micro-cluster too long
  const bb = bpmBand(song.bpm);
  if (bb >= 0) {
    const nb = ctx.recentBpmBands.filter((b) => b === bb).length;
    if (nb >= 4) p += 2;                       // identical BPM band too long
  }
  return p;
}

/** Cheap genre-adjacency check — shared word stem, no embedding lookup. */
function adjacentGenre(a: string, b: string): boolean {
  if (a === b) return true;
  const norm = (g: string) => g.toLowerCase().split(/[\s\-/]+/);
  const aw = norm(a);
  const bw = new Set(norm(b));
  return aw.some((w) => w.length > 2 && bw.has(w));
}
