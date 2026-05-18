// Synced (LRC) lyrics support.
//
// A song may carry time-synced lyrics in LRC format — each line prefixed with
// one or more [mm:ss.xx] timestamps. When present, the player highlights the
// exact line being sung so the listener can sing along. When absent, the
// player falls back to estimating the active line by spreading the plain-text
// lyrics evenly across the song's duration.

/** A single lyric line with its start time. */
export interface SyncedLine {
  /** Start time in milliseconds. */
  time: number;
  text: string;
}

// One LRC timestamp: [mm:ss], [mm:ss.xx] or [mm:ss.xxx]. Minutes/seconds may be
// 1-2 digits; the optional fractional part is 1-3 digits of centi-/milliseconds.
const LRC_TIMESTAMP = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
// A line that is only a [Verse]/[Chorus]-style section header — not a lyric.
const SECTION_HEADER = /^\s*\[.*\]\s*$/;

/**
 * Parse LRC-format synced lyrics into time-sorted lines. Lines without a
 * timestamp (metadata tags like [ar:], blank lines) are dropped. A single
 * line may carry several timestamps — a repeated chorus — and each becomes its
 * own entry. Returns [] when nothing usable is found, so callers can fall back
 * to estimation.
 */
export function parseLrc(raw: string | null | undefined): SyncedLine[] {
  if (!raw) return [];
  const out: SyncedLine[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    LRC_TIMESTAMP.lastIndex = 0;
    const times: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = LRC_TIMESTAMP.exec(rawLine)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      // Normalize the fractional part to a 0..1 second fraction regardless of
      // whether it was written as centiseconds (2 digits) or millis (3).
      const fracDigits = m[3] ?? '';
      const frac = fracDigits ? parseInt(fracDigits, 10) / 10 ** fracDigits.length : 0;
      times.push(Math.round((min * 60 + sec + frac) * 1000));
    }
    if (times.length === 0) continue;
    const text = rawLine.replace(LRC_TIMESTAMP, '').trim();
    if (!text || SECTION_HEADER.test(text)) continue;
    for (const t of times) out.push({ time: t, text });
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * Split plain-text lyrics into display lines: trims whitespace, drops blank
 * lines and [Verse]/[Chorus] scaffolding headers. Used when a song has no
 * synced lyrics.
 */
export function splitPlainLyrics(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !SECTION_HEADER.test(l));
}

/** Display lines plus, when the song has real timestamps, per-line start
 *  times. `synced` is true only when `times` carries accurate LRC timing. */
export interface LyricView {
  synced: boolean;
  lines: string[];
  /** Per-line start time (ms). Present iff `synced`; null in estimate mode. */
  times: number[] | null;
}

/** Resolve a song's lyric fields into a LyricView. Prefers accurate synced
 *  lyrics; falls back to plain text when no usable timestamps are present. */
export function buildLyricView(
  syncedRaw: string | null | undefined,
  plainRaw: string | null | undefined,
): LyricView {
  const synced = parseLrc(syncedRaw);
  if (synced.length > 0) {
    return { synced: true, lines: synced.map((l) => l.text), times: synced.map((l) => l.time) };
  }
  return { synced: false, lines: splitPlainLyrics(plainRaw), times: null };
}

/**
 * Index of the line being sung at `positionMs` — the last line whose start
 * time has passed. Returns -1 before the first line begins (intro / lead-in)
 * so nothing is highlighted until the first lyric actually starts. `times`
 * must be ascending (parseLrc guarantees this).
 */
export function activeLineIndex(times: number[], positionMs: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= positionMs) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}
