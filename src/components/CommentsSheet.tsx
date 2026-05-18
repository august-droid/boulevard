import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  FlatList,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { useComments, formatStamp, formatAge, displayHandle, avatarColor } from '@/contexts/CommentsContext';
import { useAuth } from '@/contexts/AuthContext';
import { useAppNav } from '@/contexts/NavigationContext';
import type { SongComment, UserProfile } from '@/types';
import { HeartIcon, MoreIcon } from '@/components/Icon';

// TikTok-style bottom-sheet comments. Tappable timestamp pill seeks the
// player. Heart toggles a like. Quick-emoji strip posts a one-emoji comment
// pinned to the current playhead.

interface Props {
  visible: boolean;
  songId: string | null;
  /** Player playhead in MILLISECONDS. Used for both the timestamp pill
   *  preview in the composer and quick-emoji posts. */
  currentPositionMs: number;
  onSeek: (ms: number) => void;
  onClose: () => void;
}

const REACTIONS = ['🔥', '😍', '😱', '🙌', '👍', '👎', '🥵'];

export function CommentsSheet({ visible, songId, currentPositionMs, onSeek, onClose }: Props) {
  const { topLevel, repliesByParent, profiles, loading, loadedSongId, totalCount, loadFor, post, toggleLike } = useComments();
  const auth = useAuth();
  const nav = useAppNav();
  // Two reasons to gate the composer:
  //   isAnonymous       — the user has not signed up yet. Tap → SignupSheet.
  //   signupConfirming  — they just signed up, but user_profiles.has_signed_up
  //                       is still being written + verified server-side.
  //                       RLS would reject a comment insert in this
  //                       window, so we wait it out with a different
  //                       message ("Finishing sign-in...") and do NOT
  //                       re-open SignupSheet on tap.
  const gated = auth.isAnonymous || auth.signupConfirming;
  const finishingSignup = auth.signupConfirming && !auth.isAnonymous;
  const requireSignup = useCallback((): boolean => {
    if (!gated) return false;
    // Only re-open SignupSheet when the user is actually anonymous.
    // During the confirmation window we just swallow the tap so they
    // can't accidentally re-enter the auth flow.
    if (auth.isAnonymous) nav.openSignup('comment');
    return true;
  }, [gated, auth.isAnonymous, nav]);

  const [draft, setDraft] = useState('');
  // When non-null: composer is in "reply mode" targeting this comment.
  const [replyTo, setReplyTo] = useState<SongComment | null>(null);
  // Whether the composer should attach the current playhead. Defaults on.
  const [attachStamp, setAttachStamp] = useState(true);
  // Inline error banner — shown when a post fails (RLS, network, etc.) so
  // the user actually knows their tap didn't land. Auto-dismisses on next
  // successful action.
  const [postError, setPostError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<SongComment>>(null);

  const showError = useCallback((msg: string) => {
    setPostError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setPostError(null), 4000);
  }, []);

  // Refresh whenever the sheet opens for a different song. Keeps cache stale
  // on a song change — TikTok mechanics: comments rebind on swipe.
  useEffect(() => {
    if (visible && songId && songId !== loadedSongId) {
      void loadFor(songId);
    }
  }, [visible, songId, loadedSongId, loadFor]);

  const handleSubmit = useCallback(async () => {
    if (!songId) return;
    // Anonymous → open signup. Keep the draft in state so the user
    // returns to a typed-out comment after they finish signing up.
    if (requireSignup()) return;
    const trimmed = draft.trim();
    if (!trimmed) return;
    const stampSec = attachStamp ? Math.floor(currentPositionMs / 1000) : null;
    const ok = await post({
      songId,
      body: trimmed,
      timestampSeconds: stampSec,
      parentId: replyTo?.id ?? null,
    });
    // Preserve the draft if the post failed (RLS, network, auth). Without
    // this the user types a paragraph and watches it vanish silently.
    if (!ok) {
      showError("Couldn't post. Try again.");
      return;
    }
    setPostError(null);
    setDraft('');
    setReplyTo(null);
    // Scroll to top so the user can see their freshly-posted comment land.
    // Replies are inline under their parent, so this only fires for top-level.
    if (!replyTo) listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, [songId, draft, attachStamp, currentPositionMs, post, replyTo, showError, requireSignup]);

  const handleReaction = useCallback(async (emoji: string) => {
    if (!songId) return;
    // Tap-an-emoji posts a one-character "reaction comment." Same gate
    // applies — anonymous users can't react.
    if (requireSignup()) return;
    const ok = await post({
      songId,
      body: emoji,
      timestampSeconds: Math.floor(currentPositionMs / 1000),
      parentId: null,
    });
    if (ok) {
      setPostError(null);
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    } else {
      showError("Couldn't react. Try again.");
    }
  }, [songId, post, currentPositionMs, showError, requireSignup]);

  const handleReplyTap = useCallback((target: SongComment) => {
    // Don't prefill a reply draft for anonymous users — that would
    // visually commit them to a reply they can't actually post.
    if (requireSignup()) return;
    setReplyTo(target);
    const author = profiles[target.user_id];
    const handle = displayHandle(author, target.user_id);
    setDraft(`@${handle} `);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [profiles, requireSignup]);

  // Comment-like gate. Wraps the CommentsContext.toggleLike so the
  // optimistic flip never even renders for anonymous users; without this
  // the heart would briefly fill, then immediately revert on the RLS
  // rejection.
  const handleToggleLike = useCallback(async (id: string) => {
    if (requireSignup()) return;
    await toggleLike(id);
  }, [toggleLike, requireSignup]);

  if (!visible) return null;

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ width: '100%' }}
        >
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.handle} />
            <Text style={styles.title}>{totalCount} {totalCount === 1 ? 'Comment' : 'Comments'}</Text>

            <FlatList
              ref={listRef}
              data={topLevel}
              keyExtractor={(c) => c.id}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingBottom: spacing.sm }}
              renderItem={({ item }) => (
                <CommentRow
                  comment={item}
                  author={profiles[item.user_id]}
                  replies={repliesByParent[item.id] ?? []}
                  authorsByUserId={profiles}
                  onSeekTo={onSeek}
                  onReply={handleReplyTap}
                  onToggleLike={handleToggleLike}
                />
              )}
              ListEmptyComponent={
                loading ? (
                  <View style={styles.emptyWrap}>
                    <ActivityIndicator color={colors.textMuted} />
                  </View>
                ) : (
                  <View style={styles.emptyWrap}>
                    <Text style={styles.empty}>Be the first to comment.</Text>
                  </View>
                )
              }
            />

            {/* Reaction strip — taps post a one-emoji comment pinned to current playhead */}
            <View style={styles.reactionStrip}>
              {REACTIONS.map((e) => (
                <Pressable key={e} onPress={() => handleReaction(e)} hitSlop={8}>
                  <Text style={styles.reactionEmoji}>{e}</Text>
                </Pressable>
              ))}
            </View>

            {/* Reply-to banner */}
            {replyTo ? (
              <View style={styles.replyBanner}>
                <Text style={styles.replyBannerText} numberOfLines={1}>
                  Replying to {displayHandle(profiles[replyTo.user_id], replyTo.user_id)}
                </Text>
                <Pressable onPress={() => { setReplyTo(null); setDraft(''); }} hitSlop={8}>
                  <Text style={styles.replyBannerCancel}>Cancel</Text>
                </Pressable>
              </View>
            ) : null}

            {/* Inline error toast. Auto-dismisses after 4s on next success. */}
            {postError ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorBannerText}>{postError}</Text>
              </View>
            ) : null}

            {/* Composer.
                Anonymous: the whole input is a Pressable that opens
                  SignupSheet. The text field is non-editable so it
                  cannot receive focus or accept keystrokes, and the
                  Send button reads "Sign in".
                Signed up: the normal compose-and-send flow. */}
            <View style={styles.composer}>
              <View style={styles.composerAvatar}>
                <AvatarOrb seed="me" size={36} />
              </View>
              {gated ? (
                <Pressable
                  style={styles.composerInputWrap}
                  onPress={() => {
                    // During the post-signup confirmation window the
                    // tap is a no-op. Once isAnonymous is true again
                    // (or never flipped), the tap opens SignupSheet.
                    if (auth.isAnonymous) nav.openSignup('comment');
                  }}
                  hitSlop={6}
                  disabled={finishingSignup}
                >
                  {finishingSignup ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                      <ActivityIndicator size="small" color={colors.textMuted} />
                      <Text style={styles.composerGatedPlaceholder} numberOfLines={1}>
                        Finishing sign-in...
                      </Text>
                    </View>
                  ) : (
                    <Text style={styles.composerGatedPlaceholder} numberOfLines={1}>
                      Sign in to join the conversation
                    </Text>
                  )}
                </Pressable>
              ) : (
                <View style={styles.composerInputWrap}>
                  <TextInput
                    ref={inputRef}
                    value={draft}
                    onChangeText={setDraft}
                    placeholder="Add a comment..."
                    placeholderTextColor={colors.textMuted}
                    style={styles.composerInput}
                    multiline
                    maxLength={500}
                    returnKeyType="send"
                    blurOnSubmit
                    onSubmitEditing={handleSubmit}
                  />
                  <Pressable
                    onPress={() => setAttachStamp((v) => !v)}
                    hitSlop={6}
                    style={[styles.stampToggle, !attachStamp && styles.stampToggleOff]}
                  >
                    <Text style={[styles.stampToggleText, !attachStamp && styles.stampToggleTextOff]}>
                      {formatStamp(currentPositionMs / 1000)}
                    </Text>
                  </Pressable>
                </View>
              )}
              <Pressable
                onPress={() => {
                  if (finishingSignup) return; // wait it out
                  if (auth.isAnonymous) { nav.openSignup('comment'); return; }
                  void handleSubmit();
                }}
                disabled={finishingSignup || (!gated && draft.trim().length === 0)}
                style={[
                  styles.sendBtn,
                  finishingSignup && { opacity: 0.5 },
                  !gated && draft.trim().length === 0 && { opacity: 0.35 },
                ]}
                hitSlop={8}
              >
                <Text style={styles.sendBtnText}>
                  {finishingSignup ? '...' : auth.isAnonymous ? 'Sign in' : 'Send'}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

// ===== Comment row + replies ==========================================

interface RowProps {
  comment: SongComment;
  author?: UserProfile;
  replies: SongComment[];
  authorsByUserId: Record<string, UserProfile>;
  onSeekTo: (ms: number) => void;
  onReply: (c: SongComment) => void;
  onToggleLike: (id: string) => Promise<void>;
}

function CommentRow({ comment, author, replies, authorsByUserId, onSeekTo, onReply, onToggleLike }: RowProps) {
  const [showReplies, setShowReplies] = useState(false);
  const handle = displayHandle(author, comment.user_id);

  return (
    <View style={styles.row}>
      <AvatarOrb seed={author?.avatar_seed || comment.user_id} size={40} />
      <View style={styles.rowBody}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowHandle}>{handle}</Text>
          <Text style={styles.rowMeta}>{formatAge(comment.created_at)}</Text>
          {comment.timestamp_seconds != null ? (
            <Pressable onPress={() => onSeekTo(Math.floor(comment.timestamp_seconds! * 1000))} hitSlop={4}>
              <Text style={styles.stampPill}>at {formatStamp(comment.timestamp_seconds)}</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.rowText}>{comment.body}</Text>
        <View style={styles.rowActions}>
          <Pressable onPress={() => onReply(comment)} hitSlop={6}>
            <Text style={styles.rowAction}>Reply</Text>
          </Pressable>
          {comment.reply_count > 0 ? (
            <Pressable onPress={() => setShowReplies((v) => !v)} hitSlop={6}>
              <Text style={styles.rowActionDim}>
                {showReplies ? 'Hide' : `View ${comment.reply_count}`} {comment.reply_count === 1 ? 'reply' : 'replies'}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {showReplies && replies.map((r) => (
          <ReplyRow
            key={r.id}
            comment={r}
            author={authorsByUserId[r.user_id]}
            onSeekTo={onSeekTo}
            onToggleLike={onToggleLike}
          />
        ))}
      </View>
      <View style={styles.rowRight}>
        <Pressable onPress={() => onToggleLike(comment.id)} hitSlop={6}>
          <HeartIcon size={20} color={comment.liked_by_me ? colors.like : colors.textMuted} filled={comment.liked_by_me} />
        </Pressable>
        <Text style={styles.rowLikeCount}>{comment.like_count > 0 ? comment.like_count : ''}</Text>
        <Pressable hitSlop={6} style={{ marginTop: 4 }}>
          <MoreIcon size={16} color={colors.textDim} />
        </Pressable>
      </View>
    </View>
  );
}

function ReplyRow({ comment, author, onSeekTo, onToggleLike }: { comment: SongComment; author?: UserProfile; onSeekTo: (ms: number) => void; onToggleLike: (id: string) => Promise<void> }) {
  const handle = displayHandle(author, comment.user_id);
  return (
    <View style={styles.replyRow}>
      <AvatarOrb seed={author?.avatar_seed || comment.user_id} size={28} />
      <View style={{ flex: 1, marginLeft: spacing.sm }}>
        <View style={styles.rowHeader}>
          <Text style={[styles.rowHandle, { fontSize: fonts.size.sm }]}>{handle}</Text>
          <Text style={styles.rowMeta}>{formatAge(comment.created_at)}</Text>
          {comment.timestamp_seconds != null ? (
            <Pressable onPress={() => onSeekTo(Math.floor(comment.timestamp_seconds! * 1000))} hitSlop={4}>
              <Text style={styles.stampPill}>at {formatStamp(comment.timestamp_seconds)}</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={[styles.rowText, { fontSize: fonts.size.sm }]}>{comment.body}</Text>
      </View>
      <View style={{ alignItems: 'center', paddingLeft: 4 }}>
        <Pressable onPress={() => onToggleLike(comment.id)} hitSlop={6}>
          <HeartIcon size={16} color={comment.liked_by_me ? colors.like : colors.textMuted} filled={comment.liked_by_me} />
        </Pressable>
        <Text style={[styles.rowLikeCount, { fontSize: 10 }]}>{comment.like_count > 0 ? comment.like_count : ''}</Text>
      </View>
    </View>
  );
}

// Procedural gradient avatar so v1 doesn't require uploads — same effect as
// the colorful orbs in the screenshot.
function AvatarOrb({ seed, size }: { seed: string; size: number }) {
  const c = avatarColor(seed);
  return (
    <LinearGradient
      colors={[c.from, c.to]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{ width: size, height: size, borderRadius: size / 2 }}
    />
  );
}

// ===== Styles =========================================================

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    height: '85%',
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.sm },
  title: { color: colors.text, fontSize: fonts.size.lg, fontWeight: fonts.weight.bold, textAlign: 'center', marginBottom: spacing.md },

  row: { flexDirection: 'row', paddingVertical: 10, alignItems: 'flex-start' },
  rowBody: { flex: 1, marginLeft: spacing.sm, minWidth: 0 },
  rowHeader: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  rowHandle: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.bold },
  rowMeta: { color: colors.textDim, fontSize: fonts.size.xs },
  stampPill: { color: colors.like, fontSize: fonts.size.xs, fontWeight: fonts.weight.semibold },
  rowText: { color: colors.text, fontSize: fonts.size.md, lineHeight: 21 },
  rowActions: { flexDirection: 'row', gap: spacing.md, marginTop: 6 },
  rowAction: { color: colors.textMuted, fontSize: fonts.size.xs, fontWeight: fonts.weight.semibold },
  rowActionDim: { color: colors.textDim, fontSize: fonts.size.xs },
  rowRight: { alignItems: 'center', paddingLeft: spacing.sm, paddingTop: 4 },
  rowLikeCount: { color: colors.textDim, fontSize: 11, marginTop: 2, minHeight: 14 },

  replyRow: { flexDirection: 'row', paddingTop: 8, paddingLeft: 0, alignItems: 'flex-start' },

  reactionStrip: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  reactionEmoji: { fontSize: 28 },

  replyBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.xs, paddingHorizontal: spacing.sm, backgroundColor: colors.surface, borderRadius: radii.sm, marginTop: spacing.xs },
  replyBannerText: { color: colors.textMuted, fontSize: fonts.size.xs, flex: 1, marginRight: spacing.sm },
  replyBannerCancel: { color: metals.goldSolidHi, fontSize: fonts.size.xs, fontWeight: fonts.weight.semibold },
  errorBanner: { paddingVertical: spacing.xs + 2, paddingHorizontal: spacing.sm, backgroundColor: 'rgba(255,45,85,0.14)', borderColor: 'rgba(255,45,85,0.40)', borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.sm, marginTop: spacing.xs },
  errorBannerText: { color: '#ff8a9b', fontSize: fonts.size.xs, fontWeight: fonts.weight.semibold, textAlign: 'center' },

  composer: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingTop: spacing.sm },
  composerAvatar: { width: 36, height: 36 },
  composerInputWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radii.pill, paddingHorizontal: spacing.md, paddingVertical: 8, gap: spacing.sm },
  composerInput: { flex: 1, color: colors.text, fontSize: fonts.size.md, maxHeight: 80, paddingVertical: 0 },
  composerGatedPlaceholder: { flex: 1, color: colors.textMuted, fontSize: fonts.size.md },
  stampToggle: { backgroundColor: metals.goldLo, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radii.pill },
  stampToggleOff: { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  stampToggleText: { color: metals.goldSolidHi, fontSize: 11, fontWeight: fonts.weight.bold, fontVariant: ['tabular-nums'] },
  stampToggleTextOff: { color: colors.textDim },
  sendBtn: { paddingHorizontal: spacing.md },
  sendBtnText: { color: metals.goldSolidHi, fontSize: fonts.size.md, fontWeight: fonts.weight.bold },

  emptyWrap: { paddingVertical: spacing.xxl, alignItems: 'center' },
  empty: { color: colors.textMuted, fontSize: fonts.size.sm },
});
