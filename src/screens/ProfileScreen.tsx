import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Alert } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { usePlayer } from '@/contexts/PlayerContext';
import { useAuth } from '@/contexts/AuthContext';
import { topEntries, energyLabel } from '@/lib/taste/TasteProfile';
import { SparkleIcon, CheckIcon } from '@/components/Icon';
import { BrandHeader } from '@/components/BrandHeader';
import { PaywallScreen } from '@/screens/PaywallScreen';
import { ReviewScreen } from '@/screens/ReviewScreen';
import { isAdmin } from '@/lib/admin/adminClient';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';

export function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const player = usePlayer();
  const auth = useAuth();
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  // Check admin status + refresh the pending-count badge whenever Profile
  // is rendered. Cheap query, won't stress Supabase.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!auth.userId) return;
      const isA = await isAdmin(auth.userId);
      if (cancelled) return;
      setAdmin(isA);
      if (isA && HAS_SUPABASE && supabase) {
        const { count } = await supabase
          .from('songs')
          .select('id', { count: 'exact', head: true })
          .eq('approved_by_human', false)
          .eq('approval_status', 'pending');
        if (!cancelled) setPendingCount(count ?? 0);
      }
    })();
    return () => { cancelled = true; };
  }, [auth.userId, reviewOpen]);

  const copyUserId = async () => {
    if (!auth.userId) return;
    await Clipboard.setStringAsync(auth.userId);
    Alert.alert(
      'Copied',
      'Your user ID is in your clipboard.\n\nTo grant yourself review access, paste it into Supabase SQL editor:\n\ninsert into admin_users (user_id) values (\'<paste-here>\');',
    );
  };

  const summary = useMemo(() => {
    const t = player.taste;
    if (!t) return null;
    return {
      moods: topEntries(t.mood_scores),
      genres: topEntries(t.genre_scores),
      energy: energyLabel(t.energy_preference),
      bpm: t.bpm_preference ? Math.round(t.bpm_preference) : null,
      activities: topEntries(t.activity_scores),
    };
  }, [player.taste]);

  // Engagement-based "level" — same data the spec describes for the AI Taste
  // Profile meter. Saturates at 10 interactions.
  const level = Math.min(10, Math.floor(auth.engagementCount));

  return (
    <View style={[styles.root, { paddingTop: spacing.md }]}>
      <BrandHeader />
      <Text style={styles.h1}>Profile</Text>

      <ScrollView contentContainerStyle={{ paddingBottom: 140 }} showsVerticalScrollIndicator={false}>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.avatar}>
              <SparkleIcon size={24} color={colors.text} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{auth.isAnonymous ? 'You' : 'Member'}</Text>
              <View style={styles.badgeRow}>
                {auth.isPremium ? (
                  <View style={styles.premiumBadge}>
                    <Text style={styles.premiumText}>AI Member</Text>
                  </View>
                ) : (
                  <Text style={styles.memberSub}>Free</Text>
                )}
              </View>
            </View>
          </View>
        </View>

        <View style={styles.tasteCard}>
          <View style={styles.tasteHeader}>
            <Text style={styles.tasteTitle}>AI Taste Profile</Text>
            <Text style={styles.tasteSubtitle}>Boulevard is learning your sound.</Text>
          </View>
          <View style={styles.levelBar}>
            <View style={[styles.levelFill, { width: `${(level / 10) * 100}%` }]} />
          </View>
          <Text style={styles.levelLabel}>Level {level}</Text>
        </View>

        <Section title="Favorite moods">
          {summary && summary.moods.length > 0 ? (
            <Chips items={summary.moods.map((m) => labelOf(m.key))} />
          ) : (
            <Hint>Listen a bit and your top moods show up here.</Hint>
          )}
        </Section>

        <Section title="Favorite genres">
          {summary && summary.genres.length > 0 ? (
            <Chips items={summary.genres.map((m) => labelOf(m.key))} />
          ) : (
            <Hint>We'll show your favorite genres soon.</Hint>
          )}
        </Section>

        <Section title="Energy">
          <Text style={styles.bigValue}>{summary?.energy ?? 'Learning'}</Text>
          {summary?.bpm != null && (
            <Text style={styles.smallValue}>Around {summary.bpm} BPM</Text>
          )}
        </Section>

        <Section title="Most played vibe">
          {summary && summary.activities[0] ? (
            <Text style={styles.bigValue}>{labelOf(summary.activities[0].key)}</Text>
          ) : (
            <Hint>Try a vibe from the player to see this fill in.</Hint>
          )}
        </Section>

        {!auth.isPremium && (
          <Pressable onPress={() => setPaywallOpen(true)} style={styles.upgrade}>
            <SparkleIcon size={16} color={colors.bg} />
            <Text style={styles.upgradeText}>Try Boulevard Premium</Text>
          </Pressable>
        )}

        {admin && (
          <Pressable
            onPress={() => setReviewOpen(true)}
            style={styles.reviewEntry}
          >
            <View style={styles.reviewEntryIcon}>
              <CheckIcon size={18} color={metals.goldSolidHi} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.reviewEntryTitle}>Review Queue</Text>
              <Text style={styles.reviewEntrySub}>
                {pendingCount > 0
                  ? `${pendingCount} song${pendingCount === 1 ? '' : 's'} awaiting your approval`
                  : 'No songs awaiting review right now'}
              </Text>
            </View>
            {pendingCount > 0 && (
              <View style={styles.reviewBadge}>
                <Text style={styles.reviewBadgeText}>{pendingCount}</Text>
              </View>
            )}
          </Pressable>
        )}

        {/* Developer info — visible so you can grant yourself admin access
            on a fresh device. Tap the user-id row to copy it, then paste
            into the Supabase SQL editor as documented in the README. */}
        <View style={styles.devCard}>
          <Text style={styles.devCardLabel}>Your user ID</Text>
          <Pressable onPress={copyUserId} style={styles.devIdRow}>
            <Text style={styles.devIdText} numberOfLines={1}>
              {auth.userId ?? ''}
            </Text>
            <Text style={styles.devCopyHint}>Tap to copy</Text>
          </Pressable>
          {!admin && auth.userId ? (
            <Text style={styles.devHint}>
              Paste this into Supabase: {'\n'}
              <Text style={styles.devCode}>insert into admin_users (user_id) values ('{auth.userId.slice(0, 8)}…');</Text>
              {'\n'}to enable the review queue.
            </Text>
          ) : null}
        </View>
      </ScrollView>

      <PaywallScreen visible={paywallOpen} onClose={() => setPaywallOpen(false)} />
      <ReviewScreen visible={reviewOpen} onClose={() => setReviewOpen(false)} />
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Chips({ items }: { items: string[] }) {
  return (
    <View style={styles.chipRow}>
      {items.map((i) => (
        <View key={i} style={styles.chip}>
          <Text style={styles.chipText}>{i}</Text>
        </View>
      ))}
    </View>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <Text style={styles.hint}>{children}</Text>;
}

function labelOf(s: string) {
  return s.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.lg },
  h1: {
    color: colors.text,
    fontSize: fonts.size.display,
    fontWeight: fonts.weight.bold,
    marginBottom: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.surfaceHover,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { color: colors.text, fontSize: fonts.size.lg, fontWeight: fonts.weight.bold },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  memberSub: { color: colors.textMuted, fontSize: fonts.size.sm },
  premiumBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.brandDim,
  },
  premiumText: { color: colors.brand, fontSize: fonts.size.xs, fontWeight: fonts.weight.bold, letterSpacing: 1 },

  tasteCard: {
    marginTop: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  tasteHeader: { marginBottom: spacing.md },
  tasteTitle: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.semibold },
  tasteSubtitle: { color: colors.textMuted, fontSize: fonts.size.sm, marginTop: 2 },
  levelBar: {
    height: 6,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 3,
    overflow: 'hidden',
  },
  levelFill: {
    height: '100%',
    backgroundColor: colors.brand,
  },
  levelLabel: { color: colors.textMuted, fontSize: fonts.size.xs, marginTop: 6 },

  section: { marginTop: spacing.xl },
  sectionTitle: { color: colors.textMuted, fontSize: fonts.size.sm, marginBottom: 8, letterSpacing: 0.5 },
  bigValue: { color: colors.text, fontSize: fonts.size.xl, fontWeight: fonts.weight.bold },
  smallValue: { color: colors.textMuted, fontSize: fonts.size.sm, marginTop: 4 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  chipText: { color: colors.text, fontSize: fonts.size.sm, fontWeight: fonts.weight.medium },
  hint: { color: colors.textDim, fontSize: fonts.size.sm },

  upgrade: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.text,
    marginTop: spacing.xl,
  },
  upgradeText: { color: colors.bg, fontWeight: fonts.weight.bold, fontSize: fonts.size.md },

  // Review Queue entry — gold-tinted to read as the admin surface.
  reviewEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: 'rgba(40,32,18,0.45)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
  },
  reviewEntryIcon: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(200,174,122,0.10)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: metals.gold,
  },
  reviewEntryTitle: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.bold, letterSpacing: -0.2 },
  reviewEntrySub: { color: colors.textMuted, fontSize: fonts.size.sm, marginTop: 2 },
  reviewBadge: {
    minWidth: 26, height: 26, paddingHorizontal: 8, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#c8ae7a',
  },
  reviewBadgeText: { color: colors.bg, fontWeight: fonts.weight.bold, fontSize: fonts.size.sm, fontVariant: ['tabular-nums'] },

  // Developer info — for first-time admin grant.
  devCard: {
    marginTop: spacing.xl,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  devCardLabel: { color: colors.textMuted, fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase' },
  devIdRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 6 },
  devIdText: { color: colors.text, fontSize: fonts.size.sm, fontFamily: 'Menlo', flex: 1 },
  devCopyHint: { color: colors.textDim, fontSize: fonts.size.xs, marginLeft: spacing.sm },
  devHint: { color: colors.textDim, fontSize: fonts.size.xs, marginTop: spacing.md, lineHeight: 18 },
  devCode: { fontFamily: 'Menlo', color: colors.textMuted },
});
