import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { usePlayer } from '@/contexts/PlayerContext';
import { MOODS, Mood, buildMoodPlaylist } from '@/lib/mood/MoodPlaylist';
import { CloseIcon } from '@/components/Icon';

// First-launch greeter. Opens once on cold start, prompts the user to
// pick a mood so we can start them with a song that matches.
//
// Dismissible: top-right X and a "Skip for now" link at the bottom both
// hide the sheet for good. After dismissal we never show it again — we
// don't want this to become friction on every cold start.
//
// Storage key: boulevard.mood_picker_shown. Resetting it shows the sheet
// again (useful for testing).

const STORAGE_KEY = 'boulevard.mood_picker_shown';

export function MoodPickerSheet() {
  const player = usePlayer();
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);
  // One-shot guard: a fast double-tap on a mood tile must only ever start
  // one playlist. Two playPlaylist() calls racing each other is what made
  // the player briefly start two songs at once.
  const pickedRef = useRef(false);

  // Check the dismissal flag once on mount. Don't show until the player
  // catalog has loaded — otherwise tapping a mood produces an empty
  // playlist.
  useEffect(() => {
    (async () => {
      try {
        const shown = await AsyncStorage.getItem(STORAGE_KEY);
        if (!shown) setVisible(true);
      } catch {
        // best-effort — if storage fails, default to not showing so we
        // don't loop the modal on every launch.
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const dismiss = async (markShown = true) => {
    setVisible(false);
    if (markShown) {
      try { await AsyncStorage.setItem(STORAGE_KEY, '1'); } catch { /* best-effort */ }
    }
  };

  const onPick = async (mood: Mood) => {
    // Ignore every tap after the first — guards against a double-tap (or the
    // web touch+click pair) firing two playlists into the player at once.
    if (pickedRef.current) return;
    pickedRef.current = true;
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    const list = buildMoodPlaylist(mood, player.catalog, player.taste, 20);
    if (list.length > 0) await player.playPlaylist(list);
    void dismiss(true);
  };

  // Hold the sheet back until the catalog has actually loaded — tapping a
  // mood against an empty catalog builds an empty playlist and silently
  // plays nothing, stranding the user on a dismissed sheet with no music.
  if (!ready || !visible || player.catalog.length === 0) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => dismiss(true)}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <LinearGradient
            colors={['rgba(200,174,122,0.12)', 'rgba(10,10,12,0)']}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          <Pressable
            onPress={() => dismiss(true)}
            style={styles.closeBtn}
            hitSlop={12}
            accessibilityLabel="Close"
          >
            <CloseIcon size={20} color={colors.textDim} />
          </Pressable>

          <Text style={styles.eyebrow}>WELCOME TO BOULEVARD</Text>
          <Text style={styles.title}>What's your mood?</Text>
          <Text style={styles.subtitle}>
            Pick one and we'll start you with songs that match. You can change it any time on Explore.
          </Text>

          <View style={styles.grid}>
            {MOODS.map((m) => (
              <Pressable
                key={m.id}
                onPress={() => onPick(m)}
                style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
                accessibilityLabel={`${m.label} mood: ${m.description}`}
              >
                <Text style={styles.tileEmoji}>{m.emoji}</Text>
                <Text style={styles.tileLabel}>{m.label}</Text>
              </Pressable>
            ))}
          </View>

          <Pressable
            onPress={() => dismiss(true)}
            style={({ pressed }) => [styles.skipBtn, pressed && { opacity: 0.6 }]}
            hitSlop={12}
          >
            <Text style={styles.skipText}>Skip for now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.78)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: radii.xl,
    backgroundColor: colors.bgElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl + 4,
    paddingBottom: spacing.lg,
    overflow: 'hidden',
  },
  closeBtn: {
    position: 'absolute',
    top: spacing.md,
    right: spacing.md,
    zIndex: 2,
  },
  eyebrow: {
    color: metals.goldSolid,
    fontSize: 10,
    fontWeight: fonts.weight.bold,
    letterSpacing: 2.4,
    textAlign: 'center',
    marginBottom: 10,
  },
  title: {
    color: colors.text,
    fontSize: 26,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.4,
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },
  // 2-column grid — 4 rows × 2 cols for 8 moods.
  tile: {
    width: '48%',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
    alignItems: 'center',
  },
  tilePressed: {
    backgroundColor: colors.surfaceHover,
    borderColor: metals.goldHi,
    transform: [{ scale: 0.97 }],
  },
  tileEmoji: { fontSize: 30, marginBottom: 6 },
  tileLabel: {
    color: colors.text,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.1,
  },
  skipBtn: { alignSelf: 'center', paddingVertical: spacing.sm, paddingHorizontal: spacing.lg },
  skipText: { color: colors.textMuted, fontSize: fonts.size.sm, fontWeight: fonts.weight.semibold },
});
