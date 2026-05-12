import React, { useMemo, useState } from 'react';
import { View, StyleSheet, LayoutChangeEvent } from 'react-native';
import {
  GestureDetector,
  Gesture,
} from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { colors } from '@/theme';

// Deterministic per-song waveform visualization.
// We can't get real PCM levels out of expo-av without native modules, so the
// bars are derived from a hash of the song id. Same song always renders the
// same shape, which is what users actually expect from a "waveform" — a
// stable visual signature, not a live FFT.
//
// Tapping or dragging across the waveform calls onSeek with the chosen
// position in ms — the player feed wires this to PlayerContext.seek().

const BAR_COUNT = 68;

interface Props {
  songId: string;
  position: number; // ms
  duration: number; // ms
  height?: number;
  onSeek?: (positionMillis: number) => void;
}

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function rand01(seed: number, i: number): number {
  let t = (seed + i * 0x9e3779b1) | 0;
  t = Math.imul(t ^ (t >>> 16), 0x85ebca6b);
  t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35);
  t = t ^ (t >>> 16);
  return (t >>> 0) / 4294967296;
}

export function Waveform({ songId, position, duration, height = 40, onSeek }: Props) {
  const [width, setWidth] = useState(0);
  // While the user is mid-drag we render the local position instead of the
  // remote one so the scrub feels immediate and doesn't snap-back.
  const [dragPosition, setDragPosition] = useState<number | null>(null);

  const heights = useMemo(() => {
    const seed = hashString(songId || 'default');
    return Array.from({ length: BAR_COUNT }, (_, i) => {
      const env = Math.sin((i / (BAR_COUNT - 1)) * Math.PI);
      const noise = rand01(seed, i);
      const spike = rand01(seed, i + 1000) > 0.92 ? 0.25 : 0;
      return Math.min(1, 0.18 + env * 0.55 + noise * 0.35 + spike);
    });
  }, [songId]);

  const effectivePosition = dragPosition ?? position;
  const progress = duration > 0 ? Math.min(1, Math.max(0, effectivePosition / duration)) : 0;
  const activeBars = Math.round(progress * BAR_COUNT);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const computeMs = (x: number) => {
    if (width <= 0 || duration <= 0) return 0;
    const clamped = Math.max(0, Math.min(width, x));
    return Math.round((clamped / width) * duration);
  };

  const setDrag = (ms: number) => setDragPosition(ms);
  const clearDrag = () => setDragPosition(null);

  const tap = Gesture.Tap()
    .maxDuration(250)
    .onEnd((e, success) => {
      if (!success) return;
      const ms = computeMs(e.x);
      if (onSeek) runOnJS(onSeek)(ms);
    });

  // Pan gives instant haptic feedback as the user drags the playhead — only
  // commits the seek when they lift, but the visual updates live.
  const pan = Gesture.Pan()
    .minDistance(2)
    .activeOffsetX([-2, 2])
    .onUpdate((e) => {
      const ms = computeMs(e.x);
      runOnJS(setDrag)(ms);
    })
    .onEnd((e) => {
      const ms = computeMs(e.x);
      if (onSeek) runOnJS(onSeek)(ms);
      runOnJS(clearDrag)();
    })
    .onFinalize(() => {
      runOnJS(clearDrag)();
    });

  const composed = Gesture.Race(pan, tap);

  return (
    <GestureDetector gesture={composed}>
      <View
        style={[styles.touchArea, { height: height + 24 }]}
        onLayout={onLayout}
      >
        <View style={[styles.row, { height }]}>
          {heights.map((h, i) => {
            const isActive = i <= activeBars;
            return (
              <View
                key={i}
                style={[
                  styles.bar,
                  {
                    height: Math.max(3, h * height),
                    backgroundColor: isActive ? colors.text : 'rgba(255,255,255,0.22)',
                  },
                ]}
              />
            );
          })}
        </View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  // Bigger touch target than the visible bars so it's actually grabbable.
  touchArea: {
    width: '100%',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
  },
  bar: {
    width: 2,
    borderRadius: 1,
  },
});
