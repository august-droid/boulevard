import React, { useEffect, useState } from 'react';
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { SparkleIcon } from '@/components/Icon';

// First-time explainer. The first time a new listener opens the player we
// tell them, once, that recommendations sharpen the more they listen — so
// the early "For You" misses read as the system warming up, not as a flaw.
//
// Self-gates on AsyncStorage (boulevard.listen_more_intro_shown): shows once
// per install, ever. Resetting that key shows it again (useful for testing).

const STORAGE_KEY = 'boulevard.listen_more_intro_shown';

interface Props {
  /** True once the trigger condition is met (the player has been opened). */
  active: boolean;
}

export function ListenMoreModal({ active }: Props) {
  const [ready, setReady] = useState(false);
  const [alreadyShown, setAlreadyShown] = useState(false);
  const [visible, setVisible] = useState(false);

  // Read the once-ever flag on mount.
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => setAlreadyShown(!!v))
      .catch(() => { /* best-effort — default to "not shown" */ })
      .finally(() => setReady(true));
  }, []);

  // Show the moment the player is first opened, then mark it shown so it
  // never fires again.
  useEffect(() => {
    if (!ready || alreadyShown || !active || visible) return;
    setVisible(true);
    setAlreadyShown(true);
    AsyncStorage.setItem(STORAGE_KEY, '1').catch(() => { /* best-effort */ });
  }, [ready, alreadyShown, active, visible]);

  const dismiss = () => setVisible(false);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={dismiss}>
      <Pressable style={styles.backdrop} onPress={dismiss}>
        {/* Inner Pressable swallows taps so clicking the card doesn't dismiss. */}
        <Pressable style={styles.card} onPress={() => {}}>
          <LinearGradient
            colors={['rgba(200,174,122,0.22)', 'rgba(10,10,12,0)']}
            style={styles.glow}
            pointerEvents="none"
          />
          <View style={styles.badge}>
            <SparkleIcon size={26} color={metals.goldSolidHi} />
          </View>
          <Text style={styles.eyebrow}>MADE FOR YOU</Text>
          <Text style={styles.title}>It gets better the more you listen</Text>
          <Text style={styles.sub}>
            Boulevard learns your taste from every song you play. The more you
            listen, the more your picks start to feel made for you.
          </Text>

          <Pressable
            onPress={dismiss}
            style={({ pressed }) => [styles.cta, pressed && { opacity: 0.9 }]}
            accessibilityLabel="Got it"
          >
            <Text style={styles.ctaText}>Got it</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.66)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.bgElevated,
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.goldHi,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    alignItems: 'center',
    overflow: 'hidden',
  },
  glow: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 200,
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.goldHi,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  eyebrow: {
    color: metals.goldSolidHi,
    fontSize: 11,
    fontWeight: fonts.weight.bold,
    letterSpacing: 2.6,
    marginBottom: 6,
  },
  title: {
    color: colors.text,
    fontSize: fonts.size.xxl,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  sub: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    lineHeight: 20,
    textAlign: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  cta: {
    marginTop: spacing.lg,
    height: 50,
    width: '100%',
    borderRadius: radii.pill,
    backgroundColor: metals.goldSolid,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: {
    color: '#0a0a0c',
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.bold,
    letterSpacing: 0.2,
  },
});
