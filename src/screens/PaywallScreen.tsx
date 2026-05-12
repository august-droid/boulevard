import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import {
  CloseIcon,
  SparkleIcon,
  InfinityIcon,
  WaveformIcon,
  BookmarkIcon,
  BoltIcon,
  ArrowRightIcon,
} from '@/components/Icon';
import { useAuth } from '@/contexts/AuthContext';

interface Props {
  visible: boolean;
  onClose: () => void;
}

const FEATURES = [
  { Icon: InfinityIcon,  label: 'Unlimited listening' },
  { Icon: WaveformIcon,  label: 'Full access to all vibes' },
  { Icon: BookmarkIcon,  label: 'Save & build your library' },
  { Icon: BoltIcon,      label: 'Early access to new drops' },
];

// Premium gold palette tuned for the paywall — solid hexes used by
// LinearGradient (which doesn't accept rgba theme tokens cleanly).
const GOLD = {
  faintBorder: '#3a2f1c',
  border: '#6b5a36',
  borderHi: '#a48d54',
  text: '#d8be8a',
  textHi: '#f0d9a8',
  ctaA: '#f0d9a8',
  ctaB: '#c8a566',
  ctaC: '#a48a55',
};

type Plan = 'yearly' | 'monthly';

const PLAN_DETAILS: Record<Plan, { price: string; cadence: string; afterTrial: string }> = {
  yearly:  { price: '$39',    cadence: '/year',  afterTrial: '$39/year after trial' },
  monthly: { price: '$9.99',  cadence: '/month', afterTrial: '$9.99/month after trial' },
};

export function PaywallScreen({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const auth = useAuth();
  // Yearly is selected by default — it's the better deal and the better LTV.
  const [plan, setPlan] = useState<Plan>('yearly');

  const startTrial = async () => {
    await auth.startTrial();
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View
        style={[
          styles.root,
          { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.md },
        ]}
      >
        {/* Close */}
        <Pressable onPress={onClose} style={styles.close} hitSlop={12}>
          <CloseIcon size={24} color={colors.textMuted} />
        </Pressable>

        {/* Header */}
        <View style={styles.header}>
          <SparkleIcon size={22} color={GOLD.textHi} />
          <Text style={styles.eyebrow}>YOU'VE REACHED</Text>
          <View style={styles.headlineRow}>
            <Text style={styles.headlineNumber}>20 </Text>
            <Text style={styles.headlineMain}>songs</Text>
          </View>
          <Text style={styles.headlineItalic}>today</Text>
          <Text style={styles.subhead}>
            Come back tomorrow for{'\n'}10 more songs on us.
          </Text>
        </View>

        {/* Premium card */}
        <View style={styles.cardWrap}>
          <LinearGradient
            colors={[GOLD.borderHi, GOLD.border, GOLD.faintBorder, GOLD.border, GOLD.borderHi]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.cardBorder}
          >
            <View style={styles.card}>
              <View style={styles.brandRow}>
                <SparkleIcon size={12} color={GOLD.textHi} />
                <Text style={styles.brandLabel}>BOULEVARD PREMIUM</Text>
              </View>
              <Text style={styles.cardTitle}>Unlimited music.{'\n'}No limits.</Text>

              <View style={styles.features}>
                {FEATURES.map(({ Icon, label }, i) => (
                  <View key={label}>
                    <View style={styles.featureRow}>
                      <View style={styles.featureBadge}>
                        <Icon size={16} color={GOLD.textHi} />
                      </View>
                      <Text style={styles.featureLabel}>{label}</Text>
                    </View>
                    {i < FEATURES.length - 1 && <View style={styles.featureDivider} />}
                  </View>
                ))}
              </View>

              {/* Plan selector — yearly highlighted as the better deal. */}
              <View style={styles.plans}>
                <PlanPill
                  label="Yearly"
                  price="$39"
                  cadence="/year"
                  badge="Save 67%"
                  selected={plan === 'yearly'}
                  onPress={() => setPlan('yearly')}
                />
                <PlanPill
                  label="Monthly"
                  price="$9.99"
                  cadence="/mo"
                  selected={plan === 'monthly'}
                  onPress={() => setPlan('monthly')}
                />
              </View>

              {/* CTA */}
              <Pressable onPress={startTrial} style={styles.ctaWrap}>
                <LinearGradient
                  colors={[GOLD.ctaA, GOLD.ctaB, GOLD.ctaC]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.cta}
                >
                  <Text style={styles.ctaText}>Start Free Trial</Text>
                  <View style={styles.ctaArrow}>
                    <ArrowRightIcon size={20} color="#0a0a0c" />
                  </View>
                </LinearGradient>
              </Pressable>

              <Text style={styles.fine}>3 days free, then {PLAN_DETAILS[plan].afterTrial}</Text>
            </View>
          </LinearGradient>
        </View>

        <Pressable onPress={onClose} hitSlop={12} style={styles.maybeLater}>
          <Text style={styles.maybeLaterText}>Maybe later</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

// --- Plan pill ------------------------------------------------------

interface PlanPillProps {
  label: string;
  price: string;
  cadence: string;
  badge?: string;
  selected: boolean;
  onPress: () => void;
}

function PlanPill({ label, price, cadence, badge, selected, onPress }: PlanPillProps) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        planPillStyles.pill,
        selected ? planPillStyles.pillSelected : planPillStyles.pillIdle,
      ]}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
    >
      <View style={planPillStyles.labelRow}>
        <Text style={planPillStyles.label}>{label}</Text>
        {badge ? (
          <View style={planPillStyles.badge}>
            <Text style={planPillStyles.badgeText}>{badge}</Text>
          </View>
        ) : null}
      </View>
      <View style={planPillStyles.priceRow}>
        <Text style={planPillStyles.price}>{price}</Text>
        <Text style={planPillStyles.cadence}>{cadence}</Text>
      </View>
    </Pressable>
  );
}

const planPillStyles = StyleSheet.create({
  pill: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1.5,
  },
  pillIdle: {
    backgroundColor: 'rgba(20,20,24,0.6)',
    borderColor: '#3a2f1c', // soft graphite-gold
  },
  pillSelected: {
    backgroundColor: 'rgba(40,32,18,0.5)',
    borderColor: '#d8be8a', // bright gold edge
  },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { color: '#fff', fontSize: 13, fontWeight: '600', letterSpacing: 0.2 },
  badge: {
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: 'rgba(216, 190, 138, 0.16)',
  },
  badgeText: { color: '#f0d9a8', fontSize: 9, fontWeight: '700', letterSpacing: 0.4 },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 4 },
  price: { color: '#fff', fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  cadence: { color: 'rgba(255,255,255,0.55)', fontSize: 12, marginLeft: 3 },
});

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
    paddingHorizontal: spacing.lg,
  },
  close: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },

  header: { alignItems: 'center', marginTop: 0 },
  eyebrow: {
    color: colors.text,
    fontSize: 11,
    letterSpacing: 3,
    marginTop: spacing.sm,
    fontWeight: fonts.weight.medium,
  },
  headlineRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginTop: 6,
  },
  headlineNumber: {
    color: '#c8ccd6', // platinum
    fontSize: 40,
    fontWeight: fonts.weight.bold,
    letterSpacing: -1.2,
  },
  headlineMain: {
    color: colors.text,
    fontSize: 40,
    fontWeight: fonts.weight.bold,
    letterSpacing: -1.2,
  },
  headlineItalic: {
    color: GOLD.textHi,
    fontSize: 36,
    fontStyle: 'italic',
    fontWeight: Platform.OS === 'ios' ? '400' : '500',
    letterSpacing: -0.8,
    marginTop: -2,
    // Approximate a serif italic on iOS for the cursive feel of the mockup.
    fontFamily: Platform.OS === 'ios' ? 'Georgia-Italic' : undefined,
  },
  subhead: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    marginTop: spacing.sm,
    textAlign: 'center',
    lineHeight: 19,
  },

  cardWrap: { marginTop: spacing.md },
  cardBorder: {
    borderRadius: 22,
    padding: StyleSheet.hairlineWidth + 0.6,
  },
  card: {
    backgroundColor: '#0c0c0e',
    borderRadius: 21,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },

  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 6,
    marginTop: 6,
  },
  brandLabel: {
    color: GOLD.text,
    fontSize: 11,
    letterSpacing: 2.4,
    fontWeight: fonts.weight.semibold,
  },
  cardTitle: {
    color: colors.text,
    fontSize: 24,
    fontWeight: fonts.weight.bold,
    textAlign: 'center',
    marginTop: 6,
    letterSpacing: -0.3,
    lineHeight: 30,
  },

  features: { marginTop: spacing.md, marginBottom: spacing.sm },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
  },
  featureBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: GOLD.border,
    marginRight: spacing.md,
  },
  featureLabel: {
    color: colors.text,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.medium,
  },
  featureDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: GOLD.faintBorder,
    marginLeft: 28 + spacing.md,
  },

  plans: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
  },
  ctaWrap: {
    borderRadius: radii.pill,
    overflow: 'hidden',
    marginTop: spacing.sm,
    shadowColor: GOLD.ctaB,
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    paddingHorizontal: spacing.lg,
  },
  ctaText: {
    color: '#0a0a0c',
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.bold,
    letterSpacing: 0.2,
  },
  ctaArrow: {
    position: 'absolute',
    right: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },

  fine: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    textAlign: 'center',
    marginTop: 8,
  },

  maybeLater: {
    alignSelf: 'center',
    marginTop: spacing.sm,
    paddingVertical: 6,
  },
  maybeLaterText: {
    color: colors.text,
    fontSize: fonts.size.sm,
    textDecorationLine: 'underline',
  },
});
