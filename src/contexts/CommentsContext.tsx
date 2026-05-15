import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import type { SongComment, UserProfile } from '@/types';

// Per-song comment cache. Sheet opens → loadFor(songId) fetches the latest
// snapshot, then optimistic mutations write through immediately and refresh
// on next open. Real-time updates are deferred (sheet is short-lived).

interface Ctx {
  /** Comments for the currently loaded song, top-level only. Sorted by popularity. */
  topLevel: SongComment[];
  /** parent_id → [replies] */
  repliesByParent: Record<string, SongComment[]>;
  /** Authors by user_id, joined client-side. */
  profiles: Record<string, UserProfile>;
  loading: boolean;
  /** Last-loaded song id. Lets the sheet decide whether to refetch. */
  loadedSongId: string | null;
  loadFor: (songId: string) => Promise<void>;
  /** Returns true on success (DB row created), false on auth/network/RLS failure. */
  post: (input: { songId: string; body: string; timestampSeconds?: number | null; parentId?: string | null }) => Promise<boolean>;
  toggleLike: (commentId: string) => Promise<void>;
  /** Total comment count for the song, including replies. */
  totalCount: number;
}

const CommentsContext = createContext<Ctx | null>(null);

export function CommentsProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const { userId } = auth;
  const [topLevel, setTopLevel] = useState<SongComment[]>([]);
  const [repliesByParent, setRepliesByParent] = useState<Record<string, SongComment[]>>({});
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>({});
  const [loading, setLoading] = useState(false);
  const [loadedSongId, setLoadedSongId] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  // Track which comment ids the current user has liked. Loaded with the
  // comments fetch via a single query against song_comment_likes.
  const likedIdsRef = useRef<Set<string>>(new Set());

  // Bulk-fetch profiles for a set of user_ids and merge into local cache.
  // Falls back to a synthetic profile when a row doesn't exist yet — so the
  // UI never shows a blank avatar/name.
  const ensureProfiles = useCallback(async (userIds: string[]) => {
    if (!supabase || userIds.length === 0) return;
    const missing = userIds.filter((id) => !profiles[id]);
    if (missing.length === 0) return;
    const { data } = await supabase
      .from('user_profiles')
      .select('user_id, username, display_name, avatar_seed, created_at')
      .in('user_id', missing);
    const merged: Record<string, UserProfile> = { ...profiles };
    const seen = new Set<string>();
    for (const row of (data ?? []) as UserProfile[]) {
      merged[row.user_id] = row;
      seen.add(row.user_id);
    }
    // Synthesize profiles for any users without rows yet.
    for (const id of missing) {
      if (!seen.has(id)) {
        merged[id] = { user_id: id, username: null, display_name: null, avatar_seed: id };
      }
    }
    setProfiles(merged);
  }, [profiles]);

  // Load everything for one song in 2 round-trips: comments, then likes (if logged in).
  const loadFor = useCallback(async (songId: string) => {
    if (!HAS_SUPABASE || !supabase) return;
    setLoading(true);
    try {
      const { data: rows } = await supabase
        .from('song_comments')
        .select('*')
        .eq('song_id', songId)
        .order('created_at', { ascending: false })
        .limit(500);
      const all = (rows ?? []) as SongComment[];
      setTotalCount(all.length);

      // Which of these has the current user liked?
      likedIdsRef.current = new Set();
      if (userId && all.length > 0) {
        const ids = all.map((c) => c.id);
        const { data: likes } = await supabase
          .from('song_comment_likes')
          .select('comment_id')
          .eq('user_id', userId)
          .in('comment_id', ids);
        for (const row of (likes ?? []) as Array<{ comment_id: string }>) {
          likedIdsRef.current.add(row.comment_id);
        }
      }

      // Split into top-level + reply buckets.
      const tops: SongComment[] = [];
      const buckets: Record<string, SongComment[]> = {};
      for (const c of all) {
        c.liked_by_me = likedIdsRef.current.has(c.id);
        if (c.parent_id) {
          (buckets[c.parent_id] ||= []).push(c);
        } else {
          tops.push(c);
        }
      }
      // Replies oldest → newest (conversation order).
      for (const k of Object.keys(buckets)) buckets[k].sort((a, b) => a.created_at.localeCompare(b.created_at));
      // Top-level: popularity = likes + replies*2, then recency.
      tops.sort((a, b) => {
        const pa = a.like_count + a.reply_count * 2;
        const pb = b.like_count + b.reply_count * 2;
        if (pb !== pa) return pb - pa;
        return b.created_at.localeCompare(a.created_at);
      });

      setTopLevel(tops);
      setRepliesByParent(buckets);
      setLoadedSongId(songId);

      // Profile join (collect distinct authors).
      const ids = Array.from(new Set(all.map((c) => c.user_id)));
      void ensureProfiles(ids);
    } finally {
      setLoading(false);
    }
  }, [userId, ensureProfiles]);

  const post = useCallback(async ({ songId, body, timestampSeconds, parentId }: { songId: string; body: string; timestampSeconds?: number | null; parentId?: string | null }): Promise<boolean> => {
    if (!HAS_SUPABASE || !supabase || !userId) return false;
    // Anonymous users are blocked from posting comments. The DB-level
    // RLS now also enforces this (song_comments insert requires
    // user_profiles.has_signed_up=true), but bailing here is faster
    // and gives the UI a chance to show the signup sheet instead of
    // an opaque error.
    if (auth.isAnonymous) return false;
    const trimmed = body.trim();
    if (!trimmed) return false;

    const { data, error } = await supabase
      .from('song_comments')
      .insert({
        song_id: songId,
        user_id: userId,
        parent_id: parentId ?? null,
        body: trimmed.slice(0, 500),
        timestamp_seconds: timestampSeconds ?? null,
      })
      .select('*')
      .single();
    if (error || !data) return false;
    const created = data as SongComment;
    created.liked_by_me = false;

    if (parentId) {
      setRepliesByParent((cur) => ({ ...cur, [parentId]: [...(cur[parentId] ?? []), created] }));
      setTopLevel((cur) => cur.map((c) => c.id === parentId ? { ...c, reply_count: c.reply_count + 1 } : c));
    } else {
      // New top-level lands at the top of the list immediately so the user
      // can confirm their post landed without scrolling. Popularity sort
      // resumes on next refresh.
      setTopLevel((cur) => [created, ...cur]);
    }
    setTotalCount((n) => n + 1);
    void ensureProfiles([userId]);
    return true;
  }, [userId, auth.isAnonymous, ensureProfiles]);

  const toggleLike = useCallback(async (commentId: string) => {
    if (!HAS_SUPABASE || !supabase || !userId) return;
    // Anonymous users cannot like comments. We refuse the action here
    // so the optimistic UI flip doesn't fire — without this guard the
    // heart would visually toggle and then re-load to its original
    // state when the DB insert was refused by RLS.
    if (auth.isAnonymous) return;
    const wasLiked = likedIdsRef.current.has(commentId);
    // Optimistic flip.
    if (wasLiked) likedIdsRef.current.delete(commentId);
    else likedIdsRef.current.add(commentId);

    const bump = (c: SongComment): SongComment =>
      c.id === commentId ? { ...c, like_count: Math.max(0, c.like_count + (wasLiked ? -1 : 1)), liked_by_me: !wasLiked } : c;
    setTopLevel((cur) => cur.map(bump));
    setRepliesByParent((cur) => {
      const next: Record<string, SongComment[]> = {};
      for (const [k, arr] of Object.entries(cur)) next[k] = arr.map(bump);
      return next;
    });

    try {
      if (wasLiked) {
        await supabase.from('song_comment_likes').delete().eq('comment_id', commentId).eq('user_id', userId);
      } else {
        await supabase.from('song_comment_likes').insert({ comment_id: commentId, user_id: userId });
      }
    } catch {
      // Rollback on failure by re-loading.
      if (loadedSongId) void loadFor(loadedSongId);
    }
  }, [userId, auth.isAnonymous, loadedSongId, loadFor]);

  const value = useMemo<Ctx>(() => ({
    topLevel, repliesByParent, profiles, loading, loadedSongId, loadFor, post, toggleLike, totalCount,
  }), [topLevel, repliesByParent, profiles, loading, loadedSongId, loadFor, post, toggleLike, totalCount]);

  return <CommentsContext.Provider value={value}>{children}</CommentsContext.Provider>;
}

export function useComments(): Ctx {
  const ctx = useContext(CommentsContext);
  if (!ctx) throw new Error('useComments must be used inside <CommentsProvider>');
  return ctx;
}

// ===== Helpers used by the sheet =====================================

/** Format MM:SS for the timestamp pill. */
export function formatStamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Short "3d ago" style relative time, matching the screenshot. */
export function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** Build a "boulevard_abcdef" handle when the user has no username yet. */
export function fallbackHandle(userId: string): string {
  return `boulevard_${userId.slice(0, 6)}`;
}

// Light-touch sentiment heuristics. The player-feed comment overlay
// shows only the most-liked positive/neutral comments — never negative
// ones — so a single 🔥 reaction or a kind line drifts past the artwork
// instead of "this song is trash."
//
// Trade-off: a learned classifier would catch sarcasm and edge cases
// better than a list, but it costs a model dependency + latency on
// every comment. For v1 a curated keyword + emoji list catches the
// loud 99% (slurs, dunks, "skip", thumbs-down, vomit emoji).
const NEGATIVE_EMOJIS = new Set(['👎', '💩', '🤮', '🤢', '😡', '🤡', '💀', '👿', '😒', '😤', '🙄', '😴']);
const NEGATIVE_KEYWORDS = [
  'trash', 'garbage', 'mid', 'skip', 'awful', 'terrible', 'boring',
  'wack', 'sucks', 'worst', 'annoying', 'hate', 'cringe', 'overrated',
  'overplayed', 'shit', 'crap', 'ass', 'meh', 'flop',
];

export function isNegativeComment(body: string | null | undefined): boolean {
  if (!body) return false;
  const trimmed = body.trim();
  if (!trimmed) return false;
  // Pure-emoji message: classify by emoji.
  for (const ch of trimmed) {
    if (NEGATIVE_EMOJIS.has(ch)) return true;
  }
  // Word-boundary keyword scan on the lowercased text. Matches
  // "this song is trash" but not the substring inside "trasher".
  const lower = trimmed.toLowerCase();
  return NEGATIVE_KEYWORDS.some((kw) =>
    new RegExp(`(^|[^a-z])${kw}([^a-z]|$)`).test(lower),
  );
}

/**
 * Top N most-liked positive/neutral comments for the currently-loaded
 * song. Used by the drift overlay on the player feed.
 *
 *   • Skips comments by the current user themselves (don't echo back
 *     your own words at you).
 *   • Skips negative comments (see isNegativeComment).
 *   • Sorts by like_count desc, then by recency.
 *   • Filters out replies (top-level only).
 */
export function topPositiveComments(
  topLevel: SongComment[],
  currentUserId: string | null,
  limit = 5,
): SongComment[] {
  return topLevel
    .filter((c) => c.user_id !== currentUserId)
    .filter((c) => !isNegativeComment(c.body))
    .sort((a, b) => {
      if (b.like_count !== a.like_count) return b.like_count - a.like_count;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    })
    .slice(0, limit);
}

/** Deterministic avatar color from a seed string. Mirrors the colorful
 *  gradient avatars in the screenshot — no asset upload needed. */
export function avatarColor(seed: string): { from: string; to: string } {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  const hue2 = (hue + 40) % 360;
  return {
    from: `hsl(${hue}, 80%, 62%)`,
    to: `hsl(${hue2}, 75%, 50%)`,
  };
}
