import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, fonts, metals } from '@/theme';

// Artwork — an image that always renders something.
//
// Catalog rows frequently ship without a cover_url / artist_image_url, and a
// remote URL can also 404. Instead of leaving an empty grey square, this
// component falls back to a deterministic dark gradient tile stamped with the
// first initial of the song / artist name. The gradient is seeded by the
// name so the same artist always gets the same tile across the app.

interface ArtworkProps {
  /** Remote image URL. Missing / empty / failed -> initial fallback. */
  uri?: string | null;
  /** Song title or artist name. Drives the initial + gradient seed. */
  name?: string | null;
  /** Fixed square side. Ignored when `fill` is set. */
  size?: number;
  /** Absolute-fill mode for full-bleed surfaces (the artist hero). */
  fill?: boolean;
  /** Corner radius. Ignored when `circle` is set. */
  radius?: number;
  /** Render as a circle (avatars). */
  circle?: boolean;
  /** expo-image recycling hint for list rows. */
  recyclingKey?: string;
  style?: StyleProp<ViewStyle>;
}

// Restrained dark gradient pairs — all within the Boulevard graphite/charcoal
// range so a fallback tile never looks like a bright sticker on the dark UI.
const DARK_PAIRS: [string, string][] = [
  ['#2a2a33', '#15151a'],
  ['#2c2620', '#17130f'],
  ['#1f2731', '#13171d'],
  ['#29212c', '#161219'],
  ['#1f2a27', '#131816'],
  ['#262a30', '#141619'],
];

function pairFor(seed: string): [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return DARK_PAIRS[Math.abs(h) % DARK_PAIRS.length];
}

function initialOf(name?: string | null): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '♪'; // music note when there is genuinely no name
  const ch = trimmed[0];
  return /[a-z0-9]/i.test(ch) ? ch.toUpperCase() : ch;
}

export function Artwork({
  uri,
  name,
  size,
  fill = false,
  radius = 8,
  circle = false,
  recyclingKey,
  style,
}: ArtworkProps) {
  const [failed, setFailed] = useState(false);
  // A new uri gets a fresh chance to load — clear any prior failure.
  useEffect(() => { setFailed(false); }, [uri]);

  const side = size ?? 0;
  const cornerRadius = circle ? (fill ? 0 : side / 2) : radius;

  const boxStyle: StyleProp<ViewStyle> = fill
    ? [StyleSheet.absoluteFill as ViewStyle, style]
    : [{ width: side, height: side, borderRadius: cornerRadius, overflow: 'hidden' }, style];

  const showImage = !!uri && !failed;

  if (showImage) {
    return (
      <View style={boxStyle}>
        <Image
          source={{ uri: uri as string }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={150}
          recyclingKey={recyclingKey ?? uri}
          onError={() => setFailed(true)}
        />
      </View>
    );
  }

  const [from, to] = pairFor(name ?? recyclingKey ?? 'boulevard');
  // Initial scales with the tile; full-bleed hero uses a large fixed size.
  const initialSize = fill ? 72 : Math.max(11, Math.round(side * 0.4));

  return (
    <View style={boxStyle}>
      <LinearGradient
        colors={[from, to]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Hairline gold catch-light along the top edge, matching the
          platinum/gold treatment used on Boulevard cards. */}
      <LinearGradient
        colors={[metals.glassHi, 'transparent']}
        locations={[0, 0.5]}
        style={styles.gloss}
        pointerEvents="none"
      />
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={styles.center}>
          <Text style={[styles.initial, { fontSize: initialSize }]}>
            {initialOf(name)}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  gloss: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: '45%',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: {
    color: metals.goldSolidHi,
    fontWeight: fonts.weight.bold,
    letterSpacing: 0.5,
    opacity: 0.92,
    backgroundColor: 'transparent',
    // Subtle lift so the letter reads against the gradient.
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
