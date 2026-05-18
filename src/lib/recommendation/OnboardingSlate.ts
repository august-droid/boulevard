import type { Song } from '@/types';
import type { ColdStartCohort } from './ColdStartCohortPrior';
import type { TasteIdentityProfile } from './TasteIdentityProfile';

// ============================================================
// First-session onboarding slate (cold-start personalization).
//
// WHY THIS EXISTS
// ---------------
// The lifetime ranker (RecommendationEngine) only starts trusting behaviour
// after ~10 interactions; before that it leans almost entirely on editorial
// priors (launch_score / is_featured / mainstream_fit). That makes Boulevard
// feel generic for a brand-new user's first few songs.
//
// This module implements the "adaptive 10-song mini-slate" from the strategy
// brief (Designing Boulevard's First Ten Songs — TikTok/Spotify lessons):
// confidence-weighted personalization under uncertainty. It runs ONLY for the
// first 10 songs of a new user, then hands back to the normal ranker.
//
// It is deliberately SELF-CONTAINED — no runtime imports (only the Song type,
// erased at compile time) — so it is fast, easy to test in isolation, and
// cannot break the rest of the personalization stack. It does NOT replace the
// lifetime TasteProfile, session decay, microtag scoring, artist spacing, the
// 24h exposure log, mood chips, Explore lanes, or Daily You — those keep
// running untouched. This is an additive layer on top.
//
// THE SLATE (user spec / brief slot table)
// ----------------------------------------
//   Slots 1-2  trust builders      — very safe, broadly-appealing, no novelty
//   Slot  3    slight adjacent     — same vibe, one dimension varied
//   Slots 4-5  controlled probes   — deliberate taste probes (information gain)
//   Slot  6    recovery-safe       — re-anchors if skips happened
//   Slots 7-8  anchored surprise   — serendipity that still shares an anchor
//   Slot  9    exploit             — lean into the strongest learned signal
//   Slot 10    retention hook      — high save/follow potential closer
//
// After EVERY signal (skip / completion / replay / like / save / share) the
// session state updates and the unplayed slots are re-scored and re-picked.
// Already-played slots are frozen.
// ============================================================

export type SlotRole =
  | 'trust'
  | 'adjacent'
  | 'probe'
  | 'recovery'
  | 'surprise'
  | 'exploit'
  | 'retention';

/** Fixed 10-slot blueprint. Index = play position. */
export const ONBOARDING_SLOT_ROLES: SlotRole[] = [
  'trust', 'trust', 'adjacent', 'probe', 'probe',
  'recovery', 'surprise', 'surprise', 'exploit', 'retention',
];

/** Onboarding covers the user's first 10 songs. Aligned with the ranker's
 *  COLD_START_THRESHOLD so the hand-off is seamless. */
export const ONBOARDING_SIZE = 10;

export type OnboardingSignalKind =
  | 'skip_under_5'
  | 'skip_under_15'
  | 'listen_30s'
  | 'listen_60s'
  | 'completion_over_70'
  | 'save'
  | 'unsave'
  | 'like'
  | 'unlike'
  | 'replay'
  | 'share';

// Faster-learning weights — used ONLY inside onboarding (user spec #3). These
// are intentionally sharper than the lifetime TasteProfile weights so the
// slate visibly adapts within 2-3 songs instead of 10-20.
const ONBOARDING_WEIGHTS: Record<OnboardingSignalKind, number> = {
  skip_under_5: -5.0,        // strong hard-negative
  skip_under_15: -2.2,       // negative
  listen_30s: 1.0,           // soft positive
  // A brand-new user staying past ~1 minute is a STRONG positive — they
  // "just arrived" and chose to keep listening, which is real intent.
  listen_60s: 3.6,           // strong positive
  completion_over_70: 4.5,   // strong positive
  replay: 6.5,               // very strong positive
  save: 6.0,                 // very strong positive
  like: 5.0,                 // very strong positive
  share: 7.0,                // very strong positive
  unsave: -3.0,
  unlike: -2.5,
};

/** 2 hits flip a cluster — "2 skips suppress / 2 completions lean in" (spec #3). */
const CLUSTER_FLIP_THRESHOLD = 2;

/** Microtag substrings that hard-block a track during a safety-mode onboarding
 *  (age-unknown user). Boulevard's analyzer microtags are mostly physical, so
 *  this is a defensive denylist rather than the main gate. */
const UNSAFE_TAG_PATTERNS = [
  'explicit', 'sexual', 'self_harm', 'selfharm', 'suicide', 'slur', 'hate',
  'graphic_violence', 'gore', 'drug_glorif',
];

export interface SlateEntry {
  role: SlotRole;
  song: Song;
  /** Why this song was chosen — surfaced in debug output. */
  reason: string;
}

export interface BuildOptions {
  /** Strict content + novelty gating. Boulevard never collects age, so the
   *  brief's "age-unknown ⇒ strict" rule means this is ON by default. */
  safetyMode?: boolean;
  /** A song already staged / chosen by the user (cold-start staged track or a
   *  mood-pick). Used as an initial trust anchor so slot 2+ feels coherent. */
  seedSong?: Song | null;
  /** Cold-start demographic/cohort prior — a SMALL, decaying onboarding-only
   *  boost (see ColdStartCohortPrior.ts). Optional: when absent the slate
   *  behaves exactly as it did before this layer existed. */
  cohort?: ColdStartCohort | null;
  /** Behavioural taste-identity profile (see TasteIdentityProfile.ts). The
   *  slate READS it for an identity-fit boost; it is updated by PlayerContext
   *  on every signal, so during onboarding it learns and tightens live.
   *  Optional: when absent the slate is unchanged. */
  identity?: TasteIdentityProfile | null;
}

export type ConfidenceBucket = 'low' | 'medium' | 'high';

// ---- small pure helpers --------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// Cluster identity for the slate's diversity cap + suppress/lean logic.
// Genre is the primary key: it is always populated and meaningfully varied,
// whereas `similarity_cluster` is frequently a single default value across
// the whole catalog — keying on it alone would collapse every song into one
// cluster and break the diversity cap. similarity_cluster only refines it.
const clusterKey = (s: Song) => (s.genre || String(s.similarity_cluster));
const quality = (s: Song) =>
  (s.hook_strength ?? 0) * 1.5 +
  (s.mainstream_fit ?? 0) * 1.0 +
  (s.launch_score ?? 0) * 1.0 +
  (s.quality_score ?? 0) * 0.5;

/** How many "anchors" two songs share — the brief's anchored-novelty axes:
 *  tempo, energy, vocal style, mood, microtag, genre/cluster. */
function anchorMatchCount(a: Song, b: Song): number {
  let n = 0;
  if (a.bpm != null && b.bpm != null && Math.abs(a.bpm - b.bpm) <= 14) n++;
  if (Math.abs(a.energy_score - b.energy_score) <= 0.16) n++;
  if (a.vocal_type === b.vocal_type) n++;
  if (a.mood && b.mood && a.mood === b.mood) n++;
  const at = a.microtags ?? [];
  const bt = new Set(b.microtags ?? []);
  if (at.some((t) => bt.has(t))) n++;
  if (a.similarity_cluster === b.similarity_cluster || a.genre === b.genre) n++;
  return n;
}

// ============================================================

let DEBUG = false;
/** Toggle verbose console output (used by the verification script). */
export function setOnboardingDebug(on: boolean) { DEBUG = on; }
function log(...args: unknown[]) { if (DEBUG) console.log('[onboarding]', ...args); }

export class OnboardingSlate {
  private entries: SlateEntry[] = [];
  /** Pre-built candidate pool — 50-200 safety-filtered songs (spec #9). */
  private pool: Song[] = [];
  private safetyMode: boolean;

  /** Songs that have actually been played (slate picks OR user picks). */
  private playedIds = new Set<string>();
  /** Number of songs that have ended during onboarding. Indexes the blueprint. */
  private playedCount = 0;

  // ---- learned session state (resets nothing — purely onboarding-local) ----
  /** Per-microtag running score from onboarding signals. */
  private microtagScore = new Map<string, number>();
  /** Per-cluster running score + skip/completion tallies. */
  private clusterScore = new Map<string, number>();
  private clusterSkips = new Map<string, number>();
  private clusterCompletes = new Map<string, number>();
  /** Clusters to avoid (2+ skips) and lean into (2+ completions) — spec #3. */
  private suppressedClusters = new Set<string>();
  private leanClusters = new Set<string>();
  /** Songs that produced a positive signal — anchors for surprise + recovery. */
  private positives: Song[] = [];
  /** Last song with a positive signal — the recovery target. */
  private lastPositive: Song | null = null;
  /** Set by a hard skip; the next re-rank turns the next slot into recovery. */
  private recoveryPending = false;
  /** The most recently hard-skipped song — recovery must not echo it. */
  private lastHardSkip: Song | null = null;

  private positiveMass = 0;
  private negativeMass = 0;

  /** Cold-start cohort prior — a small, decaying onboarding-only boost. Null
   *  when no signup signals were available. */
  private cohort: ColdStartCohort | null;
  /** Behavioural taste-identity profile (read-only here — PlayerContext owns
   *  updates). Adds a capped identity-fit boost once behaviour has appeared. */
  private identity: TasteIdentityProfile | null;
  /** Instant-skip recovery (PART 3C): microtags of a just-hard-skipped song,
   *  temporarily down-weighted so recovery moves away from that exact sound.
   *  Decays toward zero over the next few interactions. */
  private recentlySkippedMicrotags = new Map<string, number>();

  constructor(catalog: Song[], opts: BuildOptions = {}) {
    // Age-unknown / under-18 cohorts force strict gating; safetyMode defaults on.
    this.safetyMode = opts.safetyMode ?? opts.cohort?.safetyMode ?? true;
    this.cohort = opts.cohort ?? null;
    this.identity = opts.identity ?? null;
    this.pool = this.buildPool(catalog);
    if (opts.seedSong) {
      // A user-chosen seed is the strongest possible trust anchor.
      this.positives.push(opts.seedSong);
      this.lastPositive = opts.seedSong;
    }
    this.assemble();
    log('built slate, pool size', this.pool.length, '\n' + this.describe());
  }

  // ---- pool construction (spec #8 safety + #9 performance) ---------------

  private isSafe(s: Song): boolean {
    if (!this.safetyMode) return true;
    const tags = s.microtags ?? [];
    if (tags.some((t) => UNSAFE_TAG_PATTERNS.some((p) => t.toLowerCase().includes(p)))) {
      return false;
    }
    const risks = s.skip_risks ?? [];
    if (risks.some((r) => /explicit|offensive|nsfw/i.test(r))) return false;
    // Very polarizing / extreme productions are soft-blocked until confidence
    // is high (handled in scoring); only the clearly-unsafe are hard-cut here.
    return true;
  }

  /** Build the 50-200 song candidate pool ONCE. Re-ranking after each signal
   *  only re-scores this pool — no catalog re-scan, no network, no model. */
  private buildPool(catalog: Song[]): Song[] {
    const eligible = catalog.filter(
      (s) =>
        !!s.audio_url &&
        (s.distribution_stage ?? 'new_test') !== 'suppressed' &&
        this.isSafe(s),
    );
    // Rank by editorial quality so the pool is the "broad, safe, high-
    // probability" content the brief calls for, then keep the top 50-200.
    const ranked = eligible
      .map((s) => ({ s, q: quality(s) }))
      .sort((a, b) => b.q - a.q);
    const size = clamp(ranked.length, 0, 200);
    return ranked.slice(0, size).map((x) => x.s);
  }

  // ---- confidence (spec #4) ----------------------------------------------

  /** 0..1 — how sure we are about this user's taste. Drives the novelty budget. */
  confidence(): number {
    const total = this.positiveMass + this.negativeMass;
    if (total < 0.5) return 0.15; // brand-new — start cautious
    const ratio = this.positiveMass / (this.positiveMass + this.negativeMass + 3);
    const evidence = clamp(total / 14, 0, 1); // "enough evidence" after ~3 strong signals
    return clamp(ratio * 0.55 + ratio * evidence * 0.45 + evidence * 0.1, 0, 1);
  }

  confidenceBucket(): ConfidenceBucket {
    const c = this.confidence();
    return c < 0.34 ? 'low' : c < 0.67 ? 'medium' : 'high';
  }

  // ---- signal intake -----------------------------------------------------

  /**
   * Apply a batch of signals for one song and re-rank the unplayed slate.
   *
   * `ended` = true when the song fully finished/was-skipped (advances the
   * blueprint cursor). false for mid-song signals (like/save/replay/share)
   * where the song keeps playing and only the FUTURE slots may change.
   */
  applySignal(song: Song, kinds: OnboardingSignalKind[], ended: boolean): void {
    if (kinds.length === 0 && !ended) return;
    this.playedIds.add(song.id);

    let net = 0;
    for (const k of kinds) {
      const w = ONBOARDING_WEIGHTS[k] ?? 0;
      net += w;
      if (w > 0) this.positiveMass += w;
      else this.negativeMass += -w;
    }

    // Spread the net signal across the song's microtags + its cluster.
    const tags = song.microtags ?? [];
    if (tags.length > 0) {
      const share = net / tags.length;
      for (const t of tags) this.microtagScore.set(t, (this.microtagScore.get(t) ?? 0) + share);
    }
    const ck = clusterKey(song);
    this.clusterScore.set(ck, (this.clusterScore.get(ck) ?? 0) + net);

    // Hard-negative / strong-positive cluster tallies — "2 to flip" (spec #3).
    const hardSkip = kinds.includes('skip_under_5');
    const anySkip = hardSkip || kinds.includes('skip_under_15');
    const strongPositive =
      kinds.includes('completion_over_70') ||
      kinds.includes('replay') || kinds.includes('save') ||
      kinds.includes('like') || kinds.includes('share');

    if (anySkip) {
      const n = (this.clusterSkips.get(ck) ?? 0) + 1;
      this.clusterSkips.set(ck, n);
      if (n >= CLUSTER_FLIP_THRESHOLD) {
        this.suppressedClusters.add(ck);
        this.leanClusters.delete(ck);
        log('cluster', ck, 'SUPPRESSED after', n, 'skips');
      }
    }
    if (strongPositive) {
      const n = (this.clusterCompletes.get(ck) ?? 0) + 1;
      this.clusterCompletes.set(ck, n);
      if (n >= CLUSTER_FLIP_THRESHOLD) {
        this.leanClusters.add(ck);
        this.suppressedClusters.delete(ck);
        log('cluster', ck, 'LEAN-IN after', n, 'completions');
      }
      this.positives.push(song);
      this.lastPositive = song;
    }

    // Hard skip → recovery mode: the next slot becomes a safe re-anchor.
    if (hardSkip) {
      this.recoveryPending = true;
      this.lastHardSkip = song;
      // Instant skip recovery (PART 3C): temporarily down-weight the rejected
      // song's strongest microtags so the recovery slot steps away from that
      // exact sound, not just its cluster.
      for (const t of (song.microtags ?? []).slice(0, 6)) {
        this.recentlySkippedMicrotags.set(t, (this.recentlySkippedMicrotags.get(t) ?? 0) + 3);
      }
      log('hard skip on', JSON.stringify(song.title), '→ recovery armed');
    }

    // Behaviour-override feed for the cold-start cohort prior: every signal
    // decays the cohort, and a contradicting skip collapses/suppresses it.
    this.cohort?.registerOutcome(song, kinds, ended);

    if (ended) {
      this.playedCount += 1;
      // Decay the temporary skip-microtag suppression so it only shapes the
      // next ~2-3 slots, then fades.
      for (const [t, v] of this.recentlySkippedMicrotags) {
        const next = v * 0.5;
        if (next < 0.4) this.recentlySkippedMicrotags.delete(t);
        else this.recentlySkippedMicrotags.set(t, next);
      }
    }

    // Re-rank: on a finished song we may also re-target the immediate next
    // slot (recovery needs that); on a mid-song signal we keep the next slot
    // stable and only reshape what's further out.
    const fromIndex = ended ? this.playedCount : this.playedCount + 1;
    this.rerank(fromIndex);
    log(
      `signal [${kinds.join(',') || 'ended'}] on`, JSON.stringify(song.title),
      `| net ${net.toFixed(1)} | confidence ${this.confidence().toFixed(2)} (${this.confidenceBucket()})`,
    );
  }

  // ---- slate assembly + re-ranking ---------------------------------------

  /** Initial build — fill all 10 slots from scratch. */
  private assemble(): void {
    this.entries = [];
    this.fillFrom(0);
  }

  /** Re-pick slots [fromIndex..9]. Slots before fromIndex are frozen — the
   *  played songs and (mid-song) the currently-playing song never change. */
  private rerank(fromIndex: number): void {
    const start = clamp(fromIndex, 0, ONBOARDING_SIZE);
    this.entries = this.entries.slice(0, start);
    this.fillFrom(start);
  }

  /** Greedy slot-by-slot fill. Each slot takes the highest-scoring candidate
   *  for its role that satisfies the diversity + safety constraints. */
  private fillFrom(start: number): void {
    const usedIds = new Set<string>([...this.playedIds, ...this.entries.map((e) => e.song.id)]);
    const clusterCounts = new Map<string, number>();
    for (const e of this.entries) {
      clusterCounts.set(clusterKey(e.song), (clusterCounts.get(clusterKey(e.song)) ?? 0) + 1);
    }

    for (let i = start; i < ONBOARDING_SIZE; i++) {
      // Recovery override: the FIRST slot re-picked right after a hard skip
      // becomes a recovery slot regardless of its blueprint role (spec #6).
      let role = ONBOARDING_SLOT_ROLES[i];
      if (this.recoveryPending && i === start) {
        role = 'recovery';
        this.recoveryPending = false;
      }

      const prev = this.entries[i - 1]?.song ?? null;
      const prev2 = this.entries[i - 2]?.song ?? null;
      const picked = this.pickForSlot(role, i, prev, prev2, usedIds, clusterCounts);
      if (!picked) break; // pool exhausted — producer tops up with the ranker
      this.entries.push(picked);
      usedIds.add(picked.song.id);
      clusterCounts.set(
        clusterKey(picked.song),
        (clusterCounts.get(clusterKey(picked.song)) ?? 0) + 1,
      );
    }
  }

  private pickForSlot(
    role: SlotRole,
    slotIndex: number,
    prev: Song | null,
    prev2: Song | null,
    usedIds: Set<string>,
    clusterCounts: Map<string, number>,
  ): SlateEntry | null {
    let best: Song | null = null;
    let bestScore = -Infinity;
    let bestReason = '';

    for (const cand of this.pool) {
      if (usedIds.has(cand.id)) continue;

      // ---- hard diversity constraints (spec #7) ----
      // Never the same artist back-to-back.
      if (prev && cand.artist_id && cand.artist_id === prev.artist_id) continue;
      // Fatigue cap — max 2 songs from the same micro-cluster across the
      // first 8 slots (the brief scopes the cap to slots 1-8). The exploit +
      // retention closers (slots 9-10) are exempt so they can revisit a
      // cluster the user has clearly committed to.
      if (slotIndex < 8 && (clusterCounts.get(clusterKey(cand)) ?? 0) >= 2) continue;
      // No 3-in-a-row of the exact same mood — scoped to the first 8 slots,
      // exactly like the fatigue cap above. The exploit + retention closers
      // (slots 9-10) are exempt: a user who has clearly committed to one
      // mood lane should get closers IN that lane. Without this exemption the
      // guard bans the user's whole lane from the exploit slot whenever slots
      // 7-8 already landed in it — which defeats the exploit slot's purpose.
      if (slotIndex < 8 && prev && prev2 && cand.mood && cand.mood === prev.mood && cand.mood === prev2.mood) {
        continue;
      }

      const { score, reason } = this.scoreForRole(cand, role, slotIndex, prev, prev2, clusterCounts);
      if (score > bestScore) {
        bestScore = score;
        best = cand;
        bestReason = reason;
      }
    }

    return best ? { role, song: best, reason: bestReason } : null;
  }

  /**
   * Role-aware score for a candidate. The novelty budget is gated by
   * confidence (spec #4): low confidence ⇒ safer/broader, high ⇒ deeper.
   */
  private scoreForRole(
    cand: Song,
    role: SlotRole,
    slotIndex: number,
    prev: Song | null,
    prev2: Song | null,
    clusterCounts: Map<string, number>,
  ): { score: number; reason: string } {
    const conf = this.confidence();
    const ck = clusterKey(cand);
    const base = quality(cand);
    const learned = this.learnedScore(cand);

    // Suppressed clusters are near-banished; lean-in clusters get a boost.
    let score = base + learned;
    if (this.suppressedClusters.has(ck)) score -= 20;
    if (this.leanClusters.has(ck)) score += 4;
    // Soft penalty for any genre the user has already skipped — move on
    // rather than re-serving a rejected lane (the hard suppress needs 2).
    score -= (this.clusterSkips.get(ck) ?? 0) * 5;

    // Cold-start cohort prior (PART 1). A SMALL additive boost that sits
    // below real behaviour (learned, above) and above editorial quality.
    // The cohort module caps it and decays it to ~0 by song 10.
    if (this.cohort) {
      score += this.cohort.scoreCohortFit(cand, { playedCount: this.playedCount });
    }

    // Taste-identity boost. Learns live during onboarding (PlayerContext
    // updates the shared profile after every signal); evaluate() self-gates on
    // behavioural confidence, so it stays ~0 for the first songs and tightens
    // as the user reveals their identity. Rewards identity-compatible songs,
    // penalises strong identity mismatches (e.g. childish/bubblegum tracks for
    // a mature listener) — capped additive, never overrides safety/behaviour.
    if (this.identity) {
      score += this.identity.evaluate(cand).boost;
    }

    // Instant skip recovery (PART 3C): step away from the exact sound of a
    // just-hard-skipped song for the next couple of slots.
    if (this.recentlySkippedMicrotags.size > 0) {
      let skipTagPenalty = 0;
      for (const t of cand.microtags ?? []) {
        skipTagPenalty += this.recentlySkippedMicrotags.get(t) ?? 0;
      }
      score -= Math.min(12, skipTagPenalty);
    }

    // PART 3D: across all 10 onboarding songs, lean on the catalog-wide
    // "this lands for new users" priors — a strong hook plus rising/trending
    // momentum. Additive emphasis on top of the quality() base.
    score += (cand.hook_strength ?? 0) * 1.0;
    const stage = cand.distribution_stage ?? 'new_test';
    if (stage === 'trending') score += 1.5;
    else if (stage === 'rising') score += 1.0;

    // Visual diversity (PART 3G): a same-artist portrait two slots back reads
    // as repetition even though it is not back-to-back (that is hard-blocked
    // in pickForSlot). Soft-penalise so artists/faces stay spaced.
    if (prev2 && cand.artist_id && cand.artist_id === prev2.artist_id) score -= 8;

    // "Searching" — no positive signal has landed yet. The trust anchors may
    // be the wrong lane entirely, so the novelty compass (measured against
    // them) is unreliable; the explore slots instead cast a wide net by
    // BREADTH — genres the slate has not tried yet — so a user whose taste
    // is far from mainstream pop still gets sampled into their lane.
    const searching = this.positives.length === 0;
    const untried = !clusterCounts.has(ck);

    // Extreme energy/loudness outliers cause instant skips early (brief
    // soft-block) — penalise until the user shows they want intensity.
    const extreme = cand.energy_score > 0.92 || cand.energy_score < 0.08;
    if (extreme && conf < 0.67) score -= 4;
    // Avoid abrupt energy jumps between adjacent slots unless confident.
    if (prev && Math.abs(cand.energy_score - prev.energy_score) > 0.5 && conf < 0.67) {
      score -= 3;
    }

    const novelty = this.noveltyOf(cand); // 0 = familiar, 1 = far from positives

    // PART 3B: the first 3 songs are pure trust-building. Heavily overweight
    // an immediate hook + broad appeal, force novelty very low, and reject
    // extremes / abrasive energy jumps regardless of confidence. Applies on
    // top of the per-role scoring below so trust roles get an extra anchor
    // and the slot-3 'adjacent' song still stays safe.
    if (slotIndex < 3) {
      score += (cand.hook_strength ?? 0) * 3.5;
      score += (cand.mainstream_fit ?? 0) * 2.5;
      score -= novelty * 5;
      score -= (cand.weirdness_score ?? 0) * 5;
      // skip_risks is the analyzer's "reasons this might get skipped" list —
      // a flagged song is a poor first impression.
      score -= (cand.skip_risks?.length ?? 0) * 2;
      if (extreme) score -= 6;
      if (prev && Math.abs(cand.energy_score - prev.energy_score) > 0.4) score -= 4;
    }

    let reason: string = role;

    switch (role) {
      case 'trust':
        // Very high-confidence, broadly-appealing, low-novelty.
        score += (cand.mainstream_fit ?? 0) * 3 + (cand.hook_strength ?? 0) * 1.5;
        score -= novelty * 6;                       // punish novelty hard
        score -= (cand.weirdness_score ?? 0) * 4;
        reason = 'trust: safe broad-appeal anchor';
        break;
      case 'adjacent':
        if (searching) {
          // Still no signal by slot 3 — the trust anchors were rejected, so
          // don't spend the slot on a mainstream variation of a rejected
          // lane; explore an un-tried genre instead.
          score += untried ? 6 + Math.random() * 8 : -4;
          reason = 'adjacent: wide exploration (no signal yet)';
        } else {
          // Same broad vibe, exactly one dimension varied from the anchor.
          if (prev) {
            const shared = anchorMatchCount(cand, prev);
            // Sweet spot: 3-4 shared anchors (close but not identical).
            score += shared >= 3 && shared <= 4 ? 5 : shared >= 2 ? 2 : -3;
          }
          score += (cand.mainstream_fit ?? 0) * 1.5;
          score -= novelty * 2;
          reason = 'adjacent: one-dimension variation';
        }
        break;
      case 'probe': {
        if (searching) {
          // No signal yet — cast the widest net: prefer un-tried genres, and
          // pick AMONG them with a strong random term (not by quality, which
          // would bias toward mainstream) so a far-from-mainstream taste gets
          // discovered and two users never get the same exploration sequence.
          score += untried ? 8 + Math.random() * 9 : -6;
          score += base * 0.15;
          reason = 'probe: wide exploration (no signal yet)';
        } else {
          // Deliberate taste probe — reward NEW territory to gain information,
          // but stay within the confidence-scaled novelty ceiling.
          const ceiling = 0.35 + conf * 0.4;        // low conf ⇒ tighter probe
          score += novelty <= ceiling ? novelty * 6 : -8;
          score += base * 0.5;
          reason = 'probe: controlled taste probe';
        }
        break;
      }
      case 'recovery':
        if (this.lastPositive) {
          // Safe re-anchor close to the last positive; low novelty.
          score += anchorMatchCount(cand, this.lastPositive) * 4;
          score -= novelty * 7;
          reason = 'recovery: safe re-anchor near last positive';
        } else {
          // No positive to recover toward — keep exploring un-tried genres
          // (randomised) rather than re-serving the rejected mainstream.
          score += untried ? 6 + Math.random() * 9 : -4;
          reason = 'recovery: widen — no positive yet';
        }
        // Never echo the just-hard-skipped cluster (spec #6).
        if (this.lastHardSkip && ck === clusterKey(this.lastHardSkip)) score -= 30;
        break;
      case 'surprise': {
        if (searching) {
          // Nothing to anchor a surprise to yet — treat the slot as wide,
          // randomised exploration so the slate keeps covering new genres.
          score += untried ? 7 + Math.random() * 9 : -5;
          score += base * 0.15;
          reason = 'surprise: wide exploration (no signal yet)';
        } else if (!this.isAnchored(cand)) {
          // Anchored serendipity (spec #5): a surprise MUST share >=1 anchor
          // with recent positive behaviour — un-anchored novelty is rejected.
          score -= 25;
          reason = 'surprise: REJECTED (un-anchored novelty)';
        } else {
          // An anchored song is always a valid surprise; the confidence-scaled
          // ceiling only caps how much novelty we reward and gently damps an
          // over-the-ceiling "abrupt jump".
          const ceiling = 0.55 + conf * 0.4;
          const rewarded = Math.min(novelty, ceiling);
          const overshoot = Math.max(0, novelty - ceiling);
          score += rewarded * 7 + 4 - overshoot * 6;
          reason = `surprise: anchored serendipity (novelty ${novelty.toFixed(2)})`;
        }
        break;
      }
      case 'exploit':
        if (searching) {
          // No learned signal — explore a fresh genre (randomised) rather
          // than serving the top mainstream song the user likely rejected.
          score += untried ? 5 + Math.random() * 9 : -3;
          reason = 'exploit: explore (no signal yet)';
        } else {
          // Lean hard into the single strongest learned signal.
          score += learned * 3;
          if (this.leanClusters.has(ck)) score += 8;
          reason = 'exploit: strongest learned signal';
        }
        break;
      case 'retention':
        // Memorable, save/follow-worthy closer. hook_strength is "how
        // immediately replayable the hook is"; uniqueness_score_v2 is
        // "distinct/memorable identity" — together they predict saves.
        score += (cand.hook_strength ?? 0) * 4 +
          (cand.uniqueness_score_v2 ?? 0) * 2 +
          (cand.mainstream_fit ?? 0) * 1.5;
        if (learned > 0) score += 3;                // bias toward a learned win
        reason = 'retention: high save/follow hook';
        break;
    }

    return { score, reason };
  }

  /** Sum of this user's learned microtag + cluster scores for a candidate. */
  private learnedScore(cand: Song): number {
    let s = 0;
    for (const t of cand.microtags ?? []) s += this.microtagScore.get(t) ?? 0;
    s += this.clusterScore.get(clusterKey(cand)) ?? 0;
    // Cap so one tag-rich song can't dominate.
    return clamp(s, -12, 12);
  }

  /** 0 (very familiar) .. 1 (far from anything the user liked). */
  private noveltyOf(cand: Song): number {
    const refs = this.positives.length > 0
      ? this.positives
      : this.entries.slice(0, 2).map((e) => e.song); // pre-signal: vs trust anchors
    if (refs.length === 0) return 0.5;
    let bestMatch = 0;
    for (const r of refs) bestMatch = Math.max(bestMatch, anchorMatchCount(cand, r));
    // 6 anchors max → invert to a 0..1 novelty score.
    return clamp(1 - bestMatch / 6, 0, 1);
  }

  /** Reference set a surprise must be tethered to: every song the user has
   *  positively engaged with, plus the (safe, accepted) trust anchors. */
  private anchorRefs(): Song[] {
    const refs = [...this.positives];
    for (const e of this.entries.slice(0, 2)) refs.push(e.song);
    return refs;
  }

  /** True when a candidate shares at least one anchor with recent positive
   *  behaviour — the gate for a valid "anchored surprise" (spec #5). */
  private isAnchored(cand: Song): boolean {
    return this.anchorRefs().some((r) => anchorMatchCount(cand, r) >= 1);
  }

  // ---- queue interface ---------------------------------------------------

  /** True once all 10 onboarding songs have played — producer hands back to
   *  the lifetime ranker after this. */
  isComplete(): boolean {
    return this.playedCount >= ONBOARDING_SIZE;
  }

  /**
   * The upcoming slate songs for the queue, excluding anything already in the
   * queue (`avoidIds`) or already played. The QueueManager dedupes the
   * currently-playing song via avoidIds, so this can safely start at the
   * blueprint cursor.
   */
  serve(count: number, avoidIds: string[] = []): Song[] {
    const avoid = new Set([...avoidIds, ...this.playedIds]);
    const out: Song[] = [];
    for (let i = this.playedCount; i < this.entries.length && out.length < count; i++) {
      const s = this.entries[i].song;
      if (avoid.has(s.id)) continue;
      out.push(s);
      avoid.add(s.id);
    }
    return out;
  }

  // ---- debug -------------------------------------------------------------

  /** Roles + chosen songs — printed by the verification script (deliverable). */
  describe(): string {
    return this.entries
      .map((e, i) => {
        const played = i < this.playedCount ? '✓' : ' ';
        return `  ${played} ${String(i + 1).padStart(2)}. [${e.role.padEnd(9)}] ` +
          `${(e.song.title ?? e.song.id).slice(0, 28).padEnd(28)} ` +
          `cl:${clusterKey(e.song)} e:${e.song.energy_score.toFixed(2)} — ${e.reason}`;
      })
      .join('\n');
  }

  debugSnapshot() {
    return {
      playedCount: this.playedCount,
      confidence: Number(this.confidence().toFixed(3)),
      confidenceBucket: this.confidenceBucket(),
      suppressedClusters: [...this.suppressedClusters],
      leanClusters: [...this.leanClusters],
      recoveryPending: this.recoveryPending,
      cohort: this.cohort?.debugSnapshot() ?? null,
      identity: this.identity?.debug() ?? null,
      slate: this.entries.map((e, i) => ({
        slot: i + 1,
        role: e.role,
        title: e.song.title,
        cluster: clusterKey(e.song),
        played: i < this.playedCount,
      })),
    };
  }
}

/** Factory — keeps construction call-sites readable. */
export function buildOnboardingSlate(catalog: Song[], opts: BuildOptions = {}): OnboardingSlate {
  return new OnboardingSlate(catalog, opts);
}

/**
 * Non-creepy, user-facing reason label for a slot's role (PART 3F lightweight
 * explanation chips). Deliberately speaks to the MUSIC, never to inferred
 * demographics — there is no "because you are 24" copy path here. The UI may
 * surface this as a subtle chip on first-session recommendations.
 */
export function friendlyReason(role: SlotRole, hasMoodContext: boolean): string {
  switch (role) {
    case 'trust':     return hasMoodContext ? 'Based on your mood' : 'Popular on Boulevard';
    case 'adjacent':  return 'More like your last song';
    case 'probe':     return 'A new sound to try';
    case 'recovery':  return 'Back to your vibe';
    case 'surprise':  return 'New sound, same vibe';
    case 'exploit':   return 'Made for your taste';
    case 'retention': return 'You might love this';
  }
}
