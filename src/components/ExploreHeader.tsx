import React from 'react';
import { View, Text, Pressable, StyleSheet, ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, spacing } from '@/theme';
import { SearchIcon } from '@/components/Icon';

// Explore top bar — centered Boulevard wordmark with a search affordance on
// the right. A fixed-width spacer on the left balances the search button so
// the wordmark stays optically centered.

interface Props {
  /** Optional search handler. Omitted while the search screen is unbuilt. */
  onSearch?: () => void;
  style?: ViewStyle;
}

export function ExploreHeader({ onSearch, style }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + spacing.sm }, style]}>
      <View style={styles.side} />
      <View style={styles.brand}>
        <Image
          source={require('../../assets/icon.png')}
          style={styles.icon}
          contentFit="contain"
          cachePolicy="memory-disk"
        />
        <Text style={styles.wordmark} allowFontScaling={false}>BOULEVARD</Text>
      </View>
      <Pressable
        style={({ pressed }) => [styles.side, styles.searchBtn, pressed && { opacity: 0.6 }]}
        hitSlop={10}
        onPress={onSearch}
        accessibilityLabel="Search"
      >
        <SearchIcon size={22} color={colors.textMuted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  side: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  searchBtn: { alignItems: 'flex-end' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  icon: { width: 28, height: 28, borderRadius: 7 },
  wordmark: {
    color: metals.goldSolid,
    fontSize: 15,
    fontWeight: fonts.weight.bold,
    letterSpacing: 4.5,
    opacity: 0.92,
  },
});
