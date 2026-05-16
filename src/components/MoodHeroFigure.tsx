import React from 'react';
import Svg, { Path, Ellipse, Circle, G, Defs, RadialGradient, Stop } from 'react-native-svg';

// Decorative illustration for the "Made for your mood" Explore banner — a
// listener lost in a track, eyes-closed, wearing over-ear headphones, with a
// few notes drifting up. Drawn as an SVG silhouette so it scales crisply and
// adds no image asset / bandwidth. Tuned to read against the gold banner:
// near-black figure, a soft light bloom behind the head, gold note accents.

const INK = '#1a1408';        // matches the banner's ink text
const GOLD = '#e9d4a4';       // light gold for note accents

interface Props {
  /** Rendered height in px. Width scales with the 132×150 viewBox. */
  height?: number;
}

export function MoodHeroFigure({ height = 132 }: Props) {
  const width = Math.round((height * 132) / 150);
  return (
    <Svg width={width} height={height} viewBox="0 0 132 150" fill="none">
      <Defs>
        <RadialGradient id="bloom" cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#ffffff" stopOpacity={0.45} />
          <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
        </RadialGradient>
      </Defs>

      {/* Soft light bloom behind the head — the "in the zone" glow. */}
      <Circle cx={66} cy={66} r={56} fill="url(#bloom)" />

      {/* Drifting notes. */}
      <G opacity={0.92}>
        <Ellipse cx={20} cy={44} rx={6} ry={4.6} fill={GOLD} transform="rotate(-18 20 44)" />
        <Path d="M25 43V20l8-3" stroke={GOLD} strokeWidth={3} strokeLinecap="round" />
        <Ellipse cx={112} cy={30} rx={5} ry={4} fill={GOLD} transform="rotate(-18 112 30)" />
        <Path d="M116 29V12l6-2" stroke={GOLD} strokeWidth={2.6} strokeLinecap="round" />
      </G>

      {/* Shoulders / torso. */}
      <Path
        d="M22 150c0-30 14-46 44-46s44 16 44 46Z"
        fill={INK}
      />

      {/* Head. */}
      <Ellipse cx={66} cy={70} rx={28} ry={30} fill={INK} />

      {/* Content half-smile + closed eye, lightly etched so the listener
          reads as enjoying the music rather than a blank silhouette. */}
      <Path d="M58 66c3 3 9 3 12 0" stroke={GOLD} strokeWidth={2.4} strokeLinecap="round" opacity={0.55} />
      <Path d="M60 84c4 3 12 3 16-1" stroke={GOLD} strokeWidth={2.6} strokeLinecap="round" opacity={0.5} />

      {/* Over-ear headphones — band across the top, an ear cup each side. */}
      <Path
        d="M30 70C30 32 102 32 102 70"
        stroke={INK}
        strokeWidth={9}
        strokeLinecap="round"
      />
      <Path d="M30 70C30 32 102 32 102 70" stroke={GOLD} strokeWidth={2.4} strokeLinecap="round" opacity={0.5} />
      <G>
        <Path d="M24 60h10a4 4 0 014 4v18a4 4 0 01-4 4H24Z" fill={INK} />
        <Path d="M108 60H98a4 4 0 00-4 4v18a4 4 0 004 4h10Z" fill={INK} />
        <Circle cx={29} cy={73} r={4.2} fill={GOLD} opacity={0.6} />
        <Circle cx={103} cy={73} r={4.2} fill={GOLD} opacity={0.6} />
      </G>
    </Svg>
  );
}
