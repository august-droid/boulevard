import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { CloseIcon, CheckIcon, SparkleIcon, TrendingIcon } from '@/components/Icon';
import { useAuth } from '@/contexts/AuthContext';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';
import { ReviewScreen } from '@/screens/ReviewScreen';
import { ExperimentsScreen } from '@/screens/ExperimentsScreen';
import { AnalyticsScreen } from '@/screens/AnalyticsScreen';

interface Props {
  visible: boolean;
  onClose: () => void;
}

// Admin Panel — the single home for admin-only tools (song review,
// split tests, analytics). These used to sit loose on the Profile screen;
// they're consolidated here so Profile stays an identity surface and the
// admin tooling has one deliberate entry point.

export function AdminScreen({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const auth = useAuth();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [experimentsOpen, setExperimentsOpen] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  // Pending-review count for the badge. Refreshes whenever the panel is
  // opened and after the Review queue closes (an approval changes it).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!visible || !auth.userId || !HAS_SUPABASE || !supabase) return;
      const { count } = await supabase
        .from('songs')
        .select('id', { count: 'exact', head: true })
        .eq('approved_by_human', false)
        .eq('approval_status', 'pending');
      if (!cancelled) setPendingCount(count ?? 0);
    })();
    return () => { cancelled = true; };
  }, [visible, auth.userId, reviewOpen]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: insets.top + spacing.md }]}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>ADMIN</Text>
            <Text style={styles.title}>Admin Panel</Text>
          </View>
          <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn}>
            <CloseIcon size={22} color={colors.textMuted} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: spacing.lg,
            paddingBottom: insets.bottom + spacing.xxl,
          }}
          showsVerticalScrollIndicator={false}
        >
          <Pressable onPress={() => setReviewOpen(true)} style={styles.entry}>
            <View style={styles.entryIcon}>
              <CheckIcon size={18} color={metals.goldSolidHi} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.entryTitle}>Review Queue</Text>
              <Text style={styles.entrySub}>
                {pendingCount > 0
                  ? `${pendingCount} song${pendingCount === 1 ? '' : 's'} awaiting your approval`
                  : 'No songs awaiting review right now'}
              </Text>
            </View>
            {pendingCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{pendingCount}</Text>
              </View>
            )}
          </Pressable>

          <Pressable onPress={() => setExperimentsOpen(true)} style={styles.entry}>
            <View style={styles.entryIcon}>
              <SparkleIcon size={18} color={metals.goldSolidHi} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.entryTitle}>Split Tests</Text>
              <Text style={styles.entrySub}>
                Create and approve A/B experiments across the app
              </Text>
            </View>
          </Pressable>

          <Pressable onPress={() => setAnalyticsOpen(true)} style={styles.entry}>
            <View style={styles.entryIcon}>
              <TrendingIcon size={18} color={metals.goldSolidHi} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.entryTitle}>Analytics</Text>
              <Text style={styles.entrySub}>
                Retention, conversion, listening and algorithm health
              </Text>
            </View>
          </Pressable>
        </ScrollView>
      </View>

      <ReviewScreen visible={reviewOpen} onClose={() => setReviewOpen(false)} />
      <ExperimentsScreen
        visible={experimentsOpen}
        onClose={() => setExperimentsOpen(false)}
      />
      <AnalyticsScreen
        visible={analyticsOpen}
        onClose={() => setAnalyticsOpen(false)}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  eyebrow: {
    color: colors.textMuted,
    fontSize: 11,
    letterSpacing: 2.4,
    fontWeight: fonts.weight.semibold,
  },
  title: {
    color: colors.text,
    fontSize: fonts.size.display,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.5,
    marginTop: 4,
  },
  closeBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: colors.surface,
  },

  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: 'rgba(40,32,18,0.45)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
  },
  entryIcon: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(200,174,122,0.10)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: metals.gold,
  },
  entryTitle: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.bold, letterSpacing: -0.2 },
  entrySub: { color: colors.textMuted, fontSize: fonts.size.sm, marginTop: 2 },
  badge: {
    minWidth: 26, height: 26, paddingHorizontal: 8, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#c8ae7a',
  },
  badgeText: { color: colors.bg, fontWeight: fonts.weight.bold, fontSize: fonts.size.sm, fontVariant: ['tabular-nums'] },
});
