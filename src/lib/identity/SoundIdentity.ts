import type { TasteProfile } from '@/types';

// Sound identity layer.
//
// Translates raw microtag_scores into a human-meaningful "who you are right
// now" string. The profile screen renders these as identity badges instead
// of showing the user a vector of weights.
//
// Each identity has:
//   • a name (the headline, e.g. "Late-Night Emotional Chaos")
//   • descriptors (3 short phrases evoking the sound)
//   • palette (gradient stops for the aura behind the hero card)
//   • required microtags (used to score this identity against the user's
//     taste — the closest match wins)
//
// When no match is strong enough yet (cold-start, fresh account), we
// return a "Forming…" identity so the screen still reads as an identity
// page, not a settings page.

export interface SoundIdentity {
  id: string;
  name: string;
  descriptors: string[];
  palette: [string, string, string];   // 3-stop gradient for the hero aura
  /** Microtags this identity is built on. Used both for scoring + chip render. */
  tags: string[];
}

const IDENTITIES: SoundIdentity[] = [
  {
    id: 'late_night_emotional',
    name: 'Late-Night Emotional Chaos',
    descriptors: ['Dark synths', 'Obsessive lyrics', 'Cinematic drops'],
    palette: ['#1a1450', '#3d1f6b', '#0a0a0c'],
    tags: ['late_night_imagery', 'melancholic_lyrics', 'intimate_vocal', 'whispered_vocal', 'reverb_wash', 'mood_vulnerable', 'mood_longing'],
  },
  {
    id: 'main_character_era',
    name: 'Main Character Era',
    descriptors: ['Confident flex', 'Cinematic mood', 'Stadium-sized hooks'],
    palette: ['#6b4a1a', '#3d2a14', '#0a0a0c'],
    tags: ['flex_lyrics', 'autotune_cry', 'gold_chain', 'high_energy', 'peak_energy', 'mood_confident', 'mood_defiant'],
  },
  {
    id: 'crashout_chaos',
    name: 'Crashout Chaos',
    descriptors: ['Distorted bass', 'Manic energy', 'Sweet-and-broken vocals'],
    palette: ['#5a1545', '#7e2858', '#0a0a0c'],
    tags: ['peak_energy', 'aggressive_lyrics', 'hard_808_kick', 'gang_vocal', 'mood_reckless', 'club_lyrics'],
  },
  {
    id: 'floor_commander',
    name: 'Floor Commander',
    descriptors: ['Four-on-the-floor', 'Vocal chops', 'Sunrise euphoria'],
    palette: ['#1a3a5a', '#1e6b7e', '#0a0a0c'],
    tags: ['dance_tempo', 'peak_tempo', 'four_on_the_floor', 'club_lyrics', 'peak_energy', 'mood_euphoric'],
  },
  {
    id: 'whiskey_poet',
    name: 'Whiskey Poet',
    descriptors: ['Acoustic intimacy', 'Lived-in vocal grit', 'Hometown ghosts'],
    palette: ['#3d2a14', '#5a3a1f', '#0a0a0c'],
    tags: ['acoustic_guitar', 'pedal_steel_guitar', 'fiddle', 'tape_warmth', 'intimate_vocal', 'mood_tender', 'mood_longing'],
  },
  {
    id: 'bedroom_diarist',
    name: 'Bedroom Diarist',
    descriptors: ['Soft fingerpicked guitar', 'Confessional lyrics', 'Cassette-warm production'],
    palette: ['#2a2a3a', '#4a3a55', '#0a0a0c'],
    tags: ['intimate_vocal', 'whispered_vocal', 'dreamy_lyrics', 'tape_warmth', 'low_energy', 'mood_tender'],
  },
  {
    id: 'detached_indie',
    name: 'Detached Indie Cool',
    descriptors: ['Interlocking clean guitars', 'Dry conversational vocal', 'City-at-2am energy'],
    palette: ['#1a2a3a', '#2e455a', '#0a0a0c'],
    tags: ['detached_vocal', 'interlocking_clean_guitars', 'bass_led_groove', 'dry_live_drums', 'conversational_vocal'],
  },
  {
    id: 'studio_session_rap',
    name: 'Studio-at-Sunrise',
    descriptors: ['Piano-loop confessional', 'Behind-the-beat phrasing', 'Late-night vulnerability'],
    palette: ['#1f2a2a', '#3d4a4a', '#0a0a0c'],
    tags: ['piano_loop', 'autotune_cry', 'behind_the_beat_phrasing', 'vinyl_crackle', 'melancholic_lyrics', 'late_night_imagery'],
  },
];

const FORMING: SoundIdentity = {
  id: 'forming',
  name: 'Your sound is forming',
  descriptors: ['Listen', 'Skip what you hate', 'Replay what you love'],
  palette: ['#1a1a20', '#26262e', '#0a0a0c'],
  tags: [],
};

export interface IdentityResult {
  identity: SoundIdentity;
  /** 0..1 — how strongly this identity matches the user's taste. */
  strength: number;
}

/**
 * Pick the SoundIdentity that best matches the user's taste profile.
 * Returns FORMING when the user has no microtag history yet, or when the
 * top match is too weak to claim.
 */
export function pickSoundIdentity(taste: TasteProfile | null): IdentityResult {
  const scores = taste?.microtag_scores;
  if (!scores || Object.keys(scores).length === 0) {
    return { identity: FORMING, strength: 0 };
  }

  let best: SoundIdentity | null = null;
  let bestScore = 0;
  for (const id of IDENTITIES) {
    let sum = 0;
    let matches = 0;
    for (const t of id.tags) {
      const v = scores[t] ?? 0;
      if (v > 0) { sum += v; matches++; }
    }
    // Weight by both raw score sum AND how many of the identity's signature
    // tags the user actually has — keeps a single dominant tag from picking
    // a wrong identity.
    const composite = sum * (1 + matches / id.tags.length);
    if (composite > bestScore) { bestScore = composite; best = id; }
  }
  if (!best || bestScore < 1.5) return { identity: FORMING, strength: 0 };

  // Normalize strength to 0..1 by capping at a "fully formed" threshold.
  const FORMED_THRESHOLD = 25;
  const strength = Math.min(1, bestScore / FORMED_THRESHOLD);
  return { identity: best, strength };
}

/**
 * Compute the "current phase" — same data shape, but trained on the
 * SESSION profile so it reflects today's mood rather than lifetime taste.
 * Returns null if the session is too quiet to read.
 */
export function pickCurrentPhase(sessionScores: Record<string, number> | undefined): IdentityResult | null {
  if (!sessionScores || Object.keys(sessionScores).length === 0) return null;
  // Reuse the identity catalog. Session weights are different in scale,
  // so we normalize by max score, then run the same matcher.
  const maxVal = Math.max(...Object.values(sessionScores));
  if (maxVal <= 0) return null;
  const normalized: Record<string, number> = {};
  for (const [k, v] of Object.entries(sessionScores)) normalized[k] = v / maxVal;

  let best: SoundIdentity | null = null;
  let bestScore = 0;
  for (const id of IDENTITIES) {
    let sum = 0;
    let matches = 0;
    for (const t of id.tags) {
      const v = normalized[t] ?? 0;
      if (v > 0) { sum += v; matches++; }
    }
    const composite = sum * (1 + matches / id.tags.length);
    if (composite > bestScore) { bestScore = composite; best = id; }
  }
  if (!best || bestScore < 0.4) return null;
  return { identity: best, strength: Math.min(1, bestScore / 2) };
}

/**
 * Top 3 microtags from a score map (positive only). Used to show
 * personalized signal chips on the profile.
 */
export function topMicrotags(scores: Record<string, number> | undefined, count = 3): string[] {
  if (!scores) return [];
  return Object.entries(scores)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([k]) => k);
}

/** Make a microtag pretty for display: `dry_live_drums` → "Dry live drums" */
export function prettyMicrotag(tag: string): string {
  return tag.replace(/^(genre_|mood_)/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
