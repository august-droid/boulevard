import React, { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { usePlayer, usePlayerProgress } from '@/contexts/PlayerContext';
import { useAppNav } from '@/contexts/NavigationContext';
import { useAuth } from '@/contexts/AuthContext';
import { PlayIcon, PauseIcon, SkipIcon, PrevIcon, ShuffleIcon, HeartIcon } from '@/components/Icon';
import { Artwork } from '@/components/Artwork';
import { ScrollingTitle } from '@/components/ScrollingTitle';
import { PlatinumProgressBar } from '@/components/PlatinumProgressBar';
import { songArtworkUri } from '@/lib/artwork';

// Desktop-only persistent player bar — Spotify-style. Rendered exclusively by
// DesktopShell (web >=1024px). It does not own any audio; it is a thin view
// over PlayerContext, so playback + queue are unaffected by it mounting.
//
//   Left   — artwork + title + artist. Pressing it opens the full player.
//            (It never navigates to the artist page — no hijack.)
//   Center — previous / play-pause / next, plus a seekable progress bar.
//   Right  — shuffle + like.

interface Props {
  onOpenPlayer: () => void;
}

function formatTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

export function DesktopPlayerBar({ onOpenPlayer }: Props) {
  const player = usePlayer();
  const nav = useAppNav();
  const auth = useAuth();
  const { position, duration } = usePlayerProgress();
  const song = player.current;

  const onSeek = useCallback((ms: number) => { void player.seek(ms); }, [player]);

  // Like is an engagement-write — anonymous listeners get bounced to the
  // SignupSheet instead, matching the gate on every other social action.
  const onToggleLike = useCallback(() => {
    if (auth.isAnonymous) { nav.openSignup('like'); return; }
    void player.like();
  }, [auth.isAnonymous, nav, player]);

  // The artist name navigates to the artist page — never the full player.
  // Falls back to the full player only when the track has no artist id.
  const onArtistPress = useCallback(() => {
    const cur = player.current;
    if (cur?.artist_id) nav.openArtistProfile(cur.artist_id);
    else onOpenPlayer();
  }, [player, nav, onOpenPlayer]);

  // Always-visible only when a song is staged/active.
  if (!song) return null;

  return (
    <View style={styles.bar}>
      {/* Left — now-playing. Artwork + title open the full player; the
          artist name navigates to the artist page. Separate Pressables, so
          clicking the artist never opens the player. */}
      <View style={styles.left}>
        <Pressable onPress={onOpenPlayer} accessibilityLabel="Open full player">
          <Artwork
            uri={songArtworkUri(song)}
            name={song.title}
            size={56}
            radius={8}
            recyclingKey={song.id}
            style={styles.cover}
          />
        </Pressable>
        <View style={styles.meta}>
          <Pressable
            onPress={onOpenPlayer}
            style={({ pressed }) => (pressed ? styles.metaPressed : undefined)}
            accessibilityLabel="Open full player"
          >
            <ScrollingTitle text={song.title} style={styles.title} />
          </Pressable>
          <Pressable
            onPress={onArtistPress}
            style={({ pressed }) => (pressed ? styles.metaPressed : undefined)}
            accessibilityLabel={song.artist_id ? 'Open artist' : undefined}
          >
            <Text style={styles.artist} numberOfLines={1}>
              {song.artist_name ?? 'Boulevard'}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Center — transport + progress. */}
      <View style={styles.center}>
        <View style={styles.transport}>
          <Pressable
            hitSlop={10}
            onPress={() => player.previous()}
            style={({ pressed }) => pressed && styles.pressed}
            accessibilityLabel="Previous"
          >
            <PrevIcon size={22} color={colors.text} />
          </Pressable>
          <Pressable
            hitSlop={10}
            onPress={() => player.togglePlay()}
            style={({ pressed }) => [styles.playBtn, pressed && styles.playBtnPressed]}
            accessibilityRole="button"
            accessibilityLabel={player.isPlaying ? 'Pause' : 'Play'}
          >
            {player.isPlaying
              ? <PauseIcon size={20} color={colors.bg} />
              : <PlayIcon size={20} color={colors.bg} />}
          </Pressable>
          <Pressable
            hitSlop={10}
            onPress={() => player.skip()}
            style={({ pressed }) => pressed && styles.pressed}
            accessibilityLabel="Next"
          >
            <SkipIcon size={22} color={colors.text} />
          </Pressable>
        </View>
        <View style={styles.progressRow}>
          <Text style={styles.time}>{formatTime(position)}</Text>
          <View style={styles.progressFlex}>
            <PlatinumProgressBar position={position} duration={duration} onSeek={onSeek} />
          </View>
          <Text style={styles.time}>{formatTime(duration)}</Text>
        </View>
      </View>

      {/* Right — shuffle + like. */}
      <View style={styles.right}>
        <Pressable
          hitSlop={10}
          onPress={() => player.toggleShuffle()}
          style={({ pressed }) => pressed && styles.pressed}
          accessibilityLabel="Shuffle"
          accessibilityState={{ selected: player.isShuffling }}
        >
          <ShuffleIcon size={20} color={player.isShuffling ? metals.goldSolidHi : colors.textMuted} />
        </Pressable>
        <Pressable
          hitSlop={10}
          onPress={onToggleLike}
          style={({ pressed }) => pressed && styles.pressed}
          accessibilityLabel={player.liked ? 'Unlike' : 'Like'}
        >
          <HeartIcon size={20} color={player.liked ? colors.like : colors.textMuted} filled={player.liked} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: 88,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    gap: spacing.lg,
    backgroundColor: '#0c0c0f',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: metals.platinum,
  },

  // Left
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    width: 300,
  },
  cover: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  meta: { flex: 1, minWidth: 0 },
  metaPressed: { opacity: 0.6 },
  title: {
    color: colors.text,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.semibold,
    letterSpacing: 0.1,
  },
  artist: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    marginTop: 2,
  },

  // Center
  center: {
    flex: 1,
    alignItems: 'center',
    gap: 8,
    maxWidth: 620,
    alignSelf: 'center',
  },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
  },
  playBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtnPressed: {
    transform: [{ scale: 0.92 }],
    opacity: 0.9,
  },
  pressed: { opacity: 0.55 },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    width: '100%',
  },
  progressFlex: { flex: 1 },
  time: {
    color: colors.textDim,
    fontSize: fonts.size.xs,
    fontVariant: ['tabular-nums'],
    width: 38,
    textAlign: 'center',
  },

  // Right
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.lg,
    width: 300,
  },
});
