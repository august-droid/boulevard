import React from 'react';
import { View, Text, StyleSheet, ViewStyle, Platform, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, spacing } from '@/theme';

// Boulevard mark for the top of every primary tab screen — the brushed-
// metal B icon paired with a wide-tracked "BOULEVARD" wordmark, matching
// the marketing assets. Deliberately small but readable — reads as a
// brand watermark on the page without competing with content.

interface Props {
  /** Adds the safe-area top inset to the wrapper. Default true. */
  withSafeArea?: boolean;
  /** Extra container style. */
  style?: ViewStyle;
}

export function BrandHeader({ withSafeArea = true, style }: Props) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  // On desktop web (>=1024px) the DesktopShell sidebar already carries the
  // Boulevard logo, so the in-screen wordmark would be redundant. Hidden only
  // there — native and mobile-web render it exactly as before.
  if (Platform.OS === 'web' && width >= 1024) return null;
  return (
    <View
      style={[
        styles.wrap,
        { paddingTop: (withSafeArea ? insets.top : 0) + spacing.sm },
        style,
      ]}
      pointerEvents="none"
    >
      <View style={styles.row}>
        <Image
          source={require('../../assets/icon.png')}
          style={styles.icon}
          contentFit="contain"
          cachePolicy="memory-disk"
        />
        <Text style={styles.wordmark} allowFontScaling={false}>
          BOULEVARD
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  icon: {
    width: 28,
    height: 28,
    borderRadius: 7,
  },
  wordmark: {
    color: metals.goldSolid,
    fontSize: 15,
    fontWeight: fonts.weight.bold,
    letterSpacing: 4.5,
    opacity: 0.92,
  },
});
