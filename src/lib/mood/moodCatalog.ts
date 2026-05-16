// Canonical mood catalog for Explore.
//
// These are the nine moods shown as chips on Explore (spec PART 2). Each mood
// carries the analyzer signals (listener contexts, microtags, mood words) used
// to match catalog songs to it. This module is the single source of truth for
// the chip set: MoodScoring orders the chips by behavior and ForYouEngine
// matches songs against these definitions.
//
// Phase B reconciles src/lib/mood/MoodPlaylist.ts MOODS with this list.

export type ChipMoodId =
  | 'hyped'
  | 'chill'
  | 'sad'
  | 'party'
  | 'heartbreak'
  | 'night_drive'
  | 'main_character'
  | 'focus'
  | 'confidence';

export interface ChipMood {
  id: ChipMoodId;
  label: string;
  emoji: string;
  /** Analyzer listener-contexts that signal this mood. */
  contexts: string[];
  /** Microtags that signal this mood. */
  microtags: string[];
  /** Song `mood` words (the existing single-value `mood` field) that align. */
  moodWords: string[];
  /** Optional soft energy band, 0..1. Songs far outside it match weakly. */
  energyRange?: [number, number];
}

// Default order shown to brand-new users with no behavior data (spec PART 2).
export const CHIP_MOODS: ChipMood[] = [
  {
    id: 'hyped', label: 'Hyped', emoji: '🔥',
    contexts: ['workout', 'peak_set', 'club_pregame', 'high_energy_listen'],
    microtags: ['peak_energy', 'high_energy', 'aggressive_lyrics', 'hard_808_kick', 'gang_vocal'],
    moodWords: ['confident', 'reckless', 'defiant', 'euphoric'],
    energyRange: [0.55, 1.0],
  },
  {
    id: 'chill', label: 'Chill', emoji: '😌',
    contexts: ['chill_focus', 'casual_listen', 'low_energy_listen'],
    microtags: ['low_energy', 'mid_energy', 'dreamy_lyrics', 'intimate_vocal', 'reverb_wash'],
    moodWords: ['tender', 'longing'],
    energyRange: [0.0, 0.55],
  },
  {
    id: 'sad', label: 'Sad', emoji: '🥲',
    contexts: ['reflective_alone'],
    microtags: ['melancholic_lyrics', 'low_energy', 'whispered_vocal', 'piano_loop'],
    moodWords: ['vulnerable', 'longing', 'haunted'],
    energyRange: [0.0, 0.55],
  },
  {
    id: 'party', label: 'Party', emoji: '🎉',
    contexts: ['club_pregame', 'peak_set'],
    microtags: ['dance_tempo', 'peak_tempo', 'peak_energy', 'club_lyrics', 'four_on_the_floor', 'dembow_pattern'],
    moodWords: ['euphoric', 'reckless'],
    energyRange: [0.5, 1.0],
  },
  {
    id: 'heartbreak', label: 'Heartbreak', emoji: '💔',
    contexts: ['reflective_alone'],
    microtags: ['melancholic_lyrics', 'whispered_vocal', 'piano_loop', 'intimate_vocal', 'reverb_wash'],
    moodWords: ['vulnerable', 'longing', 'haunted'],
    energyRange: [0.0, 0.6],
  },
  {
    id: 'night_drive', label: 'Night Drive', emoji: '🌙',
    contexts: ['casual_listen', 'reflective_alone', 'low_energy_listen'],
    microtags: ['reverb_wash', 'dreamy_lyrics', 'mid_energy', 'intimate_vocal', 'synth_lead'],
    moodWords: ['longing', 'confident', 'tender'],
    energyRange: [0.25, 0.7],
  },
  {
    id: 'main_character', label: 'Main Character', emoji: '😎',
    contexts: ['peak_set', 'studio_session'],
    microtags: ['flex_lyrics', 'high_energy', 'peak_energy', 'autotune_cry', 'gold_chain'],
    moodWords: ['confident', 'defiant'],
  },
  {
    id: 'focus', label: 'Focus', emoji: '🎯',
    contexts: ['chill_focus'],
    microtags: ['instrumental_track', 'low_energy', 'mid_energy', 'piano_loop', 'tape_warmth'],
    moodWords: [],
    energyRange: [0.0, 0.5],
  },
  {
    id: 'confidence', label: 'Confidence', emoji: '✨',
    contexts: ['peak_set', 'studio_session'],
    microtags: ['flex_lyrics', 'high_energy', 'peak_energy', 'gold_chain', 'aggressive_lyrics'],
    moodWords: ['confident', 'defiant', 'reckless'],
  },
];

// Default chip order for new users (spec PART 2).
export const DEFAULT_MOOD_ORDER: ChipMoodId[] = CHIP_MOODS.map((m) => m.id);

const BY_ID: Record<string, ChipMood> = {};
for (const m of CHIP_MOODS) BY_ID[m.id] = m;

export function moodById(id: string): ChipMood | undefined {
  return BY_ID[id];
}
