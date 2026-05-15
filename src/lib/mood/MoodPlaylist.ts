import { Song, TasteProfile } from '@/types';

// Mood-driven personalized playlists.
//
// User picks a mood → we filter the catalog by mood-aligned microtags +
// listener_contexts + mood words, then rank the survivors by their
// lifetime microtag_scores so the result is *both* mood-matched AND
// personalized. Quality priors (hook_strength, mainstream_fit) tie-break.
//
// When the filter is too narrow to produce a usable playlist (small
// catalog, weird mood + weird taste), we fall back to ranking the whole
// catalog by quality so the user never hits an empty playlist.

export type MoodId = 'hyped' | 'chill' | 'sad' | 'party' | 'focus' | 'main_character' | 'gym' | 'running';

export interface Mood {
  id: MoodId;
  emoji: string;
  label: string;
  description: string;
  /** Listener contexts (from the analyzer) that signal this mood. */
  contexts: string[];
  /** Microtags that signal this mood. */
  microtags: string[];
  /** Song mood words (existing `mood` field) that align. */
  moodWords: string[];
  /** Optional hard BPM gate. Songs outside the range are filtered out entirely.
   *  Used for cadence-locked moods like Running (typical step cadence 160–180 SPM). */
  bpmRange?: [number, number];
}

export const MOODS: Mood[] = [
  {
    id: 'hyped', emoji: '🔥', label: 'Hyped', description: 'Bring the energy',
    contexts: ['workout', 'peak_set', 'club_pregame', 'high_energy_listen'],
    microtags: ['peak_energy', 'high_energy', 'aggressive_lyrics', 'hard_808_kick', 'gang_vocal'],
    moodWords: ['confident', 'reckless', 'defiant', 'euphoric'],
  },
  {
    id: 'chill', emoji: '😌', label: 'Chill', description: 'Easy listening',
    contexts: ['chill_focus', 'casual_listen', 'low_energy_listen'],
    microtags: ['low_energy', 'mid_energy', 'dreamy_lyrics', 'intimate_vocal', 'reverb_wash'],
    moodWords: ['tender', 'longing'],
  },
  {
    id: 'sad', emoji: '🥲', label: 'Sad', description: 'Feelings only',
    contexts: ['reflective_alone'],
    microtags: ['melancholic_lyrics', 'low_energy', 'whispered_vocal', 'piano_loop'],
    moodWords: ['vulnerable', 'longing', 'haunted'],
  },
  {
    id: 'party', emoji: '🎉', label: 'Party', description: 'Get the room going',
    contexts: ['club_pregame', 'peak_set'],
    microtags: ['dance_tempo', 'peak_tempo', 'peak_energy', 'club_lyrics', 'four_on_the_floor', 'dembow_pattern'],
    moodWords: ['euphoric', 'reckless'],
  },
  {
    id: 'focus', emoji: '🎯', label: 'Focus', description: 'Lock in',
    contexts: ['chill_focus'],
    microtags: ['instrumental_track', 'low_energy', 'mid_energy', 'piano_loop', 'tape_warmth'],
    moodWords: [],
  },
  {
    id: 'main_character', emoji: '😎', label: 'Main Character', description: 'Walk in like that',
    contexts: ['peak_set', 'studio_session'],
    microtags: ['flex_lyrics', 'high_energy', 'peak_energy', 'autotune_cry', 'gold_chain'],
    moodWords: ['confident', 'defiant'],
  },
  {
    // Personalized by design — Gym is whatever YOU work out to. We bias toward
    // high-energy/aggressive signals but let microtag_scores do the heavy
    // lifting so two users see very different gym playlists.
    id: 'gym', emoji: '💪', label: 'Gym', description: 'Lift to your sound',
    contexts: ['workout', 'peak_set'],
    microtags: ['peak_energy', 'high_energy', 'aggressive_lyrics', 'hard_808_kick', 'gang_vocal', 'four_on_the_floor'],
    moodWords: ['confident', 'reckless', 'defiant', 'euphoric'],
  },
  {
    // Cadence-locked. 9 km/h ≈ 160 SPM, 13 km/h ≈ 180 SPM — songs in the
    // 150–180 BPM band sync naturally with running stride.
    id: 'running', emoji: '🏃', label: 'Running', description: 'Match your stride',
    contexts: ['workout', 'peak_set'],
    microtags: ['peak_energy', 'high_energy', 'dance_tempo', 'up_tempo', 'peak_tempo', 'four_on_the_floor'],
    moodWords: ['confident', 'euphoric', 'defiant'],
    bpmRange: [150, 180],
  },
];

export function moodById(id: MoodId): Mood | undefined {
  return MOODS.find((m) => m.id === id);
}

/**
 * Score a song against a mood + the user's lifetime taste.
 * Returns -Infinity for songs that don't match the mood at all so they're
 * filtered out of the playlist entirely.
 */
function scoreSongForMood(song: Song, mood: Mood, userScores: Record<string, number> | undefined): number {
  const tags = song.microtags ?? [];
  const contexts = song.primary_listener_contexts ?? [];

  // Hard BPM gate (Running). If a mood declares a range, songs outside it
  // are filtered out entirely — no amount of tag overlap salvages a 90 BPM
  // ballad for a Running playlist.
  if (mood.bpmRange && song.bpm != null) {
    const [lo, hi] = mood.bpmRange;
    if (song.bpm < lo || song.bpm > hi) return -Infinity;
  }

  // Mood-fit signal count. We require at least one match across the three
  // axes — otherwise the song is simply wrong for this mood and we hide it.
  let matches = 0;
  for (const c of mood.contexts) if (contexts.includes(c)) matches++;
  for (const t of mood.microtags) if (tags.includes(t)) matches++;
  if (song.mood && mood.moodWords.includes(song.mood)) matches++;
  if (matches === 0) return -Infinity;

  let score = matches * 2;

  // Personalization on top of mood fit — same microtag-overlap formula
  // the main ranker uses, capped so a strong-fit song doesn't dominate.
  if (userScores && tags.length > 0) {
    let sum = 0;
    for (const t of tags) sum += userScores[t] ?? 0;
    score += Math.max(-8, Math.min(8, sum));
  }

  // Quality tiebreakers.
  score += (song.hook_strength ?? 0) * 1.5;
  score += (song.mainstream_fit ?? 0) * 0.5;
  return score;
}

/** Top N songs that match the mood, personalized by the user's taste. */
export function buildMoodPlaylist(
  mood: Mood,
  catalog: Song[],
  taste: TasteProfile | null,
  limit = 20,
): Song[] {
  const userScores = taste?.microtag_scores;
  // Filter suppressed songs outright — same posture as the main ranker.
  const eligible = catalog.filter((s) => (s.distribution_stage ?? 'new_test') !== 'suppressed');

  const scored = eligible
    .map((s) => ({ s, score: scoreSongForMood(s, mood, userScores) }))
    .filter((x) => Number.isFinite(x.score))
    .sort((a, b) => b.score - a.score);

  if (scored.length >= 3) {
    return scored.slice(0, limit).map((x) => x.s);
  }

  // Fallback: mood-filter produced too few. Rank the whole catalog by
  // quality so the user never sees an empty playlist.
  return eligible
    .map((s) => ({
      s,
      score: (s.hook_strength ?? 0) * 1.5 + (s.mainstream_fit ?? 0) * 0.8,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}
