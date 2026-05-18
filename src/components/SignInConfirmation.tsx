import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { useAuth } from '@/contexts/AuthContext';
import { CheckIcon } from '@/components/Icon';
import { colors, fonts, metals, radii, spacing } from '@/theme';

// One-time "you're signed in" confirmation. AuthContext flips `justSignedIn`
// true the moment an anonymous user attaches a real identity (social or
// email); this pops a checkmark badge for ~1s, then clears the flag and
// removes itself. Non-interactive — the app stays usable underneath.
export function SignInConfirmation() {
  const { justSignedIn, acknowledgeSignIn } = useAuth();
  const [visible, setVisible] = useState(false);
  const anim = useRef(new Animated.Value(0)).current;
  // Held in a ref so the animation effect depends only on `justSignedIn` and
  // never restarts because the callback's identity changed.
  const ackRef = useRef(acknowledgeSignIn);
  ackRef.current = acknowledgeSignIn;

  useEffect(() => {
    if (!justSignedIn) return;
    let cancelled = false;
    setVisible(true);
    anim.setValue(0);
    Animated.sequence([
      Animated.timing(anim, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.back(1.6)),
        useNativeDriver: true,
      }),
      Animated.delay(560),
      Animated.timing(anim, {
        toValue: 0,
        duration: 240,
        easing: Easing.in(Easing.ease),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (cancelled || !finished) return;
      setVisible(false);
      ackRef.current();
    });
    return () => {
      cancelled = true;
      anim.stopAnimation();
    };
  }, [justSignedIn, anim]);

  if (!visible) return null;

  const scale = anim.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] });

  return (
    <View style={styles.overlay} pointerEvents="none">
      <Animated.View style={[styles.badge, { opacity: anim, transform: [{ scale }] }]}>
        <View style={styles.check}>
          <CheckIcon size={32} color={colors.bg} />
        </View>
        <Text style={styles.label}>You're signed in</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  badge: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.xl + spacing.sm,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
    shadowColor: '#000',
    shadowOpacity: 0.55,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 14 },
  },
  check: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: metals.goldSolidHi,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    color: colors.text,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.bold,
    letterSpacing: 0.2,
  },
});
