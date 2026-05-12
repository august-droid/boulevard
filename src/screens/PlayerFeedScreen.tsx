import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Share,
  StyleSheet,
  Dimensions,
  Platform,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  GestureHandlerRootView,
  GestureDetector,
  Gesture,
} from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { usePlayer } from '@/contexts/PlayerContext';
import { PlatinumProgressBar } from '@/components/PlatinumProgressBar';
import {
  PlayIcon,
  PauseIcon,
  SkipIcon,
  PrevIcon,
  ShareIcon,
  BookmarkIcon,
  SparkleIcon,
  ShuffleIcon,
  ChevronDownIcon,
  MoreIcon,
} from '@/components/Icon';
import { CreateVibeSheet } from '@/screens/CreateVibeSheet';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// "Now playing" full-bleed view.
//
// Cover art fills the screen. A long bottom gradient fades into pure black so
// the controls sit on a clean dark surface and the bottom nav (which is
// rendered above this screen) reads as part of the same composition.

export function PlayerFeedScreen() {
  const player = usePlayer();
  const insets = useSafeAreaInsets();
  const [vibeOpen, setVibeOpen] = useState(false);

  const skip = useCallback(() => {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    player.skip();
  }, [player]);

  // Small synchronous tap feedback used on every transport button. Fires the
  // haptic on press-in (not on press-up) so the buzz lands the instant the
  // user's finger touches the screen — same trick Spotify uses.
  const tapFeedback = useCallback(() => {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
  }, []);

  const onShare = useCallback(async () => {
    const s = player.current;
    if (!s) return;
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    try {
      const result = await Share.share(
        {
          // The URL is the most important piece — both iOS and Android pass it
          // through to social apps so they can render link previews. The
          // message is what shows up if the target only accepts plain text.
          message: `Listening to "${s.title}" on Boulevard`,
          url: s.audio_url,
          title: s.title,
        },
        { dialogTitle: 'Share song', subject: `Boulevard — ${s.title}` },
      );
      // Only treat as a real share when the sheet didn't bounce back as
      // dismissed — otherwise we'd reward the cancel button.
      if (result.action === Share.sharedAction) {
        await player.recordShare();
      }
    } catch {
      // Native sheet failed (unavailable, no targets) — silently ignore.
    }
  }, [player]);

  // Swipe up on the cover advances to the next song. The transport row sits
  // outside this detector so taps on the controls always win.
  const pan = Gesture.Pan().onEnd((e) => {
    if (e.translationY < -80 || (e.translationX < -80 && Math.abs(e.translationY) < 60)) {
      runOnJS(skip)();
    }
  });

  const song = player.current;

  return (
    <GestureHandlerRootView style={styles.root}>
      <View style={styles.coverWrap}>
        {song ? (
          <>
            <Image
              source={{ uri: song.cover_url }}
              style={styles.cover}
              contentFit="cover"
              cachePolicy="memory-disk"
              // 220ms crossfade between covers so the swap reads smoothly.
              transition={220}
              recyclingKey={song.id}
            />
            {/* Hairline glass reflection on the very top. */}
            <LinearGradient
              colors={[metals.glassHi, 'transparent']}
              locations={[0, 0.18]}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <LinearGradient
              colors={[
                'rgba(10,10,12,0)',
                'rgba(10,10,12,0.25)',
                'rgba(10,10,12,0.70)',
                'rgba(10,10,12,0.92)',
                '#0a0a0c',
              ]}
              locations={[0.30, 0.45, 0.62, 0.82, 1]}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            {/* Dedicated heavier scrim under the controls zone — sits on top
                of the wide gradient and ensures buttons + waveform always
                read cleanly regardless of how busy the cover art is. */}
            <LinearGradient
              colors={['transparent', 'rgba(10,10,12,0.55)', 'rgba(10,10,12,0.92)']}
              locations={[0, 0.4, 1]}
              style={styles.controlsScrim}
              pointerEvents="none"
            />
            <GestureDetector gesture={pan}>
              {/* Capture swipes everywhere above the controls. */}
              <View style={styles.swipeZone} />
            </GestureDetector>
          </>
        ) : (
          <View style={[styles.cover, { backgroundColor: colors.surface }]} />
        )}
      </View>

      {/* Top bar — chevron, breathing brand logo, overflow menu. */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable hitSlop={12} onPress={() => {}} style={styles.iconBtn}>
          <ChevronDownIcon size={22} color={colors.text} />
        </Pressable>
        <BreathingBrandMark />
        <Pressable hitSlop={12} onPress={() => setVibeOpen(true)} style={styles.iconBtn}>
          <MoreIcon size={20} color={colors.text} />
        </Pressable>
      </View>

      {/* Bottom content stack. */}
      <View
        style={[
          styles.bottomStack,
          // Reserve room for the BottomNav (rendered by RootNavigator).
          { paddingBottom: insets.bottom + 96 },
        ]}
      >
        <View style={styles.titleBlock}>
          <Text style={styles.title} numberOfLines={1}>
            {song?.title ?? '—'}
          </Text>
          <View style={styles.brandPill}>
            <SparkleIcon size={11} color={metals.goldHi} />
            <Text style={styles.brandPillText}>Boulevard Original</Text>
          </View>
        </View>

        {/* Single transport row — Share / Shuffle / Prev / Play / Skip / Save.
            All controls on one horizontal axis. Share + Save are plain icons
            matching the others' visual weight so the row reads as a unified
            control surface rather than two stacked groups. */}
        <View style={styles.transport}>
          <Pressable
            hitSlop={14}
            onPressIn={tapFeedback}
            onPress={onShare}
            style={({ pressed }) => pressed ? styles.transportPressed : undefined}
            accessibilityLabel="Share"
          >
            <ShareIcon size={22} color={colors.text} />
          </Pressable>
          <Pressable
            hitSlop={12}
            onPressIn={tapFeedback}
            onPress={() => player.toggleShuffle()}
            style={({ pressed }) => pressed ? styles.transportPressed : undefined}
            accessibilityLabel="Shuffle"
          >
            <ShuffleIcon
              size={22}
              color={player.isShuffling ? metals.goldSolidHi : colors.textMuted}
            />
          </Pressable>
          <Pressable
            hitSlop={14}
            onPressIn={tapFeedback}
            onPress={() => player.previous()}
            style={({ pressed }) => pressed ? styles.transportPressed : undefined}
          >
            <PrevIcon size={30} color={colors.text} />
          </Pressable>
          <Pressable
            hitSlop={14}
            onPressIn={tapFeedback}
            onPress={() => player.togglePlay()}
            style={({ pressed }) => [styles.playBtn, pressed && styles.playBtnPressed]}
            accessibilityRole="button"
            accessibilityLabel={player.isPlaying ? 'Pause' : 'Play'}
          >
            <View style={styles.playInner}>
              {player.isPlaying
                ? <PauseIcon size={26} color={colors.text} />
                : <PlayIcon size={26} color={colors.text} />}
            </View>
          </Pressable>
          <Pressable
            hitSlop={14}
            onPressIn={tapFeedback}
            onPress={skip}
            style={({ pressed }) => pressed ? styles.transportPressed : undefined}
          >
            <SkipIcon size={30} color={colors.text} />
          </Pressable>
          <Pressable
            hitSlop={14}
            onPressIn={tapFeedback}
            onPress={() => player.save()}
            style={({ pressed }) => pressed ? styles.transportPressed : undefined}
            accessibilityLabel={player.saved ? 'Unsave' : 'Save'}
          >
            <BookmarkIcon
              size={22}
              color={player.saved ? metals.goldSolidHi : colors.text}
              filled={player.saved}
            />
          </Pressable>
        </View>

        {/* Platinum→gold progress bar — sits between the transport row and
            the bottom nav. Tap or drag to seek. Total duration label sits
            against the right edge so the user always knows the song's length. */}
        <View style={styles.progressBarWrap}>
          <PlatinumProgressBar
            position={player.position}
            duration={player.duration}
            onSeek={(ms) => player.seek(ms)}
          />
          <View style={styles.progressMetaRow}>
            <Text style={styles.progressMetaText}>{formatTime(player.duration)}</Text>
          </View>
        </View>
      </View>

      <CreateVibeSheet visible={vibeOpen} onClose={() => setVibeOpen(false)} />
    </GestureHandlerRootView>
  );
}

// ---- helpers ---------------------------------------------------------

function formatTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

// ---- Breathing brand mark -------------------------------------------
//
// Subtle "boulevard" wordmark at the top of the now-playing surface. Loops
// a slow opacity pulse so the screen feels alive even when the cover is
// motionless. Deliberately quiet — the cover art is the hero; this is just
// a soft signature.

function BreathingBrandMark() {
  const opacity = useSharedValue(0.62);

  useEffect(() => {
    // ~3.6s out, ~3.6s back, forever. inOut easing makes the turnaround
    // feel like breath rather than a bounce.
    opacity.value = withRepeat(
      withTiming(0.92, { duration: 3600, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.Text style={[styles.brandWordmark, style]} allowFontScaling={false}>
      boulevard
    </Animated.Text>
  );
}

// ---- helpers ---------------------------------------------------------


// ---- styles ----------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  coverWrap: {
    ...StyleSheet.absoluteFillObject,
  },
  cover: {
    ...StyleSheet.absoluteFillObject,
    width: SCREEN_W,
    height: SCREEN_H,
  },

  swipeZone: {
    // Top ~60% of the screen — leaves the controls untouched.
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: SCREEN_H * 0.6,
  },

  // Strong dark wash that sits behind the title block + waveform + transport.
  // Independent from the wide-screen gradient so the fall-off matches the
  // bottom-stack content area exactly.
  controlsScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: SCREEN_H * 0.45,
  },

  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandWordmark: {
    color: metals.goldSolid,
    fontSize: 13,
    fontWeight: fonts.weight.medium,
    letterSpacing: 5.5,
    textTransform: 'lowercase',
  },

  bottomStack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
  },

  titleBlock: {
    marginBottom: spacing.lg,
  },
  title: {
    color: colors.text,
    fontSize: 34,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.5,
  },
  brandPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(20,20,24,0.72)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
  },
  brandPillText: {
    color: colors.text,
    fontSize: fonts.size.xs,
    fontWeight: fonts.weight.semibold,
    letterSpacing: 0.3,
  },

  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    marginTop: spacing.lg,
  },
  progressBarWrap: {
    marginTop: spacing.md,
    paddingHorizontal: 4,
  },
  progressMetaRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: -8,
  },
  progressMetaText: {
    color: colors.textMuted,
    fontSize: fonts.size.xs,
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.2,
  },
  playBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    overflow: 'hidden',
    backgroundColor: 'rgba(20,20,24,0.92)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
    alignItems: 'center',
    justifyContent: 'center',
    // Soft outer shadow for depth.
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  playInner: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Pressed-state visuals: shared by skip / prev / shuffle. The play button
  // gets its own treatment (below) so the shadow scales too.
  transportPressed: {
    opacity: 0.55,
    transform: [{ scale: 0.88 }],
  },
  playBtnPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.92 }],
  },
});
