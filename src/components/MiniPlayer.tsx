import React, { useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  Platform,
  StyleSheet,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { colors, fonts, metals, spacing } from '@/theme';
import { usePlayer } from '@/contexts/PlayerContext';
import { PlayIcon, PauseIcon, SkipIcon, PrevIcon } from '@/components/Icon';
import { Artwork } from '@/components/Artwork';
import { songArtworkUri } from '@/lib/artwork';

interface Props {
  /** Tapping the mini player opens the full now-playing surface — RootNavigator handles that. */
  onPress: () => void;
  /** Bottom offset — pushed up above the BottomNav. */
  bottomOffset: number;
}

// Persistent "now playing" bar — Spotify-style. Renders only when there is a
// current song. Sits directly above the BottomNav on every tab except Home
// (where the full player is already the entire screen).

export function MiniPlayer({ onPress, bottomOffset }: Props) {
  const player = usePlayer();
  const song = player.current;

  // Small synchronous tap haptic. Fires on press-in so the buzz lands the
  // instant the finger touches — matches the player feed behaviour.
  const tapFeedback = useCallback(() => {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
  }, []);

  if (!song) return null;

  const progress =
    player.duration > 0 ? Math.min(1, player.position / player.duration) : 0;

  return (
    <View style={[styles.wrap, { bottom: bottomOffset }]} pointerEvents="box-none">
      <Pressable onPress={onPress} style={styles.bar}>
        <BlurView tint="dark" intensity={45} style={StyleSheet.absoluteFill} />
        <View style={styles.tint} />
        <LinearGradient
          colors={[metals.glassHi, 'transparent']}
          locations={[0, 0.45]}
          style={styles.gloss}
          pointerEvents="none"
        />

        <Artwork
          uri={songArtworkUri(song)}
          name={song.title}
          size={44}
          radius={8}
          recyclingKey={song.id}
          style={styles.cover}
        />

        {/* Title + artist text is non-interactive: taps fall through to the
            bar Pressable, which opens the full player. The mini player must
            never navigate to an artist page. */}
        <View style={styles.meta}>
          <Text style={styles.title} numberOfLines={1}>{song.title}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {capitalize(song.genre)} · {song.artist_name ?? 'Boulevard'}
          </Text>
        </View>

        <Pressable
          hitSlop={10}
          onPressIn={tapFeedback}
          onPress={(e) => { e.stopPropagation(); player.previous(); }}
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
          accessibilityLabel="Previous"
        >
          <PrevIcon size={20} color={colors.text} />
        </Pressable>
        <Pressable
          hitSlop={10}
          onPressIn={tapFeedback}
          onPress={(e) => { e.stopPropagation(); player.togglePlay(); }}
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
          accessibilityLabel={player.isPlaying ? 'Pause' : 'Play'}
        >
          {player.isPlaying
            ? <PauseIcon size={22} color={colors.text} />
            : <PlayIcon size={22} color={colors.text} />}
        </Pressable>
        <Pressable
          hitSlop={10}
          onPressIn={tapFeedback}
          onPress={(e) => { e.stopPropagation(); player.skip(); }}
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
          accessibilityLabel="Next"
        >
          <SkipIcon size={22} color={colors.text} />
        </Pressable>

        {/* Thin progress bar pinned to the bottom edge of the bar. */}
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
        </View>
      </Pressable>
    </View>
  );
}

const LABELS: Record<string, string> = {
  rnb: 'R&B',
  edm: 'EDM',
  hiphop: 'Hip-Hop',
  lofi: 'Lo-Fi',
};
function capitalize(s: string) {
  if (!s) return s;
  if (LABELS[s]) return LABELS[s];
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: spacing.sm,
    right: spacing.sm,
  },
  bar: {
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingRight: spacing.md,
    gap: spacing.md,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
    backgroundColor: 'rgba(20,20,24,0.55)',
    // Lifted off the nav for visual depth.
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  tint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(20,20,24,0.45)',
  },
  gloss: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: '40%',
  },

  cover: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  meta: { flex: 1, minWidth: 0 },
  title: {
    color: colors.text,
    fontSize: fonts.size.sm,
    fontWeight: fonts.weight.semibold,
    letterSpacing: 0.1,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: fonts.size.xs,
    marginTop: 1,
  },

  btn: {
    width: 32,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPressed: {
    opacity: 0.55,
    transform: [{ scale: 0.88 }],
  },

  progressTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.text,
  },
});
