import React, {
  forwardRef, useImperativeHandle, useRef, useState, useEffect, useCallback,
} from 'react';
import { View, StyleSheet, Animated, Easing } from 'react-native';
import { HeartIcon } from '@/components/Icon';
import { colors } from '@/theme';

export interface HeartBurstHandle {
  /** Release one heart that floats up and fades. Call once per tap. */
  spawn: () => void;
}

// Non-interactive overlay that releases a small heart every time spawn() is
// called — the "tap the like button again and again" delight. Each heart
// drifts up, wanders sideways a touch, fades, then removes itself.
export const HeartBurst = forwardRef<HeartBurstHandle, object>(function HeartBurst(_props, ref) {
  const [hearts, setHearts] = useState<number[]>([]);
  const nextId = useRef(0);

  useImperativeHandle(ref, () => ({
    spawn: () => setHearts((h) => [...h, nextId.current++]),
  }), []);

  const remove = useCallback((id: number) => {
    setHearts((h) => h.filter((x) => x !== id));
  }, []);

  return (
    <View style={styles.layer} pointerEvents="none">
      {hearts.map((id) => (
        <FlyingHeart key={id} onDone={() => remove(id)} />
      ))}
    </View>
  );
});

function FlyingHeart({ onDone }: { onDone: () => void }) {
  const t = useRef(new Animated.Value(0)).current;
  // Each heart gets its own drift + rise so a burst spreads naturally.
  const drift = useRef((Math.random() - 0.5) * 56).current;
  const rise = useRef(120 + Math.random() * 56).current;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    Animated.timing(t, {
      toValue: 1,
      duration: 880,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) doneRef.current();
    });
  }, [t]);

  const translateY = t.interpolate({ inputRange: [0, 1], outputRange: [0, -rise] });
  const translateX = t.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, drift * 0.6, drift] });
  const opacity = t.interpolate({ inputRange: [0, 0.12, 0.65, 1], outputRange: [0, 1, 1, 0] });
  const scale = t.interpolate({ inputRange: [0, 0.22, 1], outputRange: [0.4, 1.15, 0.8] });

  return (
    <Animated.View
      style={[styles.heart, { opacity, transform: [{ translateX }, { translateY }, { scale }] }]}
    >
      <HeartIcon size={22} color={colors.like} filled />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
  },
  heart: {
    position: 'absolute',
    bottom: 0,
  },
});
