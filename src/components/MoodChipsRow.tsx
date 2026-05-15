import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { MOODS, Mood } from '@/lib/mood/MoodPlaylist';

// Horizontal-scroll row of mood chips, pinned just above "Most Popular".
// Tap a chip → caller builds the personalized mood playlist and starts it.

interface Props {
  onPick: (mood: Mood) => void;
}

export function MoodChipsRow({ onPick }: Props) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>How are you feeling?</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {MOODS.map((m) => (
          <Pressable
            key={m.id}
            onPress={() => {
              if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
              onPick(m);
            }}
            style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
            accessibilityLabel={`${m.label} mood`}
          >
            <Text style={styles.emoji}>{m.emoji}</Text>
            <Text style={styles.chipLabel}>{m.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
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
  chipPressed: {
    backgroundColor: colors.surfaceHover,
    borderColor: metals.goldHi,
    transform: [{ scale: 0.96 }],
  },
  emoji: { fontSize: 18 },
  chipLabel: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.semibold },
});
