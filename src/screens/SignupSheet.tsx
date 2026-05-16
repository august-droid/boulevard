import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { useAuth } from '@/contexts/AuthContext';
import { HAS_SUPABASE } from '@/lib/supabase';
import { signInWithProvider, Provider } from '@/lib/auth/socialAuth';
import { signUpAndUpgrade, signInExisting, sendPasswordReset } from '@/lib/auth/emailAuth';
import {
  CloseIcon,
  CheckIcon,
  SparkleIcon,
  AppleIcon,
  GoogleIcon,
} from '@/components/Icon';

interface Props {
  visible: boolean;
  onClose: () => void;
  /**
   * Hard gate. When true the sheet cannot be dismissed — no close button,
   * no "Maybe later", back/Esc is a no-op. Used by the web app once an
   * anonymous listener has used their 5 free plays: they must sign in to
   * continue. `onClose` then only fires on a successful sign-in.
   */
  mandatory?: boolean;
}

type Mode = 'signup' | 'login' | 'forgot';

const BULLETS = [
  'Your music gets better the more you listen',
  'Pick up where you left off on any device',
  'Saved songs, likes and playlists stay safe',
];

export function SignupSheet({ visible, onClose, mandatory = false }: Props) {
  const insets = useSafeAreaInsets();
  const auth = useAuth();

  const [mode, setMode] = useState<Mode>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loadingProvider, setLoadingProvider] = useState<Provider | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const reset = () => {
    setError(null);
    setInfo(null);
  };

  const doSocial = async (provider: Provider) => {
    reset();
    setLoadingProvider(provider);
    try {
      const result = await signInWithProvider(provider);
      if (result.cancelled) return;
      if (result.ok || result.demo) {
        await auth.markSignedUp();
        onClose();
      } else {
        setError(result.error ?? 'Sign-in failed. Try another method.');
      }
    } finally {
      setLoadingProvider(null);
    }
  };

  const doEmailSignup = async () => {
    reset();
    setEmailBusy(true);
    try {
      const r = await signUpAndUpgrade(email.trim(), password);
      if (r.ok) {
        await auth.markSignedUp();
        if (r.needsEmailConfirmation) {
          setInfo('Check your email to confirm your account.');
        } else {
          onClose();
        }
      } else if (r.demo) {
        // Supabase not configured locally — still let the user proceed so
        // the gate does not jam in dev builds.
        await auth.markSignedUp();
        onClose();
      } else {
        setError(r.error ?? 'Could not create your account.');
      }
    } finally {
      setEmailBusy(false);
    }
  };

  const doEmailLogin = async () => {
    reset();
    setEmailBusy(true);
    try {
      const r = await signInExisting(email.trim(), password);
      if (r.ok) {
        await auth.markSignedUp();
        onClose();
      } else if (r.demo) {
        await auth.markSignedUp();
        onClose();
      } else {
        setError(r.error ?? 'Could not sign you in.');
      }
    } finally {
      setEmailBusy(false);
    }
  };

  const doForgot = async () => {
    reset();
    setEmailBusy(true);
    try {
      const r = await sendPasswordReset(email.trim());
      if (r.ok) {
        setInfo('Password reset link sent. Check your inbox.');
      } else if (r.demo) {
        setInfo('Password reset is not configured in this build.');
      } else {
        setError(r.error ?? 'Could not send the reset email.');
      }
    } finally {
      setEmailBusy(false);
    }
  };

  const skip = async () => {
    await auth.markSignupPromptShown();
    onClose();
  };

  const ctaLabel =
    mode === 'signup' ? 'Create account' :
    mode === 'login'  ? 'Sign in' :
    'Send reset link';

  const ctaAction =
    mode === 'signup' ? doEmailSignup :
    mode === 'login'  ? doEmailLogin :
    doForgot;

  // Progressive form: the password field only appears once the user has
  // started typing an email, so the first thing they see is a single
  // field. The CTA only activates when the visible fields are filled.
  const canSubmit =
    mode === 'forgot'
      ? email.trim().length > 0
      : email.trim().length > 0 && password.length > 0;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      // A mandatory sheet ignores Android-back / Esc — the user must sign in.
      onRequestClose={mandatory ? () => {} : onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, backgroundColor: colors.bg }}
      >
        <View
          style={[
            styles.root,
            { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.lg },
          ]}
        >
          <LinearGradient
            colors={['rgba(138,123,255,0.18)', 'rgba(10,10,12,0)']}
            style={styles.glow}
            pointerEvents="none"
          />
          {/* No dismiss affordance when the sheet is a hard gate. */}
          {!mandatory && (
            <Pressable onPress={onClose} style={styles.close} hitSlop={12}>
              <CloseIcon size={22} color={colors.textDim} />
            </Pressable>
          )}

          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Capped, centered content column. On phones (always narrower
                than the cap) this is a no-op; on desktop web it stops the
                buttons + form from stretching the full window width. */}
            <View style={styles.contentColumn}>
            <View style={styles.iconWrap}>
              <SparkleIcon size={28} color={colors.text} />
            </View>
            {/* Native fires at 5 completions; the web hard gate (mandatory)
                at 10; the web entry nudge fires on open (0 songs in). */}
            <Text style={styles.eyebrow}>
              {mandatory
                ? "YOU'RE 10 SONGS IN"
                : Platform.OS === 'web'
                  ? 'FREE TO JOIN'
                  : "YOU'RE 5 SONGS IN"}
            </Text>
            <Text style={styles.h1}>
              {mode === 'forgot' ? 'Reset your password' : 'Become a part of Boulevard Family'}
            </Text>
            <Text style={styles.sub}>
              {mode === 'forgot'
                ? 'We will send you a link to set a new password.'
                : 'Free to join. Your library and recommendations follow you.'}
            </Text>

            {mode !== 'forgot' && (
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
            )}

            {/* Social sign-in — the fast path, shown first above email.
                Apple sign-in is native-only for now: the web app has no
                Apple OAuth configured, so the button is hidden on web. */}
            {mode !== 'forgot' && (
              <View style={styles.providers}>
                {Platform.OS !== 'web' && (
                  <ProviderButton
                    provider="apple"
                    loading={loadingProvider === 'apple'}
                    disabled={loadingProvider !== null || emailBusy}
                    onPress={() => doSocial('apple')}
                    label="Continue with Apple"
                    background="#000000"
                    textColor="#ffffff"
                    border={metals.platinum}
                    icon={<AppleIcon size={20} color="#ffffff" />}
                  />
                )}
                <ProviderButton
                  provider="google"
                  loading={loadingProvider === 'google'}
                  disabled={loadingProvider !== null || emailBusy}
                  onPress={() => doSocial('google')}
                  label="Continue with Google"
                  background="#ffffff"
                  textColor="#0f0f12"
                  icon={<GoogleIcon size={20} />}
                />
              </View>
            )}

            {mode !== 'forgot' && (
              <View style={styles.dividerRow}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>or with email</Text>
                <View style={styles.dividerLine} />
              </View>
            )}

            {/* Email form */}
            <View style={styles.form}>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="Email"
                placeholderTextColor={colors.textDim}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="emailAddress"
                style={styles.input}
                editable={!emailBusy}
              />
              {mode !== 'forgot' && email.trim().length > 0 && (
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Password"
                  placeholderTextColor={colors.textDim}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType={mode === 'signup' ? 'newPassword' : 'password'}
                  style={styles.input}
                  editable={!emailBusy}
                />
              )}

              <Pressable
                onPress={emailBusy || !canSubmit ? undefined : ctaAction}
                disabled={emailBusy || !canSubmit}
                style={({ pressed }) => [
                  styles.primaryCta,
                  { opacity: emailBusy ? 0.7 : !canSubmit ? 0.45 : pressed ? 0.9 : 1 },
                ]}
              >
                {emailBusy ? (
                  <ActivityIndicator color="#0a0a0c" />
                ) : (
                  <Text style={styles.primaryCtaText}>{ctaLabel}</Text>
                )}
              </Pressable>

              {/* Mode toggles */}
              <View style={styles.modeRow}>
                {mode === 'signup' && (
                  <>
                    <Pressable onPress={() => { setMode('login'); reset(); }} hitSlop={8}>
                      <Text style={styles.modeLink}>Already have an account?</Text>
                    </Pressable>
                  </>
                )}
                {mode === 'login' && (
                  <>
                    <Pressable onPress={() => { setMode('signup'); reset(); }} hitSlop={8}>
                      <Text style={styles.modeLink}>Create one</Text>
                    </Pressable>
                    <Text style={styles.modeDot}>·</Text>
                    <Pressable onPress={() => { setMode('forgot'); reset(); }} hitSlop={8}>
                      <Text style={styles.modeLink}>Forgot password?</Text>
                    </Pressable>
                  </>
                )}
                {mode === 'forgot' && (
                  <Pressable onPress={() => { setMode('login'); reset(); }} hitSlop={8}>
                    <Text style={styles.modeLink}>Back to sign in</Text>
                  </Pressable>
                )}
              </View>
            </View>

            {info ? <Text style={styles.info}>{info}</Text> : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}

            {/* "Maybe later" is hidden when the sheet is a hard gate. */}
            {!mandatory && (
              <Pressable onPress={skip} hitSlop={8} style={styles.skipBtn}>
                <Text style={styles.skipText}>Maybe later</Text>
              </Pressable>
            )}

            {!HAS_SUPABASE && (
              <Text style={styles.devNote}>
                Demo mode. Configure Supabase and enable each provider in the
                dashboard to enable real sign-in.
              </Text>
            )}
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
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
      {/* Icon pinned to a fixed left inset so every provider's mark sits on
          the same vertical line; the label stays centered in the button. */}
      <View style={styles.providerIcon}>
        {loading ? <ActivityIndicator color={textColor} /> : icon}
      </View>
      <Text style={[styles.providerLabel, { color: textColor }]}>{label}</Text>
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
  scroll: { paddingTop: spacing.lg, alignItems: 'center', paddingBottom: spacing.xl },
  // Caps the sheet content so buttons + form don't stretch the full window
  // on desktop web. Phones are always narrower than the cap, so it has no
  // effect there — the mobile layout is unchanged.
  contentColumn: {
    width: '100%',
    maxWidth: Platform.OS === 'web' ? 460 : undefined,
    alignItems: 'center',
  },
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

  form: { width: '100%', marginTop: spacing.lg, gap: spacing.sm },
  input: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    borderRadius: radii.lg,
    fontSize: fonts.size.md,
  },
  primaryCta: {
    height: 52,
    borderRadius: radii.pill,
    backgroundColor: metals.goldSolid,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xs,
  },
  primaryCtaText: {
    color: '#0a0a0c',
    fontWeight: fonts.weight.bold,
    fontSize: fonts.size.md,
    letterSpacing: 0.2,
  },
  modeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: spacing.sm,
  },
  modeLink: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    textDecorationLine: 'underline',
  },
  modeDot: { color: colors.textDim, fontSize: fonts.size.sm },

  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: metals.platinum,
  },
  dividerText: {
    color: colors.textDim,
    fontSize: fonts.size.xs,
    letterSpacing: 1.2,
  },

  providers: { width: '100%', marginTop: spacing.md, gap: spacing.sm + 2 },
  provider: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 52,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
  },
  providerIcon: {
    position: 'absolute',
    left: spacing.lg,
    top: 0,
    bottom: 0,
    width: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  providerLabel: {
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.semibold,
    letterSpacing: 0.1,
  },

  info: {
    color: colors.text,
    fontSize: fonts.size.sm,
    marginTop: spacing.md,
    textAlign: 'center',
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
