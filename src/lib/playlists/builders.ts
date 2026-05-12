import { Song } from '@/types';
import { TasteProfile } from '@/types';
import { rankCandidates } from '@/lib/recommendation/RecommendationEngine';
import { LibraryStore } from '@/lib/library/LibraryStore';

// Library playlist builders. Each returns the ordered list of songs that
// belongs in a given dynamic playlist, plus a cover image (the first song's
// cover, so the playlist always looks alive even with a tiny catalog).
//
// All builders are pure — they never mutate inputs and never call the network.
// They run client-side on the catalog the player already has, which keeps the
// Library tab instant and offline-capable.

export interface BuiltPlaylist {
  id: PlaylistId;
  name: string;
  description: string;
  songs: Song[];
  /** First song's cover, or null if the playlist is empty. */
  coverUrl: string | null;
}

export type PlaylistId =
  | 'new_for_you'
  | 'your_best_ones'
  | 'gym_beast'
  | 'ceo_mode';

// ---- New For You -----------------------------------------------------
//
// Fresh songs the user hasn't heard yet, ranked by their taste profile.
// We hand off to the same recommendation engine that powers auto-advance —
// so what shows up here is exactly what the queue would feed next.
export function buildNewForYou(
  catalog: Song[],
  library: LibraryStore | null,
  taste: TasteProfile | null,
  recentSongIds: string[],
  interactionCount: number,
): BuiltPlaylist {
  const heardIds = new Set<string>(recentSongIds);
  library?.recent().forEach((s) => heardIds.add(s.id));
  const fresh = catalog.filter((s) => !heardIds.has(s.id));

  // Rank using the live taste profile so saved/replayed signals already pull
  // future picks toward the user's preferred sounds.
  const songs = taste
    ? rankCandidates(fresh, {
        taste,
        vibe: null,
        recentSongIds,
        interactionCount,
        stats: new Map(),
      }, [], 40)
    : fresh.slice(0, 40);

  return {
    id: 'new_for_you',
    name: 'New For You',
    description: 'Fresh songs picked by AI for your taste.',
    songs,
    coverUrl: songs[0]?.cover_url ?? null,
  };
}

// ---- Your Best Ones --------------------------------------------------
//
// Songs the user has already engaged with the most. Saved songs lead, then
// recents in playback-order. We dedupe across both, capped at 40.
export function buildYourBestOnes(library: LibraryStore | null): BuiltPlaylist {
  const seen = new Set<string>();
  const songs: Song[] = [];
  if (library) {
    for (const s of library.saved()) {
      if (!seen.has(s.id)) { songs.push(s); seen.add(s.id); }
    }
    for (const s of library.recent()) {
      if (!seen.has(s.id)) { songs.push(s); seen.add(s.id); }
    }
  }
  return {
    id: 'your_best_ones',
    name: 'Your Best Ones',
    description: 'Your most replayed and saved songs.',
    songs: songs.slice(0, 40),
    coverUrl: songs[0]?.cover_url ?? null,
  };
}

// ---- Gym Beast -------------------------------------------------------
//
// High-energy workout fuel. Filters to songs explicitly tagged for gym /
// aggressive activity, then re-orders by energy_score so the hardest hitters
// land near the top.
export function buildGymBeast(catalog: Song[]): BuiltPlaylist {
  const songs = catalog
    .filter((s) => s.activity_fit.includes('gym') || s.activity_fit.includes('aggressive'))
    .filter((s) => (s.energy_score ?? 0) >= 0.4)  // drop calm outliers
    .sort((a, b) => (b.energy_score ?? 0) - (a.energy_score ?? 0))
    .slice(0, 40);
  return {
    id: 'gym_beast',
    name: 'Gym Beast',
    description: 'High-energy music for workouts.',
    songs,
    coverUrl: songs[0]?.cover_url ?? null,
  };
}

// ---- CEO Mode --------------------------------------------------------
//
// Focus beats — instrumental and calm/focus-tagged. Excludes anything with
// vocals or aggressive energy. Ranked by launch_score so editorial-quality
// instrumentals lead.
export function buildCeoMode(catalog: Song[]): BuiltPlaylist {
  const songs = catalog
    .filter((s) => s.vocal_type === 'instrumental')
    .filter((s) =>
      s.activity_fit.includes('focus') || s.activity_fit.includes('calm'))
    .filter((s) => !s.activity_fit.includes('aggressive'))
    .sort((a, b) => (b.launch_score ?? 0) - (a.launch_score ?? 0))
    .slice(0, 40);
  return {
    id: 'ceo_mode',
    name: 'CEO Mode',
    description: 'Focus beats for deep work. No lyrics.',
    songs,
    coverUrl: songs[0]?.cover_url ?? null,
  };
}
