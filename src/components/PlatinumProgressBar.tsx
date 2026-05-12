import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, LayoutChangeEvent } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';

// Thin platinum→gold progress bar.
//
// Three visual states, picked in order of precedence:
//   1) `dragMs` — set during an active pan, gives instant feedback as the
//      finger moves
//   2) `seekTargetMs` — set right after the user releases. We hold this until
//      the upstream `position` prop catches up to within 500ms tolerance.
//      Without this bridge, `position` briefly snaps back to its pre-seek
//      value (audio.seekTo is async; the upstream `setState` lands a few ms
//      later), causing the bar to flicker backward.
//   3) `position` — live playback position from PlayerContext.
//
// IMPORTANT: gesture worklets run on the UI thread and CANNOT read React refs
// reliably. All ms-conversion happens on the JS thread inside the handlers
// below — the worklets only forward the raw `x` coordinate.

interface Props {
  position: number;       // ms — live playback position
  duration: number;       // ms
  onSeek?: (positionMillis: number) => void;
}

// Solid-hex platinum→warm gold gradient. Theme metals are intentionally low
// alpha for hairline outlines, which would be invisible on a 3px bar.
const GRADIENT_COLORS = ['#dde0e6', '#c5b489', '#b89762'];

export function PlatinumProgressBar({ position, duration, onSeek }: Props) {
  const [width, setWidth] = useState(0);
  const [dragMs, setDragMs] = useState<number | null>(null);
  const [seekTargetMs, setSeekTargetMs] = useState<number | null>(null);
  const widthRef = useRef(0);
  const durationRef = useRef(0);
  useEffect(() => { durationRef.current = duration; }, [duration]);

  // Clear the seek-target bridge once the live position has caught up.
  useEffect(() => {
    if (seekTargetMs === null) return;
    if (Math.abs(position - seekTargetMs) < 500) {
      setSeekTargetMs(null);
    }
  }, [position, seekTargetMs]);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    widthRef.current = w;
    setWidth(w);
  };

  // JS-thread x→ms conversion. Safe because refs work here.
  const xToMs = (x: number): number | null => {
    const w = widthRef.current;
    const d = durationRef.current;
    if (!isFinite(x) || w <= 0 || d <= 0) return null;
    const clamped = Math.max(0, Math.min(w, x));
    return Math.round((clamped / w) * d);
  };

  const handleBegin = (x: number) => {
    const ms = xToMs(x);
    if (ms !== null) setDragMs(ms);
  };
  const handleUpdate = (x: number) => {
    const ms = xToMs(x);
    if (ms !== null) setDragMs(ms);
  };
  const handleCommit = (x: number) => {
    const ms = xToMs(x);
    setDragMs(null);
    if (ms === null) return;
    // Hold the released position on screen until upstream catches up.
    setSeekTargetMs(ms);
    onSeek?.(ms);
  };
  const handleAbort = () => setDragMs(null);

  const tap = Gesture.Tap()
    .maxDuration(250)
    .onEnd((e, success) => {
      'worklet';
      if (!success) return;
      runOnJS(handleCommit)(e.x);
    });

  const pan = Gesture.Pan()
    .minDistance(0)
    .activeOffsetX([-2, 2])
    .onBegin((e) => {
      'worklet';
      runOnJS(handleBegin)(e.x);
    })
    .onUpdate((e) => {
      'worklet';
      runOnJS(handleUpdate)(e.x);
    })
    .onEnd((e) => {
      'worklet';
      runOnJS(handleCommit)(e.x);
    })
    .onFinalize((_e, success) => {
      'worklet';
      if (!success) runOnJS(handleAbort)();
    });

  const composed = Gesture.Race(pan, tap);

  // Pick the highest-precedence position source.
  const effective = dragMs ?? seekTargetMs ?? position;
  const progress = duration > 0
    ? Math.min(1, Math.max(0, effective / duration))
    : 0;

  return (
    <GestureDetector gesture={composed}>
      <View style={styles.hitArea} onLayout={onLayout}>
        <View style={styles.track}>
          {progress > 0 && (
            <View style={[styles.fillWrap, { width: `${progress * 100}%` }]}>
              <LinearGradient
                colors={GRADIENT_COLORS}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={StyleSheet.absoluteFill}
              />
            </View>
          )}
        </View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  // Generous vertical padding makes the thin track easy to grab — touch
  // target is a comfortable 32px tall even though the visible line is 3px.
  hitArea: {
    width: '100%',
    paddingVertical: 14,
  },
  track: {
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  fillWrap: {
    height: '100%',
    overflow: 'hidden',
  },
});
