import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, spacing } from '@/theme';

// Subtle "boulevard" wordmark for the top of every primary tab screen.
//
// Deliberately quiet — small, wide-tracked, gold-tinted text. Reads as a
// brand watermark rather than a UI element. Centered horizontally so it
// doesn't compete with the content below.

interface Props {
  /** Adds the safe-area top inset to the wrapper. Default true. */
  withSafeArea?: boolean;
  /** Extra container style. */
  style?: ViewStyle;
}

export function BrandHeader({ withSafeArea = true, style }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.wrap,
        { paddingTop: (withSafeArea ? insets.top : 0) + spacing.sm },
        style,
      ]}
      pointerEvents="none"
    >
      <Text style={styles.wordmark} allowFontScaling={false}>
        boulevard
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: spacing.xs,
  },
  wordmark: {
    color: metals.goldSolid,
    // Small, thin, wide-tracked — premium-watch-dial energy.
    fontSize: 13,
    fontWeight: fonts.weight.medium,
    letterSpacing: 5.5,
    textTransform: 'lowercase',
    opacity: 0.78,
  },
});
