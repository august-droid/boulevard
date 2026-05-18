import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { useAuth } from '@/contexts/AuthContext';
import { usePlayer } from '@/contexts/PlayerContext';
import { fetchPendingSongs, reviewSong, viralStartSeconds, PendingSong } from '@/lib/admin/adminClient';
import {
  CloseIcon,
  PlayIcon,
  PauseIcon,
  CheckIcon,
  SparkleIcon,
} from '@/components/Icon';

interface Props {
  visible: boolean;
  onClose: () => void;
}

// In-app review queue. Lets an admin user approve / reject / regenerate
// freshly-generated songs without leaving their phone. Backed by the
// `review_song` SQL RPC which writes both the songs row AND the matching
// songs_queue row atomically.

export function ReviewScreen({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const auth = useAuth();
  const player = usePlayer();
  const [pending, setPending] = useState<PendingSong[]>([]);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!auth.userId) return;
    setLoading(true);
    try {
      const rows = await fetchPendingSongs(50);
      setPending(rows);
    } finally {
      setLoading(false);
    }
  }, [auth.userId]);

  useEffect(() => {
    if (visible) refresh();
  }, [visible, refresh]);

  const handle = useCallback(async (song: PendingSong, action: 'approve' | 'reject' | 'regenerate', rating?: number) => {
    if (!auth.userId) return;
    setActing(song.id);
    const result = await reviewSong({ userId: auth.userId, songId: song.id, action, rating });
    setActing(null);
    if (!result.ok) {
      Alert.alert('Review failed', result.error ?? 'unknown error');
      return;
    }
    // Remove the row optimistically — it's no longer pending in any case.
    setPending((p) => p.filter((s) => s.id !== song.id));
  }, [auth.userId]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: insets.top + spacing.md }]}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>HUMAN REVIEW</Text>
            <Text style={styles.title}>{pending.length} awaiting</Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable onPress={refresh} hitSlop={10} style={styles.refreshBtn}>
              <Text style={styles.refreshText}>Refresh</Text>
            </Pressable>
            <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn}>
              <CloseIcon size={22} color={colors.textMuted} />
            </Pressable>
          </View>
        </View>

        {loading && pending.length === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.text} />
          </View>
        ) : pending.length === 0 ? (
          <View style={styles.center}>
            <SparkleIcon size={28} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>Queue is empty</Text>
            <Text style={styles.emptyBody}>
              Newly generated songs from the Music Factory will show up here.
              Pull the dashboard up on the desktop or run the worker to start
              filling this list.
            </Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }}
            showsVerticalScrollIndicator={false}
          >
            {pending.map((song) => {
              // Reviewers approve on the hook, not the intro — start every
              // song at its most viral moment for a faster verdict.
              const viralStart = viralStartSeconds(song);
              return (
                <ReviewCard
                  key={song.id}
                  song={song}
                  viralStartSec={viralStart}
                  isCurrent={player.current?.id === song.id}
                  isPlaying={player.current?.id === song.id && player.isPlaying}
                  busy={acting === song.id}
                  onPlay={() =>
                    player.playSpecific(song, { startPositionMillis: viralStart * 1000 })
                  }
                  onPause={() => player.togglePlay()}
                  onApprove={(rating) => handle(song, 'approve', rating)}
                  onReject={() => handle(song, 'reject')}
                  onRegenerate={() => handle(song, 'regenerate')}
                />
              );
            })}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

// ---- Per-song card ----

interface CardProps {
  song: PendingSong;
  /** Seconds into the song playback jumps to (its most viral moment). */
  viralStartSec: number;
  isCurrent: boolean;
  isPlaying: boolean;
  busy: boolean;
  onPlay: () => void;
  onPause: () => void;
  onApprove: (rating?: number) => void;
  onReject: () => void;
  onRegenerate: () => void;
}

/** Seconds → m:ss. */
function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function ReviewCard({ song, viralStartSec, isCurrent, isPlaying, busy, onPlay, onPause, onApprove, onReject, onRegenerate }: CardProps) {
  const [rating, setRating] = useState<number | null>(null);

  const dim = (n: number | null | undefined) =>
    n == null ? '–' : `${Math.round(n * 100)}`;

  return (
    <View style={styles.card}>
      <View style={styles.cardRow}>
        <Pressable
          onPress={isPlaying ? onPause : onPlay}
          style={styles.cover}
          accessibilityLabel={isPlaying ? 'Pause' : 'Play'}
        >
          <Image
            source={{ uri: song.cover_url }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            cachePolicy="memory-disk"
            recyclingKey={song.id}
          />
          <View style={styles.coverScrim}>
            {isPlaying ? (
              <PauseIcon size={26} color={colors.text} />
            ) : (
              <PlayIcon size={26} color={colors.text} />
            )}
          </View>
        </Pressable>

        <View style={styles.meta}>
          <Text style={styles.songTitle} numberOfLines={1}>{song.title}</Text>
          <Text style={styles.songSub} numberOfLines={1}>
            {song.subgenre || song.genre} · {song.mood ?? '–'} · {song.bpm ?? '–'} BPM
          </Text>
          {viralStartSec > 0 && (
            <View style={styles.hookPill}>
              <Text style={styles.hookPillText}>
                ▶ Starts at hook · {fmtTime(viralStartSec)}
              </Text>
            </View>
          )}
          {song.suno_prompt ? (
            <Text style={styles.songPrompt} numberOfLines={2}>
              {song.suno_prompt}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Quality breakdown — at-a-glance signal of what the auto-filter saw */}
      <View style={styles.qualityRow}>
        <Quality label="Intro"   value={dim(song.intro_strength)} />
        <Quality label="Hook"    value={dim(song.hook_quality)} />
        <Quality label="Vocal"   value={dim(song.vocal_quality)} />
        <Quality label="Mix"     value={dim(song.production_quality)} />
        <Quality label="Replay"  value={dim(song.replayability_score)} />
      </View>

      {/* Rating row */}
      <View style={styles.ratingRow}>
        <Text style={styles.ratingLabel}>Rate</Text>
        <View style={styles.ratingPills}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
            <Pressable
              key={n}
              onPress={() => setRating((r) => (r === n ? null : n))}
              style={[styles.ratingPill, rating === n && styles.ratingPillActive]}
            >
              <Text style={[styles.ratingPillText, rating === n && styles.ratingPillTextActive]}>
                {n}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Action row */}
      <View style={styles.actionRow}>
        <Pressable
          onPress={onReject}
          disabled={busy}
          style={[styles.actionBtn, styles.rejectBtn]}
        >
          <Text style={styles.rejectText}>Reject</Text>
        </Pressable>
        <Pressable
          onPress={onRegenerate}
          disabled={busy}
          style={[styles.actionBtn, styles.regenBtn]}
        >
          <Text style={styles.regenText}>Regen</Text>
        </Pressable>
        <Pressable
          onPress={() => onApprove(rating ?? undefined)}
          disabled={busy}
          style={[styles.actionBtn, styles.approveBtn]}
        >
          <CheckIcon size={16} color={colors.bg} />
          <Text style={styles.approveText}>{busy ? 'Saving…' : 'Approve'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Quality({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.quality}>
      <Text style={styles.qualityValue}>{value}</Text>
      <Text style={styles.qualityLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.lg },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginBottom: spacing.lg,
  },
  eyebrow: {
    color: colors.textMuted,
    fontSize: 11,
    letterSpacing: 2.4,
    fontWeight: fonts.weight.semibold,
  },
  title: {
    color: colors.text,
    fontSize: fonts.size.display,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.5,
    marginTop: 4,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  refreshBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
  },
  refreshText: { color: colors.text, fontSize: fonts.size.sm, fontWeight: fonts.weight.semibold },
  closeBtn: {
    width: 36, height: 36,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: 18, backgroundColor: colors.surface,
  },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg, gap: spacing.md },
  emptyTitle: { color: colors.text, fontSize: fonts.size.lg, fontWeight: fonts.weight.semibold },
  emptyBody: { color: colors.textMuted, fontSize: fonts.size.sm, textAlign: 'center', maxWidth: 320, lineHeight: 20 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
  },
  cardRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  cover: {
    width: 72, height: 72, borderRadius: radii.md, overflow: 'hidden',
    backgroundColor: colors.bgElevated,
    borderWidth: StyleSheet.hairlineWidth, borderColor: metals.platinum,
  },
  coverScrim: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  meta: { flex: 1, minWidth: 0 },
  songTitle: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.bold, letterSpacing: -0.2 },
  songSub: { color: colors.textMuted, fontSize: fonts.size.sm, marginTop: 2, textTransform: 'capitalize' },
  songPrompt: { color: colors.textDim, fontSize: fonts.size.xs, marginTop: 6, lineHeight: 16 },
  hookPill: {
    alignSelf: 'flex-start',
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(200,174,122,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
  },
  hookPillText: {
    color: metals.goldSolidHi,
    fontSize: 10,
    fontWeight: fonts.weight.semibold,
    letterSpacing: 0.3,
  },

  qualityRow: { flexDirection: 'row', marginTop: spacing.md, justifyContent: 'space-between' },
  quality: { alignItems: 'center', flex: 1 },
  qualityValue: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.bold, fontVariant: ['tabular-nums'] },
  qualityLabel: { color: colors.textDim, fontSize: 10, marginTop: 2, letterSpacing: 0.4, textTransform: 'uppercase' },

  ratingRow: { marginTop: spacing.md },
  ratingLabel: { color: colors.textMuted, fontSize: fonts.size.xs, letterSpacing: 0.5, textTransform: 'uppercase' },
  ratingPills: { flexDirection: 'row', marginTop: 6, gap: 4 },
  ratingPill: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: radii.sm,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
  },
  ratingPillActive: {
    backgroundColor: metals.gold,
  },
  ratingPillText: { color: colors.textMuted, fontSize: 12, fontWeight: fonts.weight.semibold },
  ratingPillTextActive: { color: colors.bg },

  actionRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  actionBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  rejectBtn: { backgroundColor: 'rgba(239,68,68,0.10)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(239,68,68,0.45)' },
  rejectText: { color: '#ef6868', fontWeight: fonts.weight.bold, fontSize: fonts.size.sm },
  regenBtn: { backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: StyleSheet.hairlineWidth, borderColor: metals.platinum },
  regenText: { color: colors.text, fontWeight: fonts.weight.bold, fontSize: fonts.size.sm },
  approveBtn: { backgroundColor: '#c8ae7a' },
  approveText: { color: colors.bg, fontWeight: fonts.weight.bold, fontSize: fonts.size.sm },
});
