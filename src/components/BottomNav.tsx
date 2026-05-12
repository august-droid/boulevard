import React from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, spacing } from '@/theme';
import { HomeIcon, LibraryIcon, ProfileIcon, ExploreIcon } from '@/components/Icon';

// Per product spec the bottom nav has NO "Create" button.
// Four tabs: Home → Explore → Library → Profile.

export type Tab = 'home' | 'explore' | 'library' | 'profile';

interface Props {
  active: Tab;
  onChange: (tab: Tab) => void;
}

interface TabSpec {
  id: Tab;
  label: string;
  Icon: typeof HomeIcon;
}

const TABS: TabSpec[] = [
  { id: 'home', label: 'Home', Icon: HomeIcon },
  { id: 'explore', label: 'Explore', Icon: ExploreIcon },
  { id: 'library', label: 'Library', Icon: LibraryIcon },
  { id: 'profile', label: 'Profile', Icon: ProfileIcon },
];

export function BottomNav({ active, onChange }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      <BlurView tint="dark" intensity={Platform.OS === 'ios' ? 60 : 40} style={StyleSheet.absoluteFill} />
      <View style={styles.row}>
        {TABS.map((t) => {
          const isActive = t.id === active;
          return (
            <Pressable
              key={t.id}
              onPress={() => onChange(t.id)}
              style={styles.tab}
              hitSlop={8}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
            >
              <View style={styles.iconWrap}>
                {isActive && (
                  // Ultra-subtle gold halo beneath the active icon — picks
                  // up the warm tint from the Boulevard logo without
                  // shouting. Two stacked gradients fake a soft radial
                  // glow without needing a real radial gradient.
                  <View pointerEvents="none" style={styles.glow}>
                    <LinearGradient
                      colors={['rgba(218,192,140,0.16)', 'rgba(218,192,140,0)']}
                      style={StyleSheet.absoluteFill}
                    />
                  </View>
                )}
                <t.Icon size={24} color={isActive ? colors.text : colors.textDim} filled={isActive} />
              </View>
              <Text style={[styles.label, isActive && styles.labelActive]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(10,10,12,0.78)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: metals.platinum,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    paddingTop: 10,
    paddingHorizontal: spacing.md,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    gap: 2,
  },
  iconWrap: {
    width: 36,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Soft halo behind the active icon — diameter > icon so it reads as a
  // glow, not a button background.
  glow: {
    position: 'absolute',
    width: 56,
    height: 38,
    borderRadius: 28,
    overflow: 'hidden',
  },
  label: {
    fontSize: fonts.size.xs,
    color: colors.textDim,
    fontWeight: fonts.weight.medium,
    marginTop: 2,
  },
  labelActive: {
    color: colors.text,
  },
});
