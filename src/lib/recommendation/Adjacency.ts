import { ChipMoodId } from '@/lib/mood/moodCatalog';

// Adjacency maps for "adjacent discovery" (spec PART 3, the 25% bucket).
//
// Adjacent songs are NOT random — they sit one step away from the user's
// current lane: a related mood, or a related genre family. This keeps the user
// discovering music they are likely to enjoy without trapping them in one
// narrow cluster.

export const MOOD_ADJACENCY: Record<ChipMoodId, ChipMoodId[]> = {
  hyped: ['party', 'confidence', 'main_character'],
  chill: ['night_drive', 'focus', 'sad'],
  sad: ['heartbreak', 'chill', 'night_drive'],
  party: ['hyped', 'confidence', 'main_character'],
  heartbreak: ['sad', 'night_drive', 'chill'],
  night_drive: ['chill', 'sad', 'confidence'],
  main_character: ['confidence', 'hyped', 'party'],
  focus: ['chill', 'night_drive'],
  confidence: ['main_character', 'hyped', 'party'],
};

export function adjacentMoods(id: ChipMoodId): ChipMoodId[] {
  return MOOD_ADJACENCY[id] ?? [];
}

// Genre families — songs inside a family are considered adjacent. The lookup
// is best-effort: an unrecognized genre returns no neighbors, so the caller
// gracefully falls back to mood / microtag adjacency. All keys are lowercased.
const GENRE_FAMILIES: string[][] = [
  ['pop', 'dance pop', 'female pop', 'dark alt-pop', 'alt pop', 'art pop', 'electropop', 'dream pop'],
  ['indie', 'indie pop', 'indiepop', 'bedroom pop', 'indie folk', 'indie rock'],
  ['rnb', 'r&b', 'alt-r&b', 'alt r&b', 'late-night r&b', 'trap-soul', 'trap soul', 'neo-soul', 'soul'],
  ['rap', 'hiphop', 'hip-hop', 'melodic rap', 'southern rap', 'trap', 'drill'],
  ['edm', 'electronic', 'house', 'techno', 'dance', 'late-night electronic', 'synthwave'],
  ['country', 'country pop', 'americana', 'soft rock', 'folk'],
  ['sad pop', 'cinematic pop', 'ballad', 'piano pop'],
];

// Cross-family bridges the spec calls out explicitly (indie pop -> soft R&B,
// R&B -> sad pop, sad pop -> indie folk, and so on).
const GENRE_BRIDGES: [string, string][] = [
  ['indie pop', 'rnb'],
  ['indie pop', 'alt pop'],
  ['indie pop', 'late-night electronic'],
  ['rnb', 'sad pop'],
  ['rnb', 'alt pop'],
  ['sad pop', 'indie folk'],
  ['sad pop', 'bedroom pop'],
  ['sad pop', 'soft rock'],
];

const GENRE_NEIGHBORS: Record<string, string[]> = (() => {
  const sets: Record<string, Set<string>> = {};
  const link = (a: string, b: string) => {
    if (a === b) return;
    (sets[a] = sets[a] ?? new Set()).add(b);
    (sets[b] = sets[b] ?? new Set()).add(a);
  };
  for (const fam of GENRE_FAMILIES) {
    for (const a of fam) for (const b of fam) link(a, b);
  }
  for (const [a, b] of GENRE_BRIDGES) link(a, b);
  const flat: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(sets)) flat[k] = [...v];
  return flat;
})();

export function adjacentGenres(genre: string | null | undefined): string[] {
  if (!genre) return [];
  return GENRE_NEIGHBORS[genre.trim().toLowerCase()] ?? [];
}

/** True when `b` is the same as, or adjacent to, `a`. Graceful on unknowns. */
export function genresRelated(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const aa = a.trim().toLowerCase();
  const bb = b.trim().toLowerCase();
  if (aa === bb) return true;
  return adjacentGenres(aa).includes(bb);
}
