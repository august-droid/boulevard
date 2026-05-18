// Query + field normalization for Boulevard search.
//
// One normal form for both the indexed catalog fields and the live query, so
// matching is punctuation-, case- and apostrophe-insensitive. Notably every
// apostrophe variant is DELETED rather than turned into a space, so "Don't",
// "Don’t" and "Dont" all collapse to "dont" — "dont text" then substring-
// matches "dont text first".

// Straight ', curly ' ', modifier-letter ʼ, backtick `, acute accent ´.
const APOSTROPHES = /['‘’ʼ`´]/g;

/** Lowercase, fold/strip apostrophes, punctuation → space, collapse spaces. */
export function normalize(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalized word tokens. Empty array for empty/blank input. */
export function tokenize(text: string | null | undefined): string[] {
  const n = normalize(text);
  return n.length === 0 ? [] : n.split(' ');
}
