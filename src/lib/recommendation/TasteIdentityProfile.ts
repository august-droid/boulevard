import type { Song } from '@/types';

// ============================================================
// Taste-identity layer — an ADDITIVE layer on top of the existing stack.
//
// THE PROBLEM IT SOLVES
// ---------------------
// Genre / energy / mood matching can produce songs that are technically
// "correct" yet feel WRONG for who the user is. A listener of rap + indie +
// rock + dark electronic spans very different genres — but those genres share
// a deeper signature (maturity, introspection, darkness, ambition,
// authenticity). The existing engines happily allow that cross-genre breadth.
// What they cannot express is: "this user keeps skipping childish teen-pop /
// bubblegum / novelty songs — that identity is wrong for them" even when the
// genre/energy technically matches.
//
// WHAT THIS IS
// ------------
// TasteIdentityProfile learns a behavioural "identity" — not genres, but the
// CHARACTER of music the user gravitates to — and produces a capped additive
// `identityBoost`. It rewards identity-compatible songs (including across very
// different genres) and penalises strong identity mismatches.
//
// WHAT THIS IS NOT
// ----------------
// • Not ML, no network, no model — a pure heuristic vector + a smoothed
//   behavioural profile.
// • Not a replacement for any scoring. It is one more capped, additive term.
// • Not demographic. Identity is learned ONLY from behaviour. There is no
//   "male user ⇒ masculine music" path: a vocal-gender-coded dimension is
//   deliberately NOT modelled here — vocal preference is already handled
//   behaviourally by TasteProfile.vocal_preferences, and folding it into
//   "identity" is exactly the stereotyping the brief warns against.
// • Not a discovery-killer. Different genre is fine; identity-BREAKING is not.
//
// Pure module — only the Song *type* is imported (erased at compile time).
// Persistence is layered on by identityStore.ts so this stays unit-testable.
// ============================================================

/** Internal identity dimensions. Never shown to users. A song expresses each
 *  in [0,1]; a user's profile learns a signed affinity for each. */
export type IdentityDim =
  | 'lyrical_maturity'
  | 'emotional_maturity'
  | 'confidence'
  | 'introspection'
  | 'seriousness'
  | 'darkness'
  | 'aggression'
  | 'cinematic_feel'
  | 'authenticity'
  | 'rawness'
  | 'ambition'
  | 'rebelliousness'
  | 'sophistication'
  | 'playfulness'
  | 'softness'
  | 'bubblegum_pop_energy'
  | 'teen_breakup_energy'
  | 'novelty_meme_energy'
  | 'commercial_polish';

export const IDENTITY_DIMS: IdentityDim[] = [
  'lyrical_maturity', 'emotional_maturity', 'confidence', 'introspection',
  'seriousness', 'darkness', 'aggression', 'cinematic_feel', 'authenticity',
  'rawness', 'ambition', 'rebelliousness', 'sophistication', 'playfulness',
  'softness', 'bubblegum_pop_energy', 'teen_breakup_energy',
  'novelty_meme_energy', 'commercial_polish',
];

export type IdentityVector = Record<IdentityDim, number>;
export type IdentityZone = 'core' | 'adjacent' | 'surprise' | 'blocked' | 'neutral';

const emptyVector = (): IdentityVector => {
  const v = {} as IdentityVector;
  for (const d of IDENTITY_DIMS) v[d] = 0;
  return v;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ---- per-song identity derivation --------------------------------------
//
// Songs carry no explicit identity metadata, so the vector is derived from
// the analyzer fields already on every Song (microtags, mood, genre, and the
// numeric priors). This is a documented HEURISTIC, not a model — its only
// requirement is internal consistency: whatever the heuristic calls
// "bubblegum", if the user skips it, the user learns to dislike that, and the
// same songs are then suppressed. The mapping does not need to be perfect.

type Contrib = Partial<Record<IdentityDim, number>>;

const MICROTAG_MAP: Record<string, Contrib> = {
  // ---- rap / aggressive / confident ----
  aggressive_lyrics: { aggression: 0.8, rawness: 0.5, seriousness: 0.45, rebelliousness: 0.45, confidence: 0.35 },
  hard_808_kick: { aggression: 0.5, darkness: 0.35, rawness: 0.3 },
  gang_vocal: { aggression: 0.45, rebelliousness: 0.55, rawness: 0.35 },
  peak_energy: { aggression: 0.2 },
  high_energy: { confidence: 0.2 },
  flex_lyrics: { confidence: 0.8, ambition: 0.7, rebelliousness: 0.25 },
  gold_chain: { confidence: 0.55, ambition: 0.55, commercial_polish: 0.2 },
  autotune_cry: { emotional_maturity: 0.45, introspection: 0.4, softness: 0.3 },
  // ---- introspective / emotional / mature ----
  melancholic_lyrics: { introspection: 0.8, emotional_maturity: 0.7, seriousness: 0.6, darkness: 0.5, lyrical_maturity: 0.5 },
  whispered_vocal: { introspection: 0.6, softness: 0.6, authenticity: 0.45 },
  intimate_vocal: { introspection: 0.55, softness: 0.5, authenticity: 0.55, emotional_maturity: 0.4 },
  conversational_vocal: { authenticity: 0.5, introspection: 0.3, sophistication: 0.25 },
  detached_vocal: { sophistication: 0.5, cinematic_feel: 0.25, seriousness: 0.3 },
  late_night_imagery: { introspection: 0.5, darkness: 0.4, cinematic_feel: 0.45, seriousness: 0.35 },
  behind_the_beat_phrasing: { sophistication: 0.45, authenticity: 0.4, introspection: 0.3 },
  // ---- production / texture ----
  piano_loop: { sophistication: 0.6, introspection: 0.5, cinematic_feel: 0.4, seriousness: 0.4, lyrical_maturity: 0.35 },
  reverb_wash: { cinematic_feel: 0.6, introspection: 0.3, darkness: 0.2 },
  synth_lead: { cinematic_feel: 0.5 },
  dreamy_lyrics: { introspection: 0.4, softness: 0.4, cinematic_feel: 0.3 },
  tape_warmth: { authenticity: 0.7, rawness: 0.5, sophistication: 0.25 },
  vinyl_crackle: { authenticity: 0.6, rawness: 0.45, sophistication: 0.3 },
  acoustic_guitar: { authenticity: 0.6, rawness: 0.35, softness: 0.3 },
  pedal_steel_guitar: { authenticity: 0.55, sophistication: 0.3 },
  fiddle: { authenticity: 0.5, playfulness: 0.25 },
  jangly_guitar: { authenticity: 0.5, playfulness: 0.3, rawness: 0.3 },
  interlocking_clean_guitars: { sophistication: 0.5, cinematic_feel: 0.3, authenticity: 0.35 },
  bass_led_groove: { sophistication: 0.4, confidence: 0.3 },
  dry_live_drums: { authenticity: 0.55, rawness: 0.4 },
  instrumental_track: { sophistication: 0.5, introspection: 0.4, seriousness: 0.3, cinematic_feel: 0.3 },
  warm_vocal: { softness: 0.5, authenticity: 0.35 },
  low_energy: { introspection: 0.3, softness: 0.35, seriousness: 0.2 },
  // ---- dance / club / polished ----
  big_hook: { commercial_polish: 0.6, playfulness: 0.3 },
  radio_ready: { commercial_polish: 0.9, playfulness: 0.3, bubblegum_pop_energy: 0.3 },
  club_lyrics: { playfulness: 0.6, bubblegum_pop_energy: 0.25 },
  dance_tempo: { playfulness: 0.45 },
  peak_tempo: { playfulness: 0.35, aggression: 0.2 },
  four_on_the_floor: { playfulness: 0.3, cinematic_feel: 0.2 },
  dembow_pattern: { playfulness: 0.4 },
  log_drum: { authenticity: 0.4, playfulness: 0.3 },
  shaker_groove: { authenticity: 0.35, playfulness: 0.3, softness: 0.2 },
  // ---- explicit anti-identity markers (childish / cutesy / novelty) ----
  cutesy_melody: { bubblegum_pop_energy: 0.85, playfulness: 0.6, novelty_meme_energy: 0.2 },
  whistle_hook: { bubblegum_pop_energy: 0.55, commercial_polish: 0.4, playfulness: 0.4 },
  hand_clap_pop: { bubblegum_pop_energy: 0.55, playfulness: 0.45, commercial_polish: 0.35 },
  baby_voice: { bubblegum_pop_energy: 0.7, teen_breakup_energy: 0.3 },
  sugary_synth: { bubblegum_pop_energy: 0.6, commercial_polish: 0.35 },
  crush_lyrics: { teen_breakup_energy: 0.8, bubblegum_pop_energy: 0.3 },
  boyfriend_lyrics: { teen_breakup_energy: 0.85, bubblegum_pop_energy: 0.3 },
  puppy_love_lyrics: { teen_breakup_energy: 0.8, bubblegum_pop_energy: 0.35 },
  highschool_lyrics: { teen_breakup_energy: 0.75 },
  teen_breakup_lyrics: { teen_breakup_energy: 0.9 },
  novelty_hook: { novelty_meme_energy: 0.85, playfulness: 0.6 },
  meme_lyrics: { novelty_meme_energy: 0.85, playfulness: 0.55 },
  joke_lyrics: { novelty_meme_energy: 0.8, playfulness: 0.55 },
  gimmick_vocal: { novelty_meme_energy: 0.6, playfulness: 0.4 },
};

const MOOD_MAP: Record<string, Contrib> = {
  vulnerable: { emotional_maturity: 0.5, introspection: 0.5, softness: 0.4, seriousness: 0.35 },
  longing: { introspection: 0.5, emotional_maturity: 0.4, seriousness: 0.3 },
  haunted: { darkness: 0.7, introspection: 0.4, seriousness: 0.45, cinematic_feel: 0.35 },
  defiant: { confidence: 0.55, rebelliousness: 0.6, aggression: 0.3, seriousness: 0.3 },
  reckless: { rebelliousness: 0.55, aggression: 0.4 },
  confident: { confidence: 0.7, ambition: 0.4 },
  euphoric: { playfulness: 0.35 },
  tender: { softness: 0.6, emotional_maturity: 0.35, authenticity: 0.3 },
  warm: { softness: 0.4, authenticity: 0.3 },
  moody: { darkness: 0.45, introspection: 0.4, seriousness: 0.35 },
  sad: { introspection: 0.5, darkness: 0.35, emotional_maturity: 0.4, seriousness: 0.4 },
  aggressive: { aggression: 0.7, rebelliousness: 0.4 },
  happy: { playfulness: 0.5, bubblegum_pop_energy: 0.3 },
  bubbly: { bubblegum_pop_energy: 0.7, playfulness: 0.6 },
  cute: { bubblegum_pop_energy: 0.6, novelty_meme_energy: 0.35, playfulness: 0.5 },
  silly: { novelty_meme_energy: 0.6, playfulness: 0.55 },
  romantic: { softness: 0.35, emotional_maturity: 0.25 },
};

const GENRE_KEYWORDS: { match: string[]; contrib: Contrib }[] = [
  { match: ['drill', 'trap', 'rap', 'hip'], contrib: { ambition: 0.4, confidence: 0.35, rawness: 0.3, rebelliousness: 0.3, seriousness: 0.25, aggression: 0.25 } },
  { match: ['indie', 'alt', 'bedroom'], contrib: { authenticity: 0.45, introspection: 0.35, sophistication: 0.3, lyrical_maturity: 0.3 } },
  { match: ['rock', 'punk', 'grunge', 'metal'], contrib: { rawness: 0.5, rebelliousness: 0.45, aggression: 0.35, authenticity: 0.35 } },
  { match: ['dark', 'noir', 'industrial', 'phonk'], contrib: { darkness: 0.6, seriousness: 0.4, cinematic_feel: 0.35, aggression: 0.25 } },
  { match: ['ambient', 'folk', 'lo-fi', 'lofi'], contrib: { introspection: 0.4, softness: 0.35, authenticity: 0.4, sophistication: 0.3 } },
  { match: ['cinematic', 'score', 'orchestral'], contrib: { cinematic_feel: 0.7, sophistication: 0.5, seriousness: 0.4 } },
  { match: ['bubblegum', 'teen', 'tween', 'kidz', 'nursery'], contrib: { bubblegum_pop_energy: 0.7, teen_breakup_energy: 0.4, playfulness: 0.4 } },
  { match: ['novelty', 'meme', 'parody', 'comedy'], contrib: { novelty_meme_energy: 0.8, playfulness: 0.5 } },
  { match: ['house', 'techno', 'electronic', 'edm'], contrib: { cinematic_feel: 0.3, confidence: 0.2 } },
  { match: ['pop'], contrib: { commercial_polish: 0.35, playfulness: 0.2 } },
];

const ANTI_SKIP_RISKS = ['childish', 'cheesy', 'corny', 'novelty', 'cringe', 'juvenile', 'immature', 'gimmick'];

function add(v: IdentityVector, c: Contrib, weight: number): void {
  for (const k in c) {
    const dim = k as IdentityDim;
    v[dim] += (c[dim] ?? 0) * weight;
  }
}

// Cache: identity vectors are pure of song metadata and read many times per
// refill. Keyed by song id — derivation is stable for a given catalog entry.
const vectorCache = new Map<string, IdentityVector>();

/** Derive a song's identity vector (each dimension 0..1). Pure + cached. */
export function songIdentityVector(song: Song): IdentityVector {
  const cached = vectorCache.get(song.id);
  if (cached) return cached;

  const v = emptyVector();

  for (const tag of song.microtags ?? []) {
    if (tag.startsWith('mood_')) {
      const m = MOOD_MAP[tag.slice(5)];
      if (m) add(v, m, 0.6);
    } else {
      const c = MICROTAG_MAP[tag];
      if (c) add(v, c, 1);
    }
  }
  if (song.mood && MOOD_MAP[song.mood]) add(v, MOOD_MAP[song.mood], 1);

  const genreText = ((song.genres && song.genres.length > 0 ? song.genres.join(' ') : song.genre) || '').toLowerCase();
  for (const g of GENRE_KEYWORDS) {
    if (g.match.some((m) => genreText.includes(m))) add(v, g.contrib, 1);
  }

  // numeric priors
  v.commercial_polish += (song.mainstream_fit ?? 0) * 0.7;
  v.commercial_polish += (song.hook_strength ?? 0) * 0.2;
  const weird = song.weirdness_score ?? 0;
  v.authenticity += weird * 0.35;
  v.rawness += weird * 0.3;
  v.commercial_polish -= weird * 0.4;
  const uniq = song.uniqueness_score_v2 ?? 0;
  v.sophistication += uniq * 0.3;
  v.authenticity += uniq * 0.2;
  if (song.energy_score > 0.8) v.aggression += 0.15;
  for (const r of song.skip_risks ?? []) {
    if (ANTI_SKIP_RISKS.some((k) => r.toLowerCase().includes(k))) {
      v.bubblegum_pop_energy += 0.3;
      v.novelty_meme_energy += 0.25;
    }
  }

  // clamp every dim 0..1
  for (const d of IDENTITY_DIMS) v[d] = clamp(v[d], 0, 1);

  // A genuinely dark / serious / aggressive / introspective song is not
  // "bubblegum" even if it is also polished — suppress the anti-dims by how
  // mature the song reads. This stops e.g. a polished dark-pop track from
  // being mislabelled childish.
  const mature = Math.max(v.seriousness, v.darkness, v.aggression, v.introspection, v.lyrical_maturity, v.emotional_maturity);
  const suppress = clamp(1 - mature, 0.12, 1);
  v.bubblegum_pop_energy *= suppress;
  v.teen_breakup_energy *= suppress;
  v.novelty_meme_energy *= suppress;

  vectorCache.set(song.id, v);
  return v;
}

// ---- behavioural signal weights ----------------------------------------

const SIGNAL_WEIGHTS: Record<string, number> = {
  replay: 3.0, save: 3.0, share: 3.5, follow: 3.0, like: 2.5,
  completion_over_70: 2.0, listen_60s: 0.8, listen_30s: 0.3,
  skip_under_5: -3.0, skip_under_15: -1.2, unlike: -1.5, unsave: -2.0,
};

// ---- tuning -------------------------------------------------------------

/** Affinity smoothing — needs a little evidence before it swings hard. */
const AFFINITY_K = 1.5;
/** Per-dimension evidence mass for full per-dim confidence. */
const EVIDENCE_FULL = 4;
/** Interactions for full overall confidence — identity stays quiet before this
 *  so one or two early songs cannot define a user. */
const INTERACTIONS_FOR_CONFIDENCE = 6;
/** Gentle per-update decay so recent behaviour leads and taste CAN change. */
const PROFILE_DECAY = 0.985;
const SCHEMA_VERSION = 1;

const BOOST_SCALE = 1.7;
const MAX_BOOST = 4;
const MAX_PENALTY = -7;
/** A Blocked-zone song is pushed to at least this penalty. */
const BLOCKED_FLOOR = -5;
/** |affinity| above this counts as a strong like/dislike. */
const STRONG_AFFINITY = 0.45;
/** A song expresses a dimension "strongly" above this. */
const STRONG_PRESENT = 0.5;
const CONF_GATE = 0.5;
const CORE_FIT = 0.9;

export interface IdentityEvaluation {
  /** Capped additive modifier: roughly [-7, +4]. */
  boost: number;
  zone: IdentityZone;
  /** Signed pre-cap fit. */
  fit: number;
  /** Count of dims the song expresses strongly that the user strongly dislikes. */
  conflicts: number;
  /** Count of dims the song expresses strongly that the user strongly likes. */
  anchors: number;
}

export interface ScoreIdentityOptions {
  /** The user explicitly searched / clicked into this context (artist, mood,
   *  world, search). A strong mismatch penalty is then heavily softened —
   *  the brief's "unless user explicitly searched/clicked that context". */
  explicit?: boolean;
  /** Discovery surface — Controlled-Surprise songs are allowed through. */
  discoveryMode?: boolean;
}

// ============================================================

/**
 * The learned behavioural identity profile for one user. Persistence is
 * handled by identityStore.ts via the onChange hook — this class stays pure.
 */
export class TasteIdentityProfile {
  /** Positive / negative evidence mass per dimension. */
  private pos: IdentityVector = emptyVector();
  private neg: IdentityVector = emptyVector();
  private interactions = 0;
  private hydrated = false;
  private onChange: (() => void) | null = null;

  setOnChange(cb: (() => void) | null): void { this.onChange = cb; }
  isHydrated(): boolean { return this.hydrated; }
  markHydrated(): void { this.hydrated = true; }

  // ---- learning ---------------------------------------------------------

  /**
   * Update the profile from one behavioural event on a song. `kinds` are the
   * same signal strings the rest of the stack already uses, plus 'follow'.
   * `ended` mirrors the other engines — true for a finished/skipped song.
   *
   * Strong positives (replay/save/share/follow/completion) pull the user's
   * affinity TOWARD that song's identity; strong negatives (hard skip,
   * repeated skips) push it AWAY. A gentle decay each update keeps recent
   * behaviour in front so a genuine taste change can land over time. One
   * event never "overreacts": the smoothing constant + the overall-confidence
   * gate keep a single signal small.
   */
  update(song: Song, kinds: string[], ended: boolean = true): void {
    let w = 0;
    for (const k of kinds) w += SIGNAL_WEIGHTS[k] ?? 0;
    if (w === 0 && !ended) return;

    // decay first so the accumulators track recent behaviour
    for (const d of IDENTITY_DIMS) {
      this.pos[d] *= PROFILE_DECAY;
      this.neg[d] *= PROFILE_DECAY;
    }
    if (w !== 0) {
      const vec = songIdentityVector(song);
      const mag = Math.abs(w);
      for (const d of IDENTITY_DIMS) {
        const present = vec[d];
        if (present <= 0) continue;
        if (w > 0) this.pos[d] += mag * present;
        else this.neg[d] += mag * present;
      }
    }
    if (ended) this.interactions += 1;
    this.onChange?.();
  }

  // ---- profile readouts -------------------------------------------------

  /** Signed affinity for a dimension, smoothed into [-1, 1]. */
  affinity(dim: IdentityDim): number {
    const p = this.pos[dim];
    const n = this.neg[dim];
    return (p - n) / (p + n + AFFINITY_K);
  }

  /** 0..1 — how much evidence backs this dimension. */
  dimConfidence(dim: IdentityDim): number {
    return clamp((this.pos[dim] + this.neg[dim]) / EVIDENCE_FULL, 0, 1);
  }

  /** 0..1 — overall trust in the identity profile. Ramps with interactions so
   *  identity stays quiet until behaviour has actually appeared. */
  overallConfidence(): number {
    return clamp(this.interactions / INTERACTIONS_FOR_CONFIDENCE, 0, 1);
  }

  // ---- scoring ----------------------------------------------------------

  /**
   * Evaluate a candidate song against the learned identity. Classifies it
   * into one of four zones and returns the capped additive boost:
   *   A core      — strongly identity-compatible            → up to +4
   *   B adjacent  — different style, same deeper identity    → small +
   *   C surprise  — novel, but shares ≥1 strong anchor       → small + (gated)
   *   D blocked   — multiple identity conflicts              → −5 … −7
   */
  evaluate(song: Song, opts: ScoreIdentityOptions = {}): IdentityEvaluation {
    const vec = songIdentityVector(song);
    const overall = this.overallConfidence();

    let fit = 0;
    let conflicts = 0;
    let anchors = 0;
    let severeConflict = false;

    for (const d of IDENTITY_DIMS) {
      const present = vec[d];
      if (present <= 0.001) continue;
      const aff = this.affinity(d);
      const dc = this.dimConfidence(d);
      fit += aff * present * dc;
      if (present >= STRONG_PRESENT && dc >= CONF_GATE) {
        if (aff <= -STRONG_AFFINITY) {
          conflicts += 1;
          if (present >= 0.7 && aff <= -0.7) severeConflict = true;
        } else if (aff >= STRONG_AFFINITY) {
          anchors += 1;
        }
      }
    }

    // ---- zone classification ----
    let zone: IdentityZone;
    if (conflicts >= 2 || severeConflict) zone = 'blocked';
    else if (conflicts >= 1) zone = fit > 0 ? 'adjacent' : 'neutral';
    else if (fit >= CORE_FIT) zone = 'core';
    else if (anchors >= 1) zone = 'surprise';
    else if (fit > 0.1) zone = 'adjacent';
    else zone = 'neutral';

    // ---- boost mapping ----
    let boost = fit * BOOST_SCALE;
    if (zone === 'blocked') boost = Math.min(boost, BLOCKED_FLOOR);
    if (zone === 'surprise') {
      // Controlled surprise: only let the positive through when confidence is
      // high or the user is explicitly in discovery / chose this context.
      if (!opts.discoveryMode && !opts.explicit && overall < 0.7) boost *= 0.3;
    }
    boost = clamp(boost, MAX_PENALTY, MAX_BOOST);
    // Scale by overall confidence — identity stays near-silent for a brand-new
    // user and never "overreacts" before behaviour has appeared.
    boost *= overall;
    // The user explicitly searched / clicked this context — a strong mismatch
    // is softened so we never block what they asked for.
    if (opts.explicit && boost < 0) boost *= 0.15;

    return { boost, zone, fit, conflicts, anchors };
  }

  // ---- debug ------------------------------------------------------------

  /** getIdentityDebug — top liked / disliked dimensions + confidence. */
  debug() {
    const ranked = IDENTITY_DIMS
      .map((d) => ({ dim: d, affinity: Number(this.affinity(d).toFixed(2)), confidence: Number(this.dimConfidence(d).toFixed(2)) }))
      .filter((x) => x.confidence > 0.15);
    ranked.sort((a, b) => b.affinity - a.affinity);
    return {
      interactions: this.interactions,
      overallConfidence: Number(this.overallConfidence().toFixed(3)),
      likes: ranked.filter((x) => x.affinity >= STRONG_AFFINITY).map((x) => x.dim),
      dislikes: ranked.filter((x) => x.affinity <= -STRONG_AFFINITY).map((x) => x.dim),
      top: ranked.slice(0, 5),
    };
  }

  // ---- persistence (called by identityStore.ts) -------------------------

  serialize(): string {
    return JSON.stringify({ v: SCHEMA_VERSION, pos: this.pos, neg: this.neg, interactions: this.interactions });
  }

  restoreFrom(raw: string | null | undefined): void {
    if (raw) {
      try {
        const p = JSON.parse(raw) as { pos?: IdentityVector; neg?: IdentityVector; interactions?: number };
        if (p && p.pos && p.neg) {
          for (const d of IDENTITY_DIMS) {
            this.pos[d] = Number.isFinite(p.pos[d]) ? p.pos[d] : 0;
            this.neg[d] = Number.isFinite(p.neg[d]) ? p.neg[d] : 0;
          }
          this.interactions = p.interactions ?? 0;
        }
      } catch {
        // corrupt blob — start fresh
      }
    }
    this.hydrated = true;
  }
}

// ---- function-form API (mirrors the brief) ------------------------------

/** updateIdentityProfile(event, song) — see TasteIdentityProfile.update. */
export function updateIdentityProfile(
  profile: TasteIdentityProfile,
  song: Song,
  kinds: string[],
  ended: boolean = true,
): void {
  profile.update(song, kinds, ended);
}

/** scoreIdentityFit(song, identityProfile) — the capped additive boost. */
export function scoreIdentityFit(
  song: Song,
  profile: TasteIdentityProfile | null | undefined,
  opts: ScoreIdentityOptions = {},
): number {
  if (!profile) return 0;
  return profile.evaluate(song, opts).boost;
}

/** getIdentityDebug(identityProfile) — inspect the learned identity. */
export function getIdentityDebug(profile: TasteIdentityProfile | null | undefined) {
  return profile ? profile.debug() : null;
}
