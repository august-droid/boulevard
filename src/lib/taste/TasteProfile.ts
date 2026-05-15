import { Song, TasteProfile, SessionProfile, VocalType } from '@/types';

// Online taste profile updates.
//
// We treat every interaction as a *signed weight* applied to the dimensions of
// the song that produced it. Weights are chosen so that strong positive signals
// (like, save, replay, completion) cleanly out-pace exploration noise within
// ~10-20 interactions, matching the product spec.

// Behavioral signals. Like is intentionally absent — the app surfaces Save
// + Share as positive intents. Share carries the strongest positive weight
// because it implies the user wants someone else to hear it (highest-cost
// social signal).
export type Signal =
  | { kind: 'skip_under_5' }
  | { kind: 'skip_under_15' }
  | { kind: 'listen_30s' }
  | { kind: 'listen_60s' }
  | { kind: 'completion_over_70' }
  | { kind: 'save' }
  | { kind: 'unsave' }
  | { kind: 'like' }
  | { kind: 'unlike' }
  | { kind: 'replay' }
  | { kind: 'share' };

const WEIGHTS: Record<Signal['kind'], number> = {
  // Hard negative — a sub-5s skip means the user reacted *before* the song
  // had a chance, which is the cleanest "no" we get.
  skip_under_5: -3.0,
  skip_under_15: -1.0,
  listen_30s: 0.6,
  listen_60s: 1.2,
  completion_over_70: 2.0,
  save: 3.0,
  unsave: -2.0,
  // Like is a fast-tap "I love this" — slightly weaker than save (which
  // implies long-term intent via playlist), stronger than completion.
  like: 2.5,
  unlike: -1.5,
  replay: 4.0,
  // Sharing has the highest positive weight — the user is putting their
  // own taste on the line.
  share: 5.0,
};

// Session-only weight overrides. These let a signal dominate the "right
// now" feel without permanently rewriting the user's long-term taste.
//
// Completion is amplified the most: when a user finishes a song they
// picked (from Explore, a mood, or anywhere else), that's a strong
// "this exact vibe is what I want right now" signal. We want the next
// 5–10 picks to lean hard into similar songs — the "stay in flow"
// behavior. With the lifetime weight of 2.0, the nudge was too gentle
// for users to perceive; bumping the session weight to 6.0 makes the
// queue tilt visibly within 1–2 picks.
//
// listen_60s gets a smaller bump for the same reason: a deep listen
// (not full completion yet) still signals "give me more like this."
const SESSION_WEIGHTS: Partial<Record<Signal['kind'], number>> = {
  completion_over_70: 6.0,
  listen_60s: 2.0,
};

function sessionWeight(kind: Signal['kind']): number {
  return SESSION_WEIGHTS[kind] ?? WEIGHTS[kind];
}

// EMA factor for continuous preferences (bpm, energy).
// Higher = profile reacts faster but is noisier.
const EMA_ALPHA = 0.15;

export function emptyProfile(userId: string): TasteProfile {
  return {
    user_id: userId,
    genre_scores: {},
    mood_scores: {},
    bpm_preference: null,
    energy_preference: null,
    vocal_preferences: { instrumental: 0, male: 0, female: 0, mixed: 0 } as Record<VocalType, number>,
    activity_scores: {},
    similarity_cluster_scores: {},
    microtag_scores: {},
    updated_at: new Date().toISOString(),
  };
}

// ===== Session profile =============================================
//
// Short-window "right now" preference. Lives in memory only, never persisted.
// Two behaviors set it apart from the lifetime profile:
//  • Decay: every new signal multiplies existing session scores by 0.92,
//    so the last ~10 plays dominate over older session noise.
//  • Reset: if more than SESSION_TIMEOUT_MS pass between interactions, the
//    session is wiped — coming back tomorrow doesn't carry yesterday's mood.

const SESSION_DECAY = 0.92;
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export function emptySession(): SessionProfile {
  return { microtag_scores: {}, last_interaction_at: Date.now() };
}

export function applySessionSignal(
  session: SessionProfile,
  song: Song,
  signal: Signal,
  now: number = Date.now(),
): SessionProfile {
  // Reset if the user has been away too long. Returning after a break
  // shouldn't keep penalizing genres they were skipping yesterday.
  const stale = now - session.last_interaction_at > SESSION_TIMEOUT_MS;
  const base = stale ? {} : decay(session.microtag_scores, SESSION_DECAY);

  // Use session-specific weights so a finished song produces a much
  // stronger short-window bias than its lifetime equivalent. Keeps the
  // user in flow without polluting their long-term taste.
  const w = sessionWeight(signal.kind);
  const tags = (song.microtags && song.microtags.length > 0) ? song.microtags : [];
  if (tags.length === 0 || w === 0) {
    return { microtag_scores: base, last_interaction_at: now };
  }
  const share = w / tags.length;
  for (const t of tags) base[t] = (base[t] ?? 0) + share;
  return { microtag_scores: base, last_interaction_at: now };
}

function decay(map: Record<string, number>, factor: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(map)) {
    const next = v * factor;
    // Drop near-zero entries so the map doesn't accumulate noise forever.
    if (Math.abs(next) > 0.01) out[k] = next;
  }
  return out;
}

function bumpMap(map: Record<string, number>, key: string, delta: number) {
  map[key] = (map[key] ?? 0) + delta;
}

export function applySignal(profile: TasteProfile, song: Song, signal: Signal): TasteProfile {
  const w = WEIGHTS[signal.kind];
  const next: TasteProfile = {
    ...profile,
    genre_scores: { ...profile.genre_scores },
    mood_scores: { ...profile.mood_scores },
    vocal_preferences: { ...profile.vocal_preferences },
    activity_scores: { ...profile.activity_scores },
    similarity_cluster_scores: { ...profile.similarity_cluster_scores },
    microtag_scores: { ...(profile.microtag_scores ?? {}) },
  };

  // When a song has multiple genre/mood tags, split the signal across them so
  // a multi-tagged song doesn't accumulate disproportionate weight on any one tag.
  const genres = (song.genres && song.genres.length > 0) ? song.genres : [song.genre];
  const moods = (song.moods && song.moods.length > 0) ? song.moods : [song.mood];
  const gShare = w / genres.length;
  const mShare = w / moods.length;
  for (const g of genres) bumpMap(next.genre_scores, g, gShare);
  for (const m of moods) bumpMap(next.mood_scores, m, mShare);

  // Microtags are the primary recommendation signal. They get the full signal
  // weight split across the song's tags — a positive replay on a song with 15
  // microtags spreads +4 across those 15 tags, so a tag that appears across
  // many of a user's positive interactions accumulates a strong score quickly.
  const microtags = song.microtags ?? [];
  if (microtags.length > 0) {
    const mtShare = w / microtags.length;
    for (const t of microtags) bumpMap(next.microtag_scores, t, mtShare);
  }
  bumpMap(next.similarity_cluster_scores, String(song.similarity_cluster), w);
  next.vocal_preferences[song.vocal_type] =
    (next.vocal_preferences[song.vocal_type] ?? 0) + w;

  for (const a of song.activity_fit) {
    bumpMap(next.activity_scores, a, w * 0.5);
  }

  // Pull continuous prefs toward this song's values when the signal is positive,
  // away when negative. We use a simple EMA scaled by |w| / 4 so strong signals
  // move the needle more than weak ones.
  const pull = Math.max(-1, Math.min(1, w / 4));
  const alpha = EMA_ALPHA * Math.abs(pull);
  if (pull >= 0) {
    if (song.bpm != null) {
      next.bpm_preference =
        next.bpm_preference == null ? song.bpm : next.bpm_preference + (song.bpm - next.bpm_preference) * alpha;
    }
    next.energy_preference =
      next.energy_preference == null
        ? song.energy_score
        : next.energy_preference + (song.energy_score - next.energy_preference) * alpha;
  }
  // For negative signals we intentionally don't move continuous prefs; the
  // categorical scores carry the dislike signal more cleanly.

  next.updated_at = new Date().toISOString();
  return next;
}

/** Map a played-duration sample into the discrete signals it implies. */
export function signalsFromPlayback(opts: {
  listenSeconds: number;
  durationSeconds: number;
  skipped: boolean;
}): Signal[] {
  const { listenSeconds, durationSeconds, skipped } = opts;
  const out: Signal[] = [];
  if (skipped) {
    if (listenSeconds < 5) out.push({ kind: 'skip_under_5' });
    else if (listenSeconds < 15) out.push({ kind: 'skip_under_15' });
    return out; // skips are dominated by the negative; positives don't compound
  }
  if (listenSeconds >= 30) out.push({ kind: 'listen_30s' });
  if (listenSeconds >= 60) out.push({ kind: 'listen_60s' });
  if (durationSeconds > 0 && listenSeconds / durationSeconds >= 0.7) {
    out.push({ kind: 'completion_over_70' });
  }
  return out;
}

// Summary helpers for the Profile screen.

export function topEntries(map: Record<string, number>, count = 3): { key: string; value: number }[] {
  return Object.entries(map)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([key, value]) => ({ key, value }));
}

export function energyLabel(score: number | null): string {
  if (score == null) return 'Learning';
  if (score < 0.33) return 'Mellow';
  if (score < 0.66) return 'Balanced';
  return 'High energy';
}
