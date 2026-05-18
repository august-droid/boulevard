import { Song, TasteProfile, SessionProfile, SongStats } from '@/types';
import { ChipMoodId, moodById } from '@/lib/mood/moodCatalog';
import { adjacentMoods, genresRelated } from '@/lib/recommendation/Adjacency';
import type { TasteIdentityProfile, IdentityZone } from '@/lib/recommendation/TasteIdentityProfile';

// ============================================================
// Surprise Me — High-Upside Discovery Mode.
//
// "Surprise Me" is NOT shuffle. Random shuffle produces "why am I hearing
// this?". This engine produces "I normally wouldn't search for this, but
// this is good." — controlled discovery: songs the user did NOT expect that
// still have a high probability of landing.
//
// HOW IT STAYS CONTROLLED
// -----------------------
//  1. Identity compatibility — every candidate is run through the behavioural
//     TasteIdentityProfile. Songs in the `blocked` zone (identity-breaking —
//     e.g. bubblegum teen-pop for a mature cinematic listener, childish party
//     pop for a dark-rap listener) are dropped outright.
//  2. Adjacent discovery — candidates are rewarded for sitting ONE STEP away
//     from the user's lane: adjacent genres, adjacent moods, partial microtag
//     (cluster) overlap. Exact-lane songs are demoted — they are not a
//     surprise. Totally-foreign songs are demoted — they are random.
//  3. Collaborative upside — songs with high replay / save / completion rates
//     (people genuinely keep them) intersected with the user's taste overlap:
//     a client-side proxy for "users with similar behaviour also replayed /
//     saved this". (True user-cohort CF lives server-side; this is the
//     content+engagement stand-in available on-device.)
//  4. Controlled risk — every song gets a `surpriseRiskScore` (0..1).
//     Extreme-mismatch songs are blocked; too-safe songs are demoted; the
//     queue is built from the medium-risk, high-upside band.
//  5. Emotional coherence — assembly avoids jarring energy jumps and keeps
//     artist diversity, so the surprise still "feels like them".
//
// Pure module — only domain *types* and pure recommendation helpers are
// imported. No React, no network, no storage — trivially unit-testable
// (see SurpriseEngine.usersim.ts).
// ============================================================

export interface SurpriseInput {
  catalog: Song[];
  /** Lifetime taste — defines the user's comfort zone. */
  taste: TasteProfile | null;
  /** Behavioural identity — the controlled-risk gate. */
  identity: TasteIdentityProfile | null;
  /** Short-window "right now" taste — keeps the surprise session-coherent. */
  session: SessionProfile | null;
  /** Moods ordered by behaviour score (ExploreContext.moodOrder). */
  topMoodIds: ChipMoodId[];
  /** Per-song aggregate stats — drives the collaborative upside signal. */
  stats?: Map<string, SongStats>;
  /** Song ids inside the 24h anti-repeat window — already-heard songs are not
   *  a discovery, so they are excluded. */
  suppressedIds?: Set<string>;
  /** Target queue length. Clamped 12..40, default 26. */
  limit?: number;
  now?: number;
}

export interface SurprisePick {
  song: Song;
  /** Final ranking score. */
  score: number;
  /** 0..1 — distance from the user's comfort zone. The queue is built from
   *  the medium band; extreme values are blocked or demoted. */
  surpriseRiskScore: number;
  /** Identity zone the song landed in. */
  zone: IdentityZone;
  /** Short human-readable reason — debug / QA only. */
  reason: string;
}

export interface SurpriseResult {
  /** The controlled-discovery queue, in play order. */
  songs: Song[];
  /** Ranked picks with their risk / zone / reason — debug + QA. */
  picks: SurprisePick[];
  debug: {
    eligible: number;
    blockedIdentity: number;
    blockedRisk: number;
    blockedForeign: number;
    tooSafe: number;
    /** Mean surpriseRiskScore of the final queue. */
    meanRisk: number;
    /** Mean collaborative upside of the final queue. */
    meanUpside: number;
  };
}

// ---- tuning -------------------------------------------------------------

/** Risk above this is an extreme mismatch — never surfaced. */
const RISK_BLOCK = 0.82;
/** Risk below this is too safe — it is not a surprise, so it is demoted to
 *  last-resort filler. */
const RISK_TOO_SAFE = 0.28;
/** Mid-band the engine actively targets — controlled discovery. */
const RISK_BAND_LO = 0.32;
const RISK_BAND_HI = 0.72;
/** Identity confidence below this = treat the user as cold-start: identity
 *  cannot judge yet, so fall back to high-quality varied discovery. */
const COLD_IDENTITY_CONF = 0.15;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface ComfortZone {
  topGenres: string[];           // lowercased, behaviour-ranked
  coreMoodWords: Set<string>;    // mood words of the user's top mood chips
  adjMoodWords: Set<string>;     // mood words one step away
  tasteTags: Record<string, number>;
}

function deriveComfortZone(taste: TasteProfile | null, topMoodIds: ChipMoodId[]): ComfortZone {
  const topGenres = taste
    ? Object.entries(taste.genre_scores)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([g]) => g.trim().toLowerCase())
    : [];
  const coreMoodWords = new Set<string>();
  const adjMoodWords = new Set<string>();
  for (const id of topMoodIds.slice(0, 2)) {
    const m = moodById(id);
    if (m) for (const w of m.moodWords) coreMoodWords.add(w);
    for (const a of adjacentMoods(id)) {
      const am = moodById(a);
      if (am) for (const w of am.moodWords) adjMoodWords.add(w);
    }
  }
  return { topGenres, coreMoodWords, adjMoodWords, tasteTags: taste?.microtag_scores ?? {} };
}

/** Fraction of a song's microtags the user has a positive lifetime score for
 *  (0..1). The client-side stand-in for "this clusters with songs you like". */
function tasteTagFraction(song: Song, tasteTags: Record<string, number>): number {
  const tags = song.microtags ?? [];
  if (tags.length === 0) return 0;
  let liked = 0;
  for (const t of tags) if ((tasteTags[t] ?? 0) > 0) liked++;
  return liked / tags.length;
}

/** Overlap of a song's microtags with the short-window session profile. */
function sessionFraction(song: Song, session: SessionProfile | null): number {
  if (!session) return 0;
  const tags = song.microtags ?? [];
  if (tags.length === 0) return 0;
  let hit = 0;
  for (const t of tags) if ((session.microtag_scores[t] ?? 0) > 0) hit++;
  return hit / tags.length;
}

/** Collaborative upside — replay / save / completion potential. Real
 *  analytics first; analyzer priors as a graceful offline fallback. */
function collaborativeUpside(song: Song, stat: SongStats | undefined): number {
  if (stat) {
    let u = stat.replay_rate * 0.42 + stat.save_rate * 0.4 + stat.avg_completion * 0.18;
    u *= 1 - clamp(stat.skip_rate, 0, 0.85) * 0.5; // heavy skips drag the upside down
    return clamp(u, 0, 1);
  }
  return clamp(
    (song.hook_strength ?? 0) * 0.5 + (song.launch_score ?? 0) * 0.3 + (song.mainstream_fit ?? 0) * 0.2,
    0,
    1,
  );
}

interface Scored {
  song: Song;
  score: number;
  risk: number;
  zone: IdentityZone;
  upside: number;
  energy: number;
  tooSafe: boolean;
  reason: string;
}

/**
 * Build the Surprise Me controlled-discovery queue.
 *
 * Ranking priority (brief rule 5, high → low):
 *   identity compatibility · collaborative upside · adjacent overlap ·
 *   controlled novelty · freshness — with strict genre matching DELIBERATELY
 *   low-weighted (exact-lane songs are demoted, not rewarded).
 */
export function buildSurpriseQueue(input: SurpriseInput): SurpriseResult {
  const now = input.now ?? Date.now();
  const limit = clamp(input.limit ?? 26, 12, 40);
  const suppressed = input.suppressedIds ?? new Set<string>();
  const identity = input.identity;
  const coldStart = !identity || identity.overallConfidence() < COLD_IDENTITY_CONF;
  const zone = deriveComfortZone(input.taste, input.topMoodIds);
  const hasGenrePrefs = zone.topGenres.length > 0;

  let blockedIdentity = 0;
  let blockedRisk = 0;
  let blockedForeign = 0;

  const scoreOne = (song: Song): Scored | null => {
    if (!song.audio_url) return null;
    if ((song.distribution_stage ?? 'new_test') === 'suppressed') return null;
    // Already heard recently — that is not a discovery.
    if (suppressed.has(song.id)) return null;

    // ---- 1. identity compatibility (the controlled-risk gate) ----
    // discoveryMode lets anchored novelty ("surprise" zone) through instead of
    // being damped — this surface is exactly where it belongs.
    const ev = identity ? identity.evaluate(song, { discoveryMode: true }) : null;
    const songZone: IdentityZone = ev ? ev.zone : 'neutral';
    if (ev && ev.zone === 'blocked') {
      blockedIdentity++;
      return null; // identity-breaking — never surfaced
    }
    const idFit = ev ? ev.fit : 0;
    const conflicts = ev ? ev.conflicts : 0;
    const anchors = ev ? ev.anchors : 0;

    // ---- comfort-zone position ----
    const songGenre = (song.genre || '').trim().toLowerCase();
    const genreCore = hasGenrePrefs && zone.topGenres.includes(songGenre);
    const genreAdj =
      !genreCore && hasGenrePrefs && zone.topGenres.some((g) => genresRelated(g, songGenre));
    const genreForeign = hasGenrePrefs && !genreCore && !genreAdj;
    const moodCore = !!song.mood && zone.coreMoodWords.has(song.mood);
    const moodAdj = !moodCore && !!song.mood && zone.adjMoodWords.has(song.mood);
    const tagFrac = tasteTagFraction(song, zone.tasteTags);

    // Core-taste violation (brief rule 1). A song foreign on genre AND mood
    // AND microtags AND identity is not discovery — it is random (the brief's
    // "random K-pop to a dark-rap listener"). Dropped even before the identity
    // profile has explicitly learned to dislike it.
    if (genreForeign && !moodCore && !moodAdj && tagFrac < 0.08 && idFit <= 0.05) {
      blockedForeign++;
      return null;
    }

    // familiarity 0..1 — how squarely the song sits in the user's known lane.
    // High familiarity = expected = NOT a surprise.
    const familiarity = clamp(
      (genreCore ? 0.45 : 0) + (moodCore ? 0.25 : 0) + tagFrac * 0.5,
      0,
      1,
    );

    // ---- 4. surpriseRiskScore — how far the song sits from the user's
    //         KNOWN lane (genre / mood / microtags), nudged by identity
    //         friction. This is NOT the identity zone: a song can feel deeply
    //         "like them" (identity-core) yet still be a genre they have never
    //         opened — that is exactly the ideal surprise. Risk therefore
    //         measures unexpectedness, while the identity zone gates safety.
    let risk = 0.5;
    if (genreCore) risk -= 0.3;
    else if (genreAdj) risk -= 0.05;
    else if (genreForeign) risk += 0.22;
    if (moodCore) risk -= 0.14;
    else if (moodAdj) risk -= 0.02;
    else risk += 0.06;
    risk -= tagFrac * 0.22;
    risk += conflicts * 0.1;
    if (idFit < 0) risk += Math.min(0.25, -idFit * 0.3);  // fighting identity = risk
    else risk -= Math.min(0.1, idFit * 0.06);              // identity comfort, lightly
    risk = clamp(risk, 0, 1);

    // Extreme mismatch — blocked even if the identity zone alone did not.
    if (risk >= RISK_BLOCK) {
      blockedRisk++;
      return null;
    }
    const tooSafe = risk < RISK_TOO_SAFE;
    const inBand = risk >= RISK_BAND_LO && risk <= RISK_BAND_HI;

    // ---- collaborative upside (for THIS user) ----
    const rawUpside = collaborativeUpside(song, input.stats?.get(song.id));
    // Weight global replay/save evidence by how much the song overlaps the
    // user's taste — the cohort intersection: "people who behave like you".
    const userUpside = rawUpside * (0.45 + 0.55 * tagFrac);

    // ---- 2. adjacent discovery ----
    let adjacency = 0;
    if (genreAdj) adjacency += 0.7;
    if (moodAdj) adjacency += 0.5;
    adjacency += tagFrac * 0.3;            // partial cluster overlap
    if (genreForeign) adjacency -= 0.3;    // too random
    adjacency = clamp(adjacency, -0.3, 1.5);

    // ---- 5. controlled novelty ----
    let novelty = 0;
    const stage = song.distribution_stage ?? 'new_test';
    if (stage === 'new_test' || stage === 'rising') novelty += 0.5;
    const weird = song.weirdness_score ?? 0;
    if (weird >= 0.3 && weird <= 0.62) novelty += 0.4; // "weird that works" sweet spot

    // The engine actively targets the medium-risk band — that is what makes
    // "Surprise Me" a discovery surface, not a safe "For You" rerun. Songs a
    // little past the band are still allowed, just not preferred.
    const bandBonus = inBand ? 2.6 : risk > RISK_BAND_HI ? 0.6 : 0;

    // ---- 6. freshness ----
    let freshness = 0;
    if (song.created_at) {
      const age = now - Date.parse(song.created_at);
      const FRESH = 28 * 24 * 60 * 60 * 1000;
      if (Number.isFinite(age) && age >= 0 && age < FRESH) freshness = 1 - age / FRESH;
    }
    const velocity = input.stats?.get(song.id)?.velocity_score ?? 0;
    if (velocity > 0.6) freshness = Math.max(freshness, 0.6);

    const sessionFit = sessionFraction(song, input.session);
    const globalQuality =
      (song.launch_score ?? 0) * 0.5 + (song.quality_score ?? 0) * 0.3;

    // ---- final score (brief rule 5 priority order) ----
    let score =
      Math.max(0, idFit) * 3.0 +        // identity compatibility — #1
      anchors * 0.5 +                   // shares a strong identity anchor
      userUpside * 2.6 +                // high replay/save (collaborative upside)
      adjacency * 2.0 +                 // adjacent cluster overlap
      bandBonus +                       // sits in the controlled-discovery band
      novelty * 1.3 +                   // controlled novelty
      sessionFit * 1.0 +                // still fits the current session
      freshness * 0.7 +
      globalQuality * (coldStart ? 1.6 : 0.8) - // lean on quality before identity exists
      familiarity * 2.2 -               // too expected — not a surprise
      conflicts * 1.5;                  // soft identity friction

    let reason: string;
    if (tooSafe) {
      score -= 6; // keep only as last-resort filler so the queue is never empty
      reason = 'too safe — expected';
    } else if (genreAdj && anchors >= 1) {
      reason = 'adjacent genre, shares an identity anchor';
    } else if (genreAdj) {
      reason = 'adjacent genre discovery';
    } else if (moodAdj) {
      reason = 'adjacent mood discovery';
    } else if (songZone === 'surprise') {
      reason = 'anchored novelty';
    } else {
      reason = 'high-upside discovery';
    }

    // Small rotation term so reopening Surprise Me is not identical.
    score += Math.random() * 1.1;

    return {
      song, score, risk, zone: songZone, upside: userUpside,
      energy: song.energy_score, tooSafe, reason,
    };
  };

  const scored: Scored[] = [];
  for (const s of input.catalog) {
    const r = scoreOne(s);
    if (r) scored.push(r);
  }
  scored.sort((a, b) => b.score - a.score);

  const tooSafeCount = scored.filter((s) => s.tooSafe).length;

  // ---- assembly: artist diversity + emotional coherence ----
  const out: Scored[] = [];
  const picked = new Set<string>();
  const artistCount = new Map<string, number>();

  const passes = (
    cand: Scored,
    enforceArtist: boolean,
    enforceEnergy: boolean,
  ): boolean => {
    const aid = cand.song.artist_id ?? '__none__';
    if (enforceArtist) {
      if ((artistCount.get(aid) ?? 0) >= 2) return false; // max 2 per artist
      if (aid !== '__none__' && out.length > 0 &&
          (out[out.length - 1].song.artist_id ?? '__none__') === aid) {
        return false; // never the same artist back-to-back
      }
    }
    // Emotional coherence — avoid a jarring energy jump between songs.
    if (enforceEnergy && out.length > 0) {
      if (Math.abs(cand.energy - out[out.length - 1].energy) > 0.45) return false;
    }
    return true;
  };

  const fill = (
    allowTooSafe: boolean,
    enforceArtist: boolean,
    enforceEnergy: boolean,
  ): void => {
    let progress = true;
    while (out.length < limit && progress) {
      progress = false;
      for (const cand of scored) {
        if (out.length >= limit) break;
        if (picked.has(cand.song.id)) continue;
        if (!allowTooSafe && cand.tooSafe) continue;
        if (!passes(cand, enforceArtist, enforceEnergy)) continue;
        out.push(cand);
        picked.add(cand.song.id);
        const aid = cand.song.artist_id ?? '__none__';
        artistCount.set(aid, (artistCount.get(aid) ?? 0) + 1);
        progress = true;
      }
    }
  };

  // Relaxation order: medium-risk discovery first, then allow safe filler,
  // then drop energy-coherence, then drop artist diversity — a sparse catalog
  // must still yield a non-empty queue.
  fill(false, true, true);
  if (out.length < limit) fill(false, true, false);
  if (out.length < limit) fill(true, true, false);
  if (out.length < limit) fill(true, false, false);

  const meanRisk = out.length ? out.reduce((a, s) => a + s.risk, 0) / out.length : 0;
  const meanUpside = out.length ? out.reduce((a, s) => a + s.upside, 0) / out.length : 0;

  return {
    songs: out.map((s) => s.song),
    picks: out.map((s) => ({
      song: s.song,
      score: s.score,
      surpriseRiskScore: s.risk,
      zone: s.zone,
      reason: s.reason,
    })),
    debug: {
      eligible: scored.length,
      blockedIdentity,
      blockedRisk,
      blockedForeign,
      tooSafe: tooSafeCount,
      meanRisk,
      meanUpside,
    },
  };
}
