import React, {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import {
  View, Text, Pressable, StyleSheet, TextInput, FlatList, ScrollView,
  Platform, ActivityIndicator, Keyboard, Dimensions,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle, useSharedValue, withSpring, withTiming,
  interpolate, Extrapolation, runOnJS,
} from 'react-native-reanimated';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { useComments, formatAge, fallbackHandle, avatarColor } from '@/contexts/CommentsContext';
import { useAuth } from '@/contexts/AuthContext';
import { useAppNav } from '@/contexts/NavigationContext';
import type { Song, SongComment, UserProfile } from '@/types';
import { HeartIcon, ArrowRightIcon } from '@/components/Icon';
import { usePlayerProgress } from '@/contexts/PlayerContext';
import { buildLyricView, activeLineIndex, type LyricView } from '@/lib/lyrics/syncedLyrics';

// Spotify-style player bottom sheet.
//
// Collapsed: a compact translucent teaser docked above the BottomNav showing
// the comment count. Expanded: a blurred dark sheet with
// two tabs, Comments (default, the priority surface) and Lyrics. The teaser
// deliberately shows no comment bodies — the user forms an opinion of the
// song first, then opens the sheet when they want the conversation.

const { height: SCREEN_H } = Dimensions.get('window');
const HEADER_H = 100;                              // grab handle + teaser / tab strip
/** Visible height of the collapsed sheet. The player reserves room for it. */
export const PLAYER_SHEET_PEEK = HEADER_H;
const EXPANDED_H = Math.round(SCREEN_H * 0.62);
const DRAG_RANGE = EXPANDED_H - HEADER_H;
const SPRING = { damping: 24, stiffness: 240, mass: 0.9 };
// One-tap emoji reactions shown above the comment composer.
const QUICK_REACTIONS = ['🔥', '❤️', '😂', '🙌', '💯', '🎶'];

// Comments are a core part of the experience on every platform — the web
// app gets the same Comments + Lyrics tabs as native.
const COMMENTS_ENABLED = true;

export interface PlayerSheetHandle {
  expand: () => void;
  collapse: () => void;
}

interface Props {
  song: Song | null;
  songId: string | null;
  /** Docked BottomNav height. The collapsed sheet sits just above it. */
  navHeight: number;
  /** Seek the player to an absolute position (ms) — tapping a lyric line. */
  onSeek: (ms: number) => void;
}

type TabKey = 'comments' | 'lyrics';

export const PlayerSheet = forwardRef<PlayerSheetHandle, Props>(function PlayerSheet(
  { song, songId, navHeight, onSeek }, ref,
) {
  const comments = useComments();
  const auth = useAuth();
  const nav = useAppNav();

  // 0 = collapsed, 1 = expanded. Drag + spring run on the UI thread.
  const progress = useSharedValue(0);
  const startProgress = useSharedValue(0);
  const kb = useSharedValue(0); // keyboard height — lifts the sheet so the composer clears it

  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<TabKey>(COMMENTS_ENABLED ? 'comments' : 'lyrics');
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<SongComment | null>(null);
  const [posting, setPosting] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const setExpandedJS = useCallback((v: boolean) => setExpanded(v), []);

  const expand = useCallback(() => {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    progress.value = withSpring(1, SPRING);
    setExpanded(true);
    setTab(COMMENTS_ENABLED ? 'comments' : 'lyrics');
  }, [progress]);

  const collapse = useCallback(() => {
    Keyboard.dismiss();
    progress.value = withSpring(0, SPRING);
    setExpanded(false);
  }, [progress]);

  useImperativeHandle(ref, () => ({ expand, collapse }), [expand, collapse]);

  // Lift the whole sheet by the keyboard height so the composer is never
  // hidden behind the keyboard. The sheet is not a Modal, so we drive this
  // ourselves rather than leaning on KeyboardAvoidingView.
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s = Keyboard.addListener(showEvt, (e) => {
      kb.value = withTiming(e.endCoordinates.height, { duration: 220 });
    });
    const h = Keyboard.addListener(hideEvt, () => {
      kb.value = withTiming(0, { duration: 220 });
    });
    return () => { s.remove(); h.remove(); };
  }, [kb]);

  // Pan lives on the grab handle + teaser/tab strip only. The comment list
  // and lyrics keep their own independent scroll — no nested-gesture fight.
  const pan = Gesture.Pan()
    .onBegin(() => {
      'worklet';
      startProgress.value = progress.value;
    })
    .onUpdate((e) => {
      'worklet';
      // Drag up (negative translationY) raises progress toward 1.
      const next = startProgress.value - e.translationY / DRAG_RANGE;
      progress.value = next < 0 ? 0 : next > 1 ? 1 : next;
    })
    .onEnd((e) => {
      'worklet';
      const open = e.velocityY < -300 || (e.velocityY <= 300 && progress.value > 0.4);
      progress.value = withSpring(open ? 1 : 0, SPRING);
      runOnJS(setExpandedJS)(open);
    });

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{
      translateY: interpolate(progress.value, [0, 1], [DRAG_RANGE, 0], Extrapolation.CLAMP) - kb.value,
    }],
  }));
  const teaserStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.28], [1, 0], Extrapolation.CLAMP),
  }));
  const expandedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.18, 1], [0, 1], Extrapolation.CLAMP),
  }));
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [0, 0.5], Extrapolation.CLAMP),
  }));

  const loadedThisSong = comments.loadedSongId === songId;
  const count = loadedThisSong ? comments.totalCount : 0;
  // First three distinct commenters — small overlapping orbs on the teaser.
  const teaserSeeds = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of comments.topLevel) {
      if (seen.has(c.user_id)) continue;
      seen.add(c.user_id);
      out.push(comments.profiles[c.user_id]?.avatar_seed || c.user_id);
      if (out.length === 3) break;
    }
    return out;
  }, [comments.topLevel, comments.profiles]);

  const lyricView = useMemo(
    () => buildLyricView(song?.synced_lyrics, song?.lyrics),
    [song?.synced_lyrics, song?.lyrics],
  );

  const handleReply = useCallback((c: SongComment) => {
    if (auth.isAnonymous) { nav.openSignup('comment'); return; }
    setReplyTo(c);
    const handle = comments.profiles[c.user_id]?.username ?? fallbackHandle(c.user_id);
    setDraft(`@${handle} `);
    setTimeout(() => inputRef.current?.focus(), 60);
  }, [auth.isAnonymous, nav, comments.profiles]);

  const handleToggleLike = useCallback((id: string) => {
    if (auth.isAnonymous) { nav.openSignup('comment'); return; }
    void comments.toggleLike(id);
  }, [auth.isAnonymous, nav, comments]);

  const handleSend = useCallback(async () => {
    if (!songId) return;
    if (auth.isAnonymous) { nav.openSignup('comment'); return; }
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    const ok = await comments.post({ songId, body, timestampSeconds: null, parentId: replyTo?.id ?? null });
    setPosting(false);
    if (ok) {
      setDraft('');
      setReplyTo(null);
    }
  }, [songId, auth.isAnonymous, nav, draft, posting, comments, replyTo]);

  // One-tap emoji reaction — posts the emoji as a top-level comment so a
  // user can respond without opening the keyboard. Gated like the composer.
  const handleQuickReaction = useCallback((emoji: string) => {
    if (!songId) return;
    if (auth.isAnonymous) { nav.openSignup('comment'); return; }
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    void comments.post({ songId, body: emoji, timestampSeconds: null, parentId: null });
  }, [songId, auth.isAnonymous, nav, comments]);

  return (
    <>
      {/* Scrim — darkens the player behind the sheet; tap to collapse. */}
      <Animated.View
        style={[styles.scrim, scrimStyle]}
        pointerEvents={expanded ? 'auto' : 'none'}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={collapse} />
      </Animated.View>

      <Animated.View style={[styles.sheet, { bottom: navHeight, height: EXPANDED_H }, sheetStyle]}>
        <BlurView tint="dark" intensity={36} style={StyleSheet.absoluteFill} />
        <View style={styles.sheetTint} pointerEvents="none" />
        <LinearGradient
          colors={[metals.glassHi, 'transparent']}
          locations={[0, 0.6]}
          style={styles.sheetGloss}
          pointerEvents="none"
        />

        {/* Header — grab handle + teaser (collapsed) / tab strip (expanded).
            The pan gesture lives here only; the lists below scroll freely. */}
        <GestureDetector gesture={pan}>
          <View style={styles.header}>
            <View style={styles.grabHandle} />

            {/* Collapsed teaser. No comment bodies — count + hint only. */}
            <Animated.View
              style={[styles.slot, teaserStyle]}
              pointerEvents={expanded ? 'none' : 'auto'}
            >
              <Pressable style={styles.teaserRow} onPress={expand} hitSlop={6}>
                {COMMENTS_ENABLED && teaserSeeds.length > 0 ? (
                  <View style={styles.teaserAvatars}>
                    {teaserSeeds.map((seed, i) => (
                      <AvatarOrb key={seed + i} seed={seed} size={26} style={i > 0 ? styles.teaserAvatarStacked : undefined} />
                    ))}
                  </View>
                ) : null}
                <View style={styles.teaserText}>
                  <Text style={styles.teaserMain} numberOfLines={1}>
                    {COMMENTS_ENABLED ? (count > 0 ? `${count} comments` : 'Comments') : 'Lyrics'}
                  </Text>
                </View>
              </Pressable>
            </Animated.View>

            {/* Expanded tab strip. */}
            <Animated.View
              style={[styles.slot, styles.tabStrip, expandedStyle]}
              pointerEvents={expanded ? 'auto' : 'none'}
            >
              {COMMENTS_ENABLED ? (
                <Pressable style={styles.tabBtn} onPress={() => setTab('comments')} hitSlop={8}>
                  <Text style={[styles.tabLabel, tab === 'comments' && styles.tabLabelActive]}>Comments</Text>
                  {tab === 'comments' ? <View style={styles.tabUnderline} /> : null}
                </Pressable>
              ) : null}
              <Pressable style={styles.tabBtn} onPress={() => setTab('lyrics')} hitSlop={8}>
                <Text style={[styles.tabLabel, tab === 'lyrics' && styles.tabLabelActive]}>Lyrics</Text>
                {tab === 'lyrics' ? <View style={styles.tabUnderline} /> : null}
              </Pressable>
            </Animated.View>
          </View>
        </GestureDetector>

        {/* Body — comment list + composer, or lyrics. */}
        <Animated.View
          style={[styles.body, expandedStyle]}
          pointerEvents={expanded ? 'auto' : 'none'}
        >
          {tab === 'comments' && COMMENTS_ENABLED ? (
            <>
              <FlatList
                data={comments.topLevel}
                keyExtractor={(c) => c.id}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.listContent}
                renderItem={({ item }) => (
                  <CommentRow
                    comment={item}
                    author={comments.profiles[item.user_id]}
                    replies={comments.repliesByParent[item.id] ?? []}
                    profiles={comments.profiles}
                    onReply={handleReply}
                    onToggleLike={handleToggleLike}
                  />
                )}
                ListEmptyComponent={
                  comments.loading ? (
                    <View style={styles.empty}><ActivityIndicator color={colors.textMuted} /></View>
                  ) : (
                    <View style={styles.empty}>
                      <Text style={styles.emptyText}>Be the first to comment.</Text>
                    </View>
                  )
                }
              />

              {replyTo ? (
                <View style={styles.replyBanner}>
                  <Text style={styles.replyBannerText} numberOfLines={1}>
                    Replying to {comments.profiles[replyTo.user_id]?.username ?? fallbackHandle(replyTo.user_id)}
                  </Text>
                  <Pressable onPress={() => { setReplyTo(null); setDraft(''); }} hitSlop={8}>
                    <Text style={styles.replyBannerCancel}>Cancel</Text>
                  </Pressable>
                </View>
              ) : null}

              {/* One-tap emoji reactions — the fast path to respond. */}
              <View style={styles.reactionsRow}>
                {QUICK_REACTIONS.map((emoji) => (
                  <Pressable
                    key={emoji}
                    onPress={() => handleQuickReaction(emoji)}
                    hitSlop={6}
                    style={({ pressed }) => [styles.reactionChip, pressed && styles.reactionChipPressed]}
                    accessibilityLabel={`React with ${emoji}`}
                  >
                    <Text style={styles.reactionEmoji}>{emoji}</Text>
                  </Pressable>
                ))}
              </View>

              {/* Composer. Anonymous users get bounced to signup on tap. */}
              <View style={styles.composer}>
                <AvatarOrb seed={auth.userId ?? 'me'} size={32} uri={auth.avatarUrl} />
                {auth.isAnonymous ? (
                  <Pressable style={styles.inputWrap} onPress={() => nav.openSignup('comment')}>
                    <Text style={styles.inputPlaceholder}>Sign in to add a comment</Text>
                  </Pressable>
                ) : (
                  <View style={styles.inputWrap}>
                    <TextInput
                      ref={inputRef}
                      value={draft}
                      onChangeText={setDraft}
                      placeholder="Add a comment..."
                      placeholderTextColor={colors.textMuted}
                      style={styles.input}
                      multiline
                      maxLength={500}
                    />
                  </View>
                )}
                <Pressable
                  onPress={handleSend}
                  disabled={posting || (!auth.isAnonymous && draft.trim().length === 0)}
                  style={[
                    styles.sendBtn,
                    (posting || (!auth.isAnonymous && draft.trim().length === 0)) && styles.sendBtnIdle,
                  ]}
                  hitSlop={6}
                  accessibilityLabel="Post comment"
                >
                  <View style={styles.sendIcon}>
                    <ArrowRightIcon size={16} color="#1a1408" />
                  </View>
                </Pressable>
              </View>
            </>
          ) : (
            <LyricsTab
              view={lyricView}
              songId={songId}
              visible={expanded}
              onSeek={onSeek}
            />
          )}
        </Animated.View>
      </Animated.View>
    </>
  );
});

// ---- Lyrics tab ------------------------------------------------------
//
// Read-along lyrics. As the song plays the current line is highlighted and
// the list auto-scrolls to keep it centered; tapping a line seeks there.
//
// When the song carries synced (LRC) lyrics — view.times is populated — the
// active line is the exact line being sung, looked up from real per-line
// timestamps so the listener can sing along. When it doesn't, the active line
// is estimated by spreading the plain-text lines evenly across the duration.
//
// usePlayerProgress() re-renders this component on every position tick, so
// it lives in its own component (not the PlayerSheet body) — the heavy
// sheet, the comment list and the composer never re-render on a tick.

function LyricsTab({
  view,
  songId,
  visible,
  onSeek,
}: {
  view: LyricView;
  songId: string | null;
  visible: boolean;
  onSeek: (ms: number) => void;
}) {
  const { position, duration } = usePlayerProgress();
  const scrollRef = useRef<ScrollView>(null);
  const lineYs = useRef<number[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);

  const lines = view.lines;

  // The line being sung at a given playback position. Accurate when the song
  // has synced (LRC) timestamps; an even-spaced estimate otherwise.
  const indexAt = useCallback((pos: number): number => {
    if (view.times) return activeLineIndex(view.times, pos);
    if (lines.length === 0 || duration <= 0) return 0;
    const ratio = Math.min(0.999, Math.max(0, pos / duration));
    return Math.min(lines.length - 1, Math.floor(ratio * lines.length));
  }, [view.times, lines.length, duration]);

  // Track the active line as playback advances. Only while the sheet is open
  // — no work when it's collapsed (the dominant state).
  useEffect(() => {
    if (!visible || lines.length === 0) return;
    const idx = indexAt(position);
    setActiveIndex((prev) => (prev === idx ? prev : idx));
  }, [visible, position, lines.length, indexAt]);

  // When the lyrics tab opens, jump straight to the line the song has
  // reached — the listener should land where the track is, not at the top.
  // The lines aren't measured on the first frame, so retry the jump on a
  // short delay until the active line's offset is known.
  useEffect(() => {
    if (!visible || lines.length === 0) return;
    const target = Math.max(0, indexAt(position));
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const jump = () => {
      const y = lineYs.current[target];
      if (typeof y === 'number') {
        scrollRef.current?.scrollTo({ y: Math.max(0, y - 140), animated: false });
      } else if (tries++ < 12) {
        timer = setTimeout(jump, 50);
      }
    };
    timer = setTimeout(jump, 50);
    return () => clearTimeout(timer);
    // Only re-run when the tab becomes visible — not on every position tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Keep the active line roughly centered. Runs only when activeIndex flips.
  useEffect(() => {
    if (!visible || activeIndex < 0) return;
    const y = lineYs.current[activeIndex];
    if (typeof y === 'number') {
      scrollRef.current?.scrollTo({ y: Math.max(0, y - 140), animated: true });
    }
  }, [activeIndex, visible]);

  // Reset scroll + active line whenever the song changes.
  useEffect(() => {
    setActiveIndex(-1);
    lineYs.current = [];
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [songId]);

  if (lines.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>Lyrics not available yet.</Text>
      </View>
    );
  }

  return (
    <ScrollView
      ref={scrollRef}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.lyricsContent}
    >
      {lines.map((line, i) => {
        const active = i === activeIndex;
        const past = i < activeIndex;
        return (
          <Pressable
            key={i}
            onPress={() => {
              // Synced lyrics seek to the line's real timestamp; estimated
              // lyrics seek to its proportional position in the song.
              if (view.times) onSeek(view.times[i]);
              else if (duration > 0) onSeek(Math.floor((i / lines.length) * duration));
            }}
            onLayout={(e) => { lineYs.current[i] = e.nativeEvent.layout.y; }}
            style={styles.lyricLinePressable}
          >
            <Text
              style={[
                styles.lyricLine,
                past && styles.lyricLinePast,
                active && styles.lyricLineActive,
              ]}
            >
              {line}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ---- Comment row -----------------------------------------------------

interface RowProps {
  comment: SongComment;
  author?: UserProfile;
  replies: SongComment[];
  profiles: Record<string, UserProfile>;
  onReply: (c: SongComment) => void;
  onToggleLike: (id: string) => void;
}

function CommentRow({ comment, author, replies, profiles, onReply, onToggleLike }: RowProps) {
  const [showReplies, setShowReplies] = useState(false);
  const handle = author?.display_name ?? author?.username ?? fallbackHandle(comment.user_id);

  return (
    <View style={styles.row}>
      <AvatarOrb seed={author?.avatar_seed || comment.user_id} size={38} uri={author?.avatar_url} />
      <View style={styles.rowBody}>
        <View style={styles.rowHead}>
          <Text style={styles.rowHandle} numberOfLines={1}>{handle}</Text>
          <Text style={styles.rowAge}>{formatAge(comment.created_at)}</Text>
        </View>
        <Text style={styles.rowText}>{comment.body}</Text>
        <View style={styles.rowActions}>
          <Pressable onPress={() => onReply(comment)} hitSlop={6}>
            <Text style={styles.rowReply}>Reply</Text>
          </Pressable>
          {comment.reply_count > 0 ? (
            <Pressable onPress={() => setShowReplies((v) => !v)} hitSlop={6}>
              <Text style={styles.rowReplyCount}>
                {showReplies ? 'Hide replies' : `View ${comment.reply_count} ${comment.reply_count === 1 ? 'reply' : 'replies'}`}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {showReplies ? replies.map((r) => {
          const rProfile = profiles[r.user_id];
          const rHandle = rProfile?.display_name ?? rProfile?.username ?? fallbackHandle(r.user_id);
          return (
            <View key={r.id} style={styles.replyRow}>
              <AvatarOrb seed={rProfile?.avatar_seed || r.user_id} size={26} uri={rProfile?.avatar_url} />
              <View style={styles.rowBody}>
                <View style={styles.rowHead}>
                  <Text style={[styles.rowHandle, styles.replyHandle]} numberOfLines={1}>{rHandle}</Text>
                  <Text style={styles.rowAge}>{formatAge(r.created_at)}</Text>
                </View>
                <Text style={[styles.rowText, styles.replyText]}>{r.body}</Text>
              </View>
            </View>
          );
        }) : null}
      </View>
      <Pressable style={styles.likeCol} onPress={() => onToggleLike(comment.id)} hitSlop={6}>
        <HeartIcon size={18} color={comment.liked_by_me ? colors.like : colors.textMuted} filled={comment.liked_by_me} />
        {comment.like_count > 0 ? <Text style={styles.likeCount}>{comment.like_count}</Text> : null}
      </Pressable>
    </View>
  );
}

// Avatar: the user's real social photo when we have one, otherwise a
// procedural gradient orb keyed off a seed (no upload needed).
function AvatarOrb({ seed, size, style, uri }: { seed: string; size: number; style?: object; uri?: string | null }) {
  const dims = { width: size, height: size, borderRadius: size / 2 };
  if (uri) {
    return <Image source={{ uri }} style={[dims, style]} contentFit="cover" transition={150} />;
  }
  const c = avatarColor(seed);
  return (
    <LinearGradient
      colors={[c.from, c.to]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[dims, style]}
    />
  );
}

// ---- styles ----------------------------------------------------------

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    overflow: 'hidden',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  // Dark translucent wash on top of the blur so text always reads cleanly
  // while the artwork still glows faintly through.
  sheetTint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(12,12,14,0.74)',
  },
  sheetGloss: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 64,
  },

  header: {
    height: HEADER_H,
  },
  grabHandle: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.28)',
    marginTop: 8,
    marginBottom: 4,
  },
  // The teaser and the tab strip share the slot directly under the handle;
  // they cross-fade as the sheet opens.
  slot: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    top: 24,
    bottom: 0,
    justifyContent: 'center',
  },

  teaserRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  teaserAvatars: {
    flexDirection: 'row',
  },
  teaserAvatarStacked: {
    marginLeft: -10,
    borderWidth: 1.5,
    borderColor: 'rgba(16,16,18,0.9)',
  },
  teaserText: {
    flex: 1,
    minWidth: 0,
  },
  teaserMain: {
    color: colors.text,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.bold,
  },

  tabStrip: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.xl,
  },
  tabBtn: {
    alignItems: 'center',
    paddingVertical: 4,
  },
  tabLabel: {
    color: colors.textMuted,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.semibold,
  },
  tabLabelActive: {
    color: colors.text,
    fontWeight: fonts.weight.bold,
  },
  tabUnderline: {
    marginTop: 6,
    width: 26,
    height: 2.5,
    borderRadius: 2,
    backgroundColor: metals.goldSolidHi,
  },

  body: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  empty: {
    paddingVertical: spacing.xxl,
    alignItems: 'center',
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 12,
    gap: spacing.sm,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  rowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 3,
  },
  rowHandle: {
    color: colors.text,
    fontSize: fonts.size.sm,
    fontWeight: fonts.weight.bold,
    flexShrink: 1,
  },
  replyHandle: {
    fontSize: fonts.size.xs,
  },
  rowAge: {
    color: colors.textDim,
    fontSize: fonts.size.xs,
  },
  rowText: {
    color: colors.text,
    fontSize: fonts.size.md,
    lineHeight: 20,
  },
  replyText: {
    fontSize: fonts.size.sm,
    lineHeight: 19,
  },
  rowActions: {
    flexDirection: 'row',
    gap: spacing.lg,
    marginTop: 6,
  },
  rowReply: {
    color: colors.textMuted,
    fontSize: fonts.size.xs,
    fontWeight: fonts.weight.semibold,
  },
  rowReplyCount: {
    color: colors.textDim,
    fontSize: fonts.size.xs,
    fontWeight: fonts.weight.semibold,
  },
  replyRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginTop: 12,
  },
  likeCol: {
    alignItems: 'center',
    paddingTop: 2,
    minWidth: 28,
  },
  likeCount: {
    color: colors.textDim,
    fontSize: 11,
    marginTop: 3,
    fontVariant: ['tabular-nums'],
  },

  replyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  replyBannerText: {
    color: colors.textMuted,
    fontSize: fonts.size.xs,
    flex: 1,
    marginRight: spacing.sm,
  },
  replyBannerCancel: {
    color: metals.goldSolidHi,
    fontSize: fonts.size.xs,
    fontWeight: fonts.weight.semibold,
  },

  reactionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.10)',
  },
  reactionChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  reactionChipPressed: {
    opacity: 0.5,
    transform: [{ scale: 0.86 }],
  },
  reactionEmoji: {
    fontSize: 26,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  inputWrap: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    minHeight: 38,
  },
  input: {
    color: colors.text,
    fontSize: fonts.size.md,
    maxHeight: 90,
    padding: 0,
  },
  inputPlaceholder: {
    color: colors.textMuted,
    fontSize: fonts.size.md,
  },
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnIdle: {
    opacity: 0.4,
  },
  sendIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: metals.goldSolidHi,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-90deg' }],
  },

  lyricsContent: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    // Generous tail so the final lines can still scroll up to the centred
    // active-line position instead of being stuck at the bottom edge.
    paddingBottom: 220,
  },
  lyricLinePressable: {
    paddingVertical: 3,
  },
  // Base lyric line — intentionally dimmed so the active line stands out.
  lyricLine: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 17,
    lineHeight: 28,
    fontWeight: fonts.weight.medium,
  },
  // Lines already sung — dimmed further so the eye lands on the active line.
  lyricLinePast: {
    color: 'rgba(255,255,255,0.28)',
  },
  // The line playing right now — bright, bold, slightly larger.
  lyricLineActive: {
    color: colors.text,
    fontSize: 19,
    lineHeight: 28,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.2,
  },
});
