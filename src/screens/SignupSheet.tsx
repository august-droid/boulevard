import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { useAuth } from '@/contexts/AuthContext';
import { HAS_SUPABASE } from '@/lib/supabase';
import { signInWithProvider, Provider } from '@/lib/auth/socialAuth';
import {
  CloseIcon,
  CheckIcon,
  SparkleIcon,
  AppleIcon,
  GoogleIcon,
  FacebookIcon,
} from '@/components/Icon';

interface Props {
  visible: boolean;
  onClose: () => void;
}

const BULLETS = [
  '10 more songs free, every day',
  'Save the ones you love',
  'Your taste profile, learning daily',
];

export function SignupSheet({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const auth = useAuth();
  const [loadingProvider, setLoadingProvider] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doAuth = async (provider: Provider) => {
    setError(null);
    setLoadingProvider(provider);
    try {
      const result = await signInWithProvider(provider);
      if (result.cancelled) {
        // User dismissed — leave them on the sheet, don't mark as signed up.
        return;
      }
      if (result.ok || result.demo) {
        // demo === true means Supabase isn't configured — we still flow forward
        // locally so the gating logic doesn't get stuck in dev.
        await auth.markSignedUp();
        onClose();
      } else {
        setError(result.error ?? 'Sign-in failed. Try another method.');
      }
    } finally {
      setLoadingProvider(null);
    }
  };

  const skipFor = async () => {
    await auth.markSignedUp();
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View
        style={[
          styles.root,
          { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.lg },
        ]}
      >
        <LinearGradient
          colors={['rgba(138,123,255,0.15)', 'rgba(10,10,12,0)']}
          style={styles.glow}
          pointerEvents="none"
        />
        <Pressable onPress={onClose} style={styles.close} hitSlop={12}>
          <CloseIcon size={22} color={colors.textDim} />
        </Pressable>

        <View style={styles.content}>
          <View style={styles.iconWrap}>
            <SparkleIcon size={28} color={colors.text} />
          </View>
          <Text style={styles.eyebrow}>YOU'VE HEARD 10 SONGS</Text>
          <Text style={styles.h1}>Keep listening</Text>
          <Text style={styles.sub}>
            Sign up free — no card required.
          </Text>

          <View style={styles.bullets}>
            {BULLETS.map((b) => (
              <View key={b} style={styles.bulletRow}>
                <View style={styles.checkBg}>
                  <CheckIcon size={14} color={colors.bg} />
                </View>
                <Text style={styles.bulletText}>{b}</Text>
              </View>
            ))}
          </View>

          <View style={styles.providers}>
            <ProviderButton
              provider="apple"
              loading={loadingProvider === 'apple'}
              disabled={loadingProvider !== null}
              onPress={() => doAuth('apple')}
              label="Continue with Apple"
              background="#000000"
              textColor="#ffffff"
              border={metals.platinum}
              icon={<AppleIcon size={20} color="#ffffff" />}
            />
            <ProviderButton
              provider="google"
              loading={loadingProvider === 'google'}
              disabled={loadingProvider !== null}
              onPress={() => doAuth('google')}
              label="Continue with Google"
              background="#ffffff"
              textColor="#0f0f12"
              icon={<GoogleIcon size={20} />}
            />
            <ProviderButton
              provider="facebook"
              loading={loadingProvider === 'facebook'}
              disabled={loadingProvider !== null}
              onPress={() => doAuth('facebook')}
              label="Continue with Facebook"
              background="#1877F2"
              textColor="#ffffff"
              icon={<FacebookIcon size={20} />}
            />
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          {/* Quiet escape hatch — present but visibly secondary so signing up
              reads as the obvious next step. */}
          <Pressable onPress={skipFor} hitSlop={8} style={styles.skipBtn}>
            <Text style={styles.skipText}>Maybe later</Text>
          </Pressable>

          {!HAS_SUPABASE && (
            <Text style={styles.devNote}>
              Demo mode — auth is mocked locally. Configure Supabase + enable each
              provider in the dashboard to enable real sign-in.
            </Text>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ---- Provider button -------------------------------------------------

interface ProviderProps {
  provider: Provider;
  label: string;
  background: string;
  textColor: string;
  border?: string;
  icon: React.ReactNode;
  loading: boolean;
  disabled: boolean;
  onPress: () => void;
}

function ProviderButton({ label, background, textColor, border, icon, loading, disabled, onPress }: ProviderProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.provider,
        {
          backgroundColor: background,
          borderColor: border ?? 'transparent',
          opacity: disabled && !loading ? 0.55 : pressed ? 0.85 : 1,
        },
      ]}
    >
      <View style={styles.providerIconSlot}>{icon}</View>
      <Text style={[styles.providerLabel, { color: textColor }]}>{label}</Text>
      <View style={styles.providerIconSlot}>
        {loading ? <ActivityIndicator color={textColor} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.lg },
  glow: { position: 'absolute', top: 0, left: 0, right: 0, height: 320 },
  close: {
    alignSelf: 'flex-end',
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: colors.surface,
  },
  content: { paddingTop: spacing.lg, alignItems: 'center' },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 16,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  eyebrow: {
    color: colors.textMuted,
    fontSize: 11,
    letterSpacing: 2.4,
    fontWeight: fonts.weight.semibold,
    marginBottom: 8,
  },
  h1: {
    color: colors.text,
    fontSize: fonts.size.display,
    fontWeight: fonts.weight.bold,
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  sub: {
    color: colors.textMuted,
    fontSize: fonts.size.md,
    marginTop: 8,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
  bullets: { width: '100%', marginTop: spacing.lg, gap: spacing.sm + 2 },
  bulletRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  checkBg: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: colors.text,
    alignItems: 'center', justifyContent: 'center',
  },
  bulletText: { color: colors.text, fontSize: fonts.size.md, flex: 1 },

  providers: { width: '100%', marginTop: spacing.xl, gap: spacing.sm + 2 },
  provider: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
  },
  providerIconSlot: { width: 32, alignItems: 'center', justifyContent: 'center' },
  providerLabel: {
    flex: 1,
    textAlign: 'center',
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.semibold,
    letterSpacing: 0.1,
  },

  error: {
    color: colors.danger,
    fontSize: fonts.size.sm,
    marginTop: spacing.md,
    textAlign: 'center',
  },
  skipBtn: {
    marginTop: spacing.lg,
    paddingVertical: 4,
    paddingHorizontal: 12,
  },
  skipText: {
    color: colors.textDim,
    fontSize: fonts.size.sm,
    textDecorationLine: 'underline',
  },
  devNote: {
    color: colors.textDim,
    fontSize: fonts.size.xs,
    marginTop: spacing.md,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
});
