import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { SearchIcon, ProfileIcon } from '@/components/Icon';
import { useAuth } from '@/contexts/AuthContext';
import { useAppNav } from '@/contexts/NavigationContext';

// Desktop-only top bar. Rendered exclusively by DesktopShell (web >=1024px).
//   • Left  — a search field that opens the existing SearchSheet.
//   • Right — "Log in" for anonymous listeners (opens the sign-in sheet), or
//             a profile chip once signed in (opens the Profile tab).

interface Props {
  onOpenSearch: () => void;
  onOpenProfile: () => void;
}

export function DesktopTopBar({ onOpenSearch, onOpenProfile }: Props) {
  const auth = useAuth();
  const nav = useAppNav();

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onOpenSearch}
        style={({ pressed }) => [styles.search, pressed && styles.searchPressed]}
        accessibilityRole="search"
        accessibilityLabel="Search songs, artists, moods"
      >
        <SearchIcon size={18} color={colors.textMuted} />
        <Text style={styles.searchPlaceholder}>Search songs, artists, moods…</Text>
      </Pressable>

      <View style={styles.spacer} />

      {auth.isAnonymous ? (
        <Pressable
          onPress={() => nav.openSignup()}
          style={({ pressed }) => [styles.loginBtn, pressed && { opacity: 0.9 }]}
          accessibilityLabel="Log in or create an account"
        >
          <Text style={styles.loginText}>Log in</Text>
        </Pressable>
      ) : (
        <Pressable
          onPress={onOpenProfile}
          style={({ pressed }) => [styles.profileBtn, pressed && styles.profileBtnPressed]}
          accessibilityLabel="Open profile"
        >
          <ProfileIcon size={18} color={colors.text} />
          <Text style={styles.profileText}>Profile</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: metals.platinum,
    backgroundColor: colors.bg,
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    width: 420,
    maxWidth: '60%',
    height: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  searchPressed: {
    backgroundColor: colors.surfaceHover,
    borderColor: metals.platinumHi,
  },
  searchPlaceholder: {
    color: colors.textMuted,
    fontSize: fonts.size.md,
  },
  spacer: { flex: 1 },

  loginBtn: {
    height: 38,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.pill,
    backgroundColor: metals.goldSolid,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loginText: {
    color: '#0a0a0c',
    fontSize: fonts.size.sm,
    fontWeight: fonts.weight.bold,
    letterSpacing: 0.2,
  },

  profileBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 38,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  profileBtnPressed: {
    backgroundColor: colors.surfaceHover,
  },
  profileText: {
    color: colors.text,
    fontSize: fonts.size.sm,
    fontWeight: fonts.weight.semibold,
  },
});
