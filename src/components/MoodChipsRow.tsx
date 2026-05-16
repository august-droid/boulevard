import React from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet, Platform, useWindowDimensions,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { moodById, ChipMood } from '@/lib/mood/moodCatalog';
import { useExplore } from '@/contexts/ExploreContext';

// Mood chips, ordered dynamically by the user's behavior (MoodStore). Tapping
// a chip records the click and tilts the For You shelf toward that mood;
// tapping the active chip again clears the mood filter. The chip set and
// ordering come entirely from ExploreContext.
//
// Layout:
//   • Native + mobile-width web: a single horizontal scroll row (unchanged).
//   • Desktop web (>=1024px): a wrapped two-row grid so every mood is visible
//     at once without horizontal scrolling. This branch is desktop-web only —
//     `twoRowDesktop` is always false on native, so native is untouched.

const DESKTOP_MIN_WIDTH = 1024;

export function MoodChipsRow() {
  const { moodOrder, sessionMoodId, selectMood } = useExplore();
  const { width } = useWindowDimensions();
  const chips = moodOrder
    .map(moodById)
    .filter((m): m is ChipMood => !!m);

  // Desktop web only. Native (Platform.OS !== 'web') can never enter this
  // branch, so its layout + behavior are byte-for-byte unchanged.
  const twoRowDesktop = Platform.OS === 'web' && width >= DESKTOP_MIN_WIDTH;

  const renderChip = (m: ChipMood) => {
    const active = sessionMoodId === m.id;
    return (
      <Pressable
        key={m.id}
        onPress={() => {
          if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
          selectMood(active ? null : m.id);
        }}
        style={({ pressed }) => [
          styles.chip,
          active && styles.chipActive,
          pressed && styles.chipPressed,
        ]}
        accessibilityLabel={`${m.label} mood`}
      >
        <Text style={styles.emoji}>{m.emoji}</Text>
        <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{m.label}</Text>
      </Pressable>
    );
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>How are you feeling?</Text>
      {twoRowDesktop ? (
        // Desktop: the mood set is split into exactly two rows so every mood
        // is visible at once (no horizontal scrolling). Each row also wraps
        // as a safety net on narrower desktop widths.
        <View style={styles.grid}>
          <View style={styles.gridRow}>
            {chips.slice(0, Math.ceil(chips.length / 2)).map(renderChip)}
          </View>
          <View style={styles.gridRow}>
            {chips.slice(Math.ceil(chips.length / 2)).map(renderChip)}
          </View>
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.row}
        >
          {chips.map(renderChip)}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.md, marginBottom: spacing.md },
  label: {
    color: colors.textMuted,
    fontSize: fonts.size.xs,
    fontWeight: fonts.weight.semibold,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  row: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  // Desktop-web two-row layout: a vertical stack of two chip rows.
  grid: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  gridRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  chipActive: {
    backgroundColor: metals.gold,
    borderColor: metals.goldHi,
  },
  chipPressed: {
    backgroundColor: colors.surfaceHover,
    transform: [{ scale: 0.96 }],
  },
  emoji: { fontSize: 18 },
  chipLabel: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.semibold },
  chipLabelActive: { color: '#1a1408' },
});
