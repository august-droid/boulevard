import { Song } from '@/types';
import catalog from './catalog.json';

// Local fallback catalog. The CSV importer (scripts/import-songs.mjs) can
// overwrite this file so the bundled app can ship without Supabase.
//
// At runtime the order of preference is:
//   1) songs from Supabase (when EXPO_PUBLIC_SUPABASE_* env vars are set)
//   2) this JSON catalog (always bundled)
//   3) empty — UI will show a loading state
//
// To replace the catalog with your own songs, either:
//   • run `npm run import:songs` (writes both Supabase and this JSON), or
//   • drop a hand-edited `catalog.json` here with the same shape.

export const SEED_SONGS: Song[] = catalog as Song[];
