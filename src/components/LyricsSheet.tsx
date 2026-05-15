import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Share,
  ScrollView,
  Platform,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  interpolate,
  Extrapolation,
  SharedValue,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { colors, fonts, spacing } from '@/theme';
import { Song } from '@/types';

interface Props {
  song: Song | null;
  /** Current playback position in milliseconds. Throttled by parent — we
   *  re-derive the active line every 250ms instead of every render. */
  positionMs: number;
  /** Total song duration in milliseconds. */
  durationMs: number;
  /** 0 = closed, 1 = fully open. Driven by parent pan gesture. */
  progress: SharedValue<number>;
  /** Called when the user taps a lyric line to seek. */
  onSeek: (ms: number) => void;
}

// Strip section headers like [Verse 1], [Chorus], etc. — they're Sunor-side
// scaffolding, not lyrics the user wants to read.
const SECTION_HEADER = /^\s*\[.*\]\s*$/;

function splitLyricLines(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !SECTION_HEADER.test(l));
}

/**
 * Immersive lyrics overlay. Renders absolute-positioned over the player.
 * Performance shape:
 *   • Mounts lazily on the first open, then stays mounted (cheap).
 *   • Animation runs on the UI thread via Reanimated worklets.
 *   • Active-line index is JS state, updated at 4Hz via setInterval — far
 *     cheaper than re-deriving from a shared value on every frame.
 *   • Each line is a React.memo'd row that only re-renders when its
 *     active/past flags flip.
 *   • Pseudo-sync only — `songs.lyrics` is plain text without per-line
 *     timestamps yet. We distribute lines linearly across the song. Good
 *     enough for the look; replace with real timestamps when available.
 */
export const LyricsSheet = React.memo(function LyricsSheet({
  song,
  positionMs,
  durationMs,
  progress,
  onSeek,
}: Props) {
  const [mounted, setMounted] = useState(false);

  // Track sheet-open status in JS so the active-line interval only runs
  // when needed. We poll `progress.value` from the UI thread occasionally;
  // a one-shot mount + a JS-tracked open flag is cheap.
  const [openFlag, setOpenFlag] = useState(false);
  useEffect(() => {
    const id = setInterval(() => {
      const isOpen = progress.value > 0.05;
      if (isOpen && !mounted) setMounted(true);
      if (isOpen !== openFlag) setOpenFlag(isOpen);
    }, 200);
    return () => clearInterval(id);
  }, [progress, mounted, openFlag]);

  const lines = useMemo(() => splitLyricLines(song?.lyrics), [song?.lyrics]);

  // Active line — only ticks while the sheet is actually visible. No work
  // when the sheet is closed (the dominant state).
  const [activeIndex, setActiveIndex] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const lineLayouts = useRef<number[]>([]); // y-offset of each row
  useEffect(() => {
    if (!openFlag || lines.length === 0 || durationMs <= 0) return;
    const tick = () => {
      const ratio = Math.min(0.999, Math.max(0, positionMs / durationMs));
      const idx = Math.min(lines.length - 1, Math.floor(ratio * lines.length));
      setActiveIndex((prev) => (prev === idx ? prev : idx));
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [openFlag, lines.length, positionMs, durationMs]);

  // Keep the active line roughly centered. Smooth scroll, no animation
  // chain. Runs at most 4Hz because activeIndex changes that slowly.
  useEffect(() => {
    if (!openFlag) return;
    const y = lineLayouts.current[activeIndex];
    if (typeof y === 'number') {
      scrollRef.current?.scrollTo({ y: Math.max(0, y - 220), animated: true });
    }
  }, [activeIndex, openFlag]);

  // Reset scroll + active line whenever the song changes.
  useEffect(() => {
    setActiveIndex(0);
    lineLayouts.current = [];
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [song?.id]);

  // Sheet rise + fade. translateY 60→0 so the sheet feels like it lifts
  // up under the player, not slammed in. Opacity tracks progress directly.
  const sheetStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [
      {
        translateY: interpolate(
          progress.value,
          [0, 1],
          [80, 0],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));

  // Subtle background dim so the player artwork softens behind the lyrics
  // without going full-black (preserves the artist visual).
  const dimStyle = useAnimatedStyle(() => ({
    opacity: progress.value * 0.7,
  }));

  const handleLineTap = useCallback(
    (idx: number) => {
      if (lines.length === 0 || durationMs <= 0) return;
      const ms = Math.floor((idx / lines.length) * durationMs);
      if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
      onSeek(ms);
    },
    [lines.length, durationMs, onSeek],
  );

  const handleLineLongPress = useCallback(
    (line: string) => {
      if (Platform.OS !== 'web') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      }
      Share.share({
        message: `"${line}"\n${song?.artist_name ?? 'Boulevard'}, "${song?.title ?? ''}"`,
      }).catch(() => {});
    },
    [song],
  );

  // Block touches under the sheet only when it's actually open.
  // pointerEvents="none" while closed means swipe-down on player still
  // initiates the sheet, but no stray taps hit a lyric line that the
  // user can't see.
  const pointerMode = openFlag ? 'auto' : 'none';

  if (!song) return null;

  return (
    <>
      <Animated.View
        style={[StyleSheet.absoluteFill, styles.dim, dimStyle]}
        pointerEvents="none"
      />
      <Animated.View
        style={[styles.sheet, sheetStyle]}
        pointerEvents={pointerMode}
      >
        {mounted ? (
          lines.length > 0 ? (
            <ScrollView
              ref={scrollRef}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              // Keep scroll perf simple: no momentum tricks, no parallax.
              decelerationRate="normal"
              // Block the sheet's vertical pan from also closing the sheet —
              // the parent gesture handles that. ScrollView keeps its own
              // touch handling for in-list scroll.
              overScrollMode="never"
            >
              {lines.map((line, i) => (
                <LyricLine
                  key={i}
                  text={line}
                  active={i === activeIndex}
                  past={i < activeIndex}
                  onTap={() => handleLineTap(i)}
                  onLongPress={() => handleLineLongPress(line)}
                  onLayoutY={(y) => {
                    lineLayouts.current[i] = y;
                  }}
                />
              ))}
              <View style={styles.bottomSpacer} />
            </ScrollView>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Lyrics coming soon</Text>
              <Text style={styles.emptySub}>
                Boulevard transcribes lyrics after the song is approved.
              </Text>
            </View>
          )
        ) : null}
      </Animated.View>
    </>
  );
});

interface LineProps {
  text: string;
  active: boolean;
  past: boolean;
  onTap: () => void;
  onLongPress: () => void;
  onLayoutY: (y: number) => void;
}

const LyricLine = React.memo(
  function LyricLine({ text, active, past, onTap, onLongPress, onLayoutY }: LineProps) {
    return (
      <Pressable
        onPress={onTap}
        onLongPress={onLongPress}
        delayLongPress={420}
        onLayout={(e) => onLayoutY(e.nativeEvent.layout.y)}
        hitSlop={6}
        style={({ pressed }) => [styles.linePressable, pressed && styles.linePressed]}
      >
        <Text
          style={[styles.line, past && styles.linePast, active && styles.lineActive]}
        >
          {text}
        </Text>
      </Pressable>
    );
  },
  (prev, next) =>
    prev.text === next.text && prev.active === next.active && prev.past === next.past,
);

const styles = StyleSheet.create({
  dim: {
    backgroundColor: '#000',
  },
  sheet: {
    ...StyleSheet.absoluteFillObject,
    paddingHorizontal: 28,
    paddingTop: 96,
    backgroundColor: 'rgba(10,10,12,0.93)',
  },
  scrollContent: {
    paddingTop: 56,
    paddingBottom: 80,
  },
  linePressable: {
    paddingVertical: 6,
  },
  linePressed: {
    opacity: 0.55,
  },
  line: {
    fontSize: 24,
    lineHeight: 34,
    color: 'rgba(255,255,255,0.42)',
    fontWeight: fonts.weight.medium,
    letterSpacing: -0.2,
  },
  linePast: {
    color: 'rgba(255,255,255,0.2)',
  },
  lineActive: {
    fontSize: 28,
    lineHeight: 38,
    color: colors.text,
    fontWeight: fonts.weight.semibold,
    letterSpacing: -0.4,
  },
  bottomSpacer: {
    height: 200,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 120,
  },
  emptyTitle: {
    fontSize: fonts.size.xl,
    color: 'rgba(255,255,255,0.75)',
    fontWeight: fonts.weight.semibold,
    marginBottom: spacing.sm,
  },
  emptySub: {
    fontSize: fonts.size.md,
    color: 'rgba(255,255,255,0.45)',
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
});
