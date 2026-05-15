import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, LayoutChangeEvent, StyleProp, TextStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useAnimatedStyle, useSharedValue, withTiming, withDelay, withSequence,
  Easing, interpolate, Extrapolation, cancelAnimation,
} from 'react-native-reanimated';
import { colors } from '@/theme';

// A single-line title that auto-scrolls only when it overflows.
//
// Fits → behaves exactly like a plain <Text> (left-aligned, one line).
// Overflows → a subtle edge fade marks the hidden text, then after a
// 3s pause the title eases left to reveal the end, holds, and eases
// back to the start once. No looping, so it never feels like a marquee.

const FADE_W = 26;
const START_DELAY = 3000;
const END_PAUSE = 1600;
const PX_PER_MS = 0.04; // ~40 px/sec — slow, readable, premium

interface Props {
  text: string;
  style?: StyleProp<TextStyle>;
}

function ScrollingTitleBase({ text, style }: Props) {
  const [containerW, setContainerW] = useState(0);
  const [textW, setTextW] = useState(0);
  const tx = useSharedValue(0);

  const overflow = containerW > 0 && textW > 0 ? Math.max(0, textW - containerW) : 0;
  const overflows = overflow > 1;

  const onContainer = useCallback((e: LayoutChangeEvent) => {
    setContainerW(e.nativeEvent.layout.width);
  }, []);
  const onText = useCallback((e: LayoutChangeEvent) => {
    setTextW(e.nativeEvent.layout.width);
  }, []);

  useEffect(() => {
    cancelAnimation(tx);
    tx.value = 0;
    if (!overflows) return;
    // Constant scroll speed regardless of how long the title is.
    const dur = Math.min(9000, Math.max(2400, Math.round(overflow / PX_PER_MS)));
    tx.value = withDelay(
      START_DELAY,
      withSequence(
        withTiming(-overflow, { duration: dur, easing: Easing.inOut(Easing.cubic) }),
        withDelay(END_PAUSE, withTiming(0, { duration: dur, easing: Easing.inOut(Easing.cubic) })),
      ),
    );
    return () => cancelAnimation(tx);
  }, [overflows, overflow, text, tx]);

  const scrollStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }],
  }));
  // Fades track the scroll: hidden text on the right at the start, on the
  // left once scrolled. Each fade sits over the side that has more title.
  const rightFadeStyle = useAnimatedStyle(() => ({
    opacity: overflow > 0 ? interpolate(tx.value, [-overflow, 0], [0, 1], Extrapolation.CLAMP) : 0,
  }));
  const leftFadeStyle = useAnimatedStyle(() => ({
    opacity: overflow > 0 ? interpolate(tx.value, [-overflow, 0], [1, 0], Extrapolation.CLAMP) : 0,
  }));

  return (
    <View style={styles.wrap} onLayout={onContainer}>
      <Animated.View style={[styles.scroller, scrollStyle]}>
        <Text style={style} numberOfLines={1} onLayout={onText}>{text}</Text>
      </Animated.View>
      {overflows ? (
        <>
          <Animated.View style={[styles.fadeLeft, leftFadeStyle]} pointerEvents="none">
            <LinearGradient
              colors={[colors.bg, 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
          <Animated.View style={[styles.fadeRight, rightFadeStyle]} pointerEvents="none">
            <LinearGradient
              colors={['transparent', colors.bg]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
  // alignSelf flex-start lets the row size to the text, so the text keeps
  // its natural single-line width and can overflow the clipped wrap.
  scroller: { alignSelf: 'flex-start' },
  fadeLeft: { position: 'absolute', left: 0, top: 0, bottom: 0, width: FADE_W },
  fadeRight: { position: 'absolute', right: 0, top: 0, bottom: 0, width: FADE_W },
});

// Memoized — the player re-renders on every playback tick; the title only
// needs to react to an actual song (text) change.
export const ScrollingTitle = React.memo(ScrollingTitleBase);
