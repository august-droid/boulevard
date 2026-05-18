import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PurchasesPackage } from 'react-native-purchases';
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
import { useExperiment } from '@/contexts/ExperimentContext';
import { FREE_COMPLETED_LIMIT } from '@/lib/limits/CompletionLimiter';
import {
  HAS_BILLING,
  getOffering,
  packageToPlan,
  purchasePackage,
  restorePurchases,
} from '@/lib/billing/Billing';

interface Props {
  visible: boolean;
  onClose: () => void;
  /**
   * Optional handler to open the SignupSheet from the paywall's "have an
   * account?" link. Lets users who hit the 10-listen cap before signing
   * up reach the auth surface without dead-ending. The host (RootNavigator
   * or ProfileScreen) provides this; absent → link is hidden.
   */
  onOpenSignIn?: () => void;
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

export function PaywallScreen({ visible, onClose, onOpenSignIn }: Props) {
  const insets = useSafeAreaInsets();
  const auth = useAuth();
  // Active premium_popup split test (if any). When no test runs this handle
  // is inert: every value() call returns the hardcoded default below, so the
  // paywall is byte-identical to its pre-experiment behavior.
  const popup = useExperiment('premium_popup');
  // Yearly is selected by default — it's the better deal and the better LTV.
  const [plan, setPlan] = useState<Plan>('yearly');
  const [packages, setPackages] = useState<Record<Plan, PurchasesPackage | null>>(
    { yearly: null, monthly: null },
  );
  const [purchasing, setPurchasing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pull live offerings from RevenueCat when the paywall opens. We map them
  // by our PlanId so the UI can show the actual localized prices coming back
  // from the Play Store (e.g. "€36.99/year" instead of the hardcoded "$39").
  useEffect(() => {
    if (!visible || !HAS_BILLING) return;
    let cancelled = false;
    getOffering().then((offering) => {
      if (cancelled || !offering) return;
      const next: Record<Plan, PurchasesPackage | null> = { yearly: null, monthly: null };
      for (const pkg of offering.availablePackages) {
        const plan = packageToPlan(pkg);
        if (plan) next[plan] = pkg;
      }
      setPackages(next);
    });
    return () => { cancelled = true; };
  }, [visible]);

  // Log a paywall view for the active premium_popup split test. Fires once
  // each time the sheet opens; a no-op when no test is running.
  useEffect(() => {
    if (!visible) return;
    popup.track('premium_popup_view');
    popup.track('impression');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const displayPrice = (p: Plan): string => {
    return packages[p]?.product.priceString ?? PLAN_DETAILS[p].price;
  };

  const startTrial = async () => {
    setError(null);
    // Split-test telemetry: the CTA tap, then the trial-start intent.
    popup.track('click', { metadata: { plan } });
    popup.track('premium_start', { metadata: { plan } });
    // Without billing configured (dev / TestFlight), fall through to the legacy
    // local 3-day flag so the team can iterate without a working SDK key.
    if (!HAS_BILLING) {
      await auth.startTrial();
      popup.track('premium_purchase', { metadata: { plan, mode: 'trial' } });
      popup.track('conversion', { metadata: { plan } });
      onClose();
      return;
    }
    const pkg = packages[plan];
    if (!pkg) {
      setError('Subscriptions are temporarily unavailable. Please try again in a moment.');
      return;
    }
    setPurchasing(true);
    try {
      await purchasePackage(pkg);
      // The RevenueCat customer-info listener in AuthContext flips
      // `isPremium` automatically — we just close the sheet.
      popup.track('premium_purchase', { metadata: { plan } });
      popup.track('conversion', { metadata: { plan } });
      onClose();
    } catch (e: any) {
      // User-cancel is the most common error and shouldn't show a banner.
      const userCancelled = e?.userCancelled === true || e?.code === '1';
      if (!userCancelled) {
        setError(e?.message ?? 'Purchase failed. Please try again.');
      }
    } finally {
      setPurchasing(false);
    }
  };

  const onRestore = async () => {
    setError(null);
    setRestoring(true);
    try {
      const info = await restorePurchases();
      // If the user did have an active sub, the listener already flipped
      // isPremium and the paywall would close from the parent useEffect.
      if (info && info.entitlements.active['premium']) {
        onClose();
      } else {
        setError('No active subscription found to restore.');
      }
    } finally {
      setRestoring(false);
    }
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
          <Text style={styles.eyebrow}>YOU'VE LISTENED TO</Text>
          <View style={styles.headlineRow}>
            <Text style={styles.headlineNumber}>{FREE_COMPLETED_LIMIT} </Text>
            <Text style={styles.headlineMain}>songs</Text>
          </View>
          <Text style={styles.headlineItalic}>completed</Text>
          <Text style={styles.subhead}>
            {popup.value('subheadline', 'Go Premium to keep listening\nwith no limits.')}
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
              <Text style={styles.cardTitle}>
                {popup.value('headline', 'Unlimited music.\nNo limits.')}
              </Text>

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
                  price={displayPrice('yearly')}
                  cadence="/year"
                  badge="Save 67%"
                  selected={plan === 'yearly'}
                  onPress={() => setPlan('yearly')}
                />
                <PlanPill
                  label="Monthly"
                  price={displayPrice('monthly')}
                  cadence="/mo"
                  selected={plan === 'monthly'}
                  onPress={() => setPlan('monthly')}
                />
              </View>

              {/* CTA */}
              <Pressable
                onPress={purchasing ? undefined : startTrial}
                disabled={purchasing}
                style={[styles.ctaWrap, purchasing && { opacity: 0.7 }]}
              >
                <LinearGradient
                  colors={[GOLD.ctaA, GOLD.ctaB, GOLD.ctaC]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.cta}
                >
                  {purchasing ? (
                    <ActivityIndicator color="#0a0a0c" />
                  ) : (
                    <>
                      <Text style={styles.ctaText}>{popup.value('cta', 'Start Free Trial')}</Text>
                      <View style={styles.ctaArrow}>
                        <ArrowRightIcon size={20} color="#0a0a0c" />
                      </View>
                    </>
                  )}
                </LinearGradient>
              </Pressable>

              <Text style={styles.fine}>3 days free, then {displayPrice(plan)}{plan === 'yearly' ? '/year' : '/month'} after trial</Text>

              {error ? <Text style={styles.errorText}>{error}</Text> : null}
            </View>
          </LinearGradient>
        </View>

        <View style={styles.bottomLinks}>
          <Pressable
            onPress={restoring ? undefined : onRestore}
            disabled={restoring}
            hitSlop={12}
            style={styles.linkBtn}
          >
            <Text style={styles.linkText}>
              {restoring ? 'Restoring…' : 'Restore purchases'}
            </Text>
          </Pressable>
          <Text style={styles.linkDot}>·</Text>
          <Pressable onPress={onClose} hitSlop={12} style={styles.linkBtn}>
            <Text style={styles.linkText}>Maybe later</Text>
          </Pressable>
        </View>

        {/* Sign-in escape hatch. Anonymous users who dismissed the
            SignupSheet at 5 completions otherwise have no way to log
            into an existing account from this surface. Only shown
            while the user is still anonymous; once signed up the
            line is hidden. */}
        {onOpenSignIn && auth.isAnonymous && (
          <View style={styles.signInRow}>
            <Text style={styles.signInPrompt}>Already have an account?</Text>
            <Pressable hitSlop={12} onPress={onOpenSignIn} style={styles.linkBtn}>
              <Text style={styles.signInLink}>Sign in</Text>
            </Pressable>
          </View>
        )}
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

  bottomLinks: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: spacing.sm,
  },
  linkBtn: {
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  linkText: {
    color: colors.text,
    fontSize: fonts.size.sm,
    textDecorationLine: 'underline',
  },
  linkDot: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
  },
  errorText: {
    color: '#ff8585',
    fontSize: fonts.size.xs,
    textAlign: 'center',
    marginTop: 8,
  },
  signInRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: spacing.xs,
  },
  signInPrompt: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
  },
  signInLink: {
    color: colors.text,
    fontSize: fonts.size.sm,
    fontWeight: fonts.weight.semibold,
    textDecorationLine: 'underline',
  },
});
