import { Song, TasteProfile, VocalType } from '@/types';

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
  replay: 4.0,
  // Sharing has the highest positive weight — the user is putting their
  // own taste on the line.
  share: 5.0,
};

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
    updated_at: new Date().toISOString(),
  };
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
  };

  // When a song has multiple genre/mood tags, split the signal across them so
  // a multi-tagged song doesn't accumulate disproportionate weight on any one tag.
  const genres = (song.genres && song.genres.length > 0) ? song.genres : [song.genre];
  const moods = (song.moods && song.moods.length > 0) ? song.moods : [song.mood];
  const gShare = w / genres.length;
  const mShare = w / moods.length;
  for (const g of genres) bumpMap(next.genre_scores, g, gShare);
  for (const m of moods) bumpMap(next.mood_scores, m, mShare);
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
