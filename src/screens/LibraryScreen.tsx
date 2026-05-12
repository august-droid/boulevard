import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, FlatList } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { usePlayer } from '@/contexts/PlayerContext';
import { SongRow } from '@/components/SongRow';
import { BookmarkIcon, HomeIcon, SparkleIcon } from '@/components/Icon';
import { Song } from '@/types';

type Section = 'saved' | 'recent' | 'vibes';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'saved',  label: 'Saved' },
  { id: 'recent', label: 'Recent' },
  { id: 'vibes',  label: 'Your Vibes' },
];

export function LibraryScreen() {
  const insets = useSafeAreaInsets();
  const player = usePlayer();
  const [section, setSection] = useState<Section>('saved');

  const lib = player.library;

  const data: Song[] = useMemo(() => {
    if (!lib) return [];
    if (section === 'saved') return lib.saved();
    if (section === 'recent') return lib.recent();
    return [];
    // libraryVersion changes whenever the underlying store mutates.
  }, [lib, section, player.libraryVersion]);

  const counts = useMemo(() => ({
    saved: lib?.saved().length ?? 0,
    recent: lib?.recent().length ?? 0,
  }), [lib, player.libraryVersion]);

  // Aggregate top vibes from taste profile for "Your Vibes" tab.
  const vibes = useMemo(() => {
    const a = player.taste?.activity_scores ?? {};
    return Object.entries(a)
      .filter(([, v]) => v > 0)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 6)
      .map(([key]) => key);
  }, [player.taste]);

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.md }]}>
      <Text style={styles.h1}>Library</Text>
      <Text style={styles.sub}>
        {counts.saved} saved · {counts.recent} played recently
      </Text>

      {/* Tabs — flex row with naturally-sized pills. No ScrollView. */}
      <View style={styles.tabsRow}>
        {SECTIONS.map((s) => {
          const active = section === s.id;
          return (
            <Pressable
              key={s.id}
              onPress={() => setSection(s.id)}
              style={[styles.tab, active && styles.tabActive]}
              hitSlop={4}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{s.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {section === 'vibes' ? (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 160 }}
          showsVerticalScrollIndicator={false}
        >
          {vibes.length === 0 ? (
            <EmptyState
              icon={<SparkleIcon size={28} color={colors.textMuted} />}
              title="Your vibes will appear here"
              body="Play a few songs and Boulevard learns which vibes you reach for most."
            />
          ) : (
            <View style={styles.vibeGrid}>
              {vibes.map((v) => (
                <Pressable
                  key={v}
                  onPress={() => player.setVibe(v as never)}
                  style={({ pressed }) => [styles.vibeCard, pressed && { opacity: 0.85 }]}
                >
                  <Text style={styles.vibeLabel}>{labelOf(v)}</Text>
                  <Text style={styles.vibeHint}>Play this vibe</Text>
                </Pressable>
              ))}
            </View>
          )}
        </ScrollView>
      ) : (
        <FlatList
          data={data}
          keyExtractor={(s) => s.id}
          renderItem={({ item }) => (
            <SongRow song={item} onPress={() => player.playSpecific(item)} />
          )}
          ListEmptyComponent={
            section === 'saved' ? (
              <EmptyState
                icon={<BookmarkIcon size={28} color={colors.textMuted} />}
                title="No saved songs yet"
                body="Tap Save on a song to keep it here for later."
              />
            ) : (
              <EmptyState
                icon={<HomeIcon size={28} color={colors.textMuted} />}
                title="Nothing played yet"
                body="The songs you listen to will show up here in the order you heard them."
              />
            )
          }
          ItemSeparatorComponent={() => <View style={styles.rowDivider} />}
          contentContainerStyle={{ paddingBottom: 160, paddingTop: spacing.xs }}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

function labelOf(v: string) {
  return v.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  body: string;
}

function EmptyState({ icon, title, body }: EmptyStateProps) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>{icon}</View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.lg },

  h1: {
    color: colors.text,
    fontSize: fonts.size.display,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.6,
  },
  sub: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    marginTop: 4,
    marginBottom: spacing.lg,
    letterSpacing: 0.1,
  },

  // Tabs — flex row, natural height. The previous bug was a horizontal
  // ScrollView with no height constraint stretching its children vertically.
  tabsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  tab: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 9,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    // Warm gold hairline on inactive tabs — picks up the Boulevard brand
    // temperature without committing to a colored fill.
    borderColor: metals.gold,
  },
  tabActive: {
    // Active tab keeps the white pill, but the inactive ones get a warm
    // gold hairline (see borderColor on `tab`) so the brand color is felt
    // throughout the section header.
    backgroundColor: colors.text,
    borderColor: colors.text,
  },
  tabLabel: {
    color: colors.textMuted,
    fontWeight: fonts.weight.semibold,
    fontSize: fonts.size.sm,
    letterSpacing: 0.1,
  },
  tabLabelActive: { color: colors.bg },

  rowDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.divider,
    marginLeft: 48 + spacing.md + spacing.md, // align past the row's cover thumbnail
  },

  empty: {
    paddingVertical: spacing.xxl * 1.5,
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  emptyIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
    marginBottom: spacing.md,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: fonts.size.lg,
    fontWeight: fonts.weight.semibold,
    textAlign: 'center',
    letterSpacing: -0.2,
  },
  emptyBody: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    textAlign: 'center',
    marginTop: 6,
    maxWidth: 280,
    lineHeight: 20,
  },

  vibeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  vibeCard: {
    width: '47%',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  vibeLabel: {
    color: colors.text,
    fontWeight: fonts.weight.semibold,
    fontSize: fonts.size.md,
    letterSpacing: -0.1,
  },
  vibeHint: {
    color: colors.textDim,
    fontSize: fonts.size.xs,
    marginTop: 6,
  },
});
