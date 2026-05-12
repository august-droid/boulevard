// Boulevard theme — dark, premium, mainstream.
// Restrained. Cinematic. Luxury but mainstream.
// Inspired by premium watch dials and high-end automotive interiors —
// platinum, graphite, and warm muted gold. Never neon.

export const colors = {
  bg: '#0a0a0c',
  bgElevated: '#141418',
  surface: '#16161b',
  surfaceHover: '#1f1f25',
  // Standard hairline border. Ultra-subtle by default.
  border: 'rgba(255,255,255,0.06)',
  divider: 'rgba(255,255,255,0.04)',

  text: '#ffffff',
  textMuted: 'rgba(255,255,255,0.62)',
  textDim: 'rgba(255,255,255,0.38)',

  // A warm off-white accent — premium and mainstream, not neon.
  accent: '#ffffff',
  accentMuted: 'rgba(255,255,255,0.85)',

  // Brand purple used sparingly (paywall, level meter).
  brand: '#8a7bff',
  brandDim: 'rgba(138,123,255,0.18)',

  like: '#ff5a7a',
  success: '#4ade80',
  danger: '#ef4444',

  scrim: 'rgba(0,0,0,0.5)',
};

// Premium metallic palette — used for outlines, highlights, and glass
// reflections. Never as a fill on large surfaces. Apply with low alpha so
// it reads as a subtle catch-light, not a color.
//
// The "warm" set carries the Boulevard brand temperature — gentle gold/copper
// pulled directly out of the logo's brushed-bronze "B". Use it on:
//   • active tab labels (text tint)
//   • progress / hairline accents
//   • selection states on plan / vibe pills
//   • the gold seed (faint ::before glow under section titles, etc.)
// The "cool" set (platinum) carries hairline outlines and neutral structure.
export const metals = {
  // Cool brushed silver. Goes on container outlines.
  platinum: 'rgba(216, 220, 228, 0.18)',
  platinumHi: 'rgba(244, 246, 250, 0.28)',
  platinumLo: 'rgba(120, 124, 134, 0.10)',

  // Slightly darker neutral — pairs with platinum for depth.
  graphite: 'rgba(64, 64, 72, 0.45)',
  graphiteHi: 'rgba(110, 110, 122, 0.30)',
  graphiteLo: 'rgba(20, 20, 24, 0.85)',

  // Warm muted gold pulled from the Boulevard logo's brushed bronze.
  gold: 'rgba(200, 174, 122, 0.32)',
  goldHi: 'rgba(218, 192, 140, 0.55)',
  goldLo: 'rgba(120, 100, 70, 0.20)',
  // Solid (alpha-1) hex — for text tints and small filled accents where
  // the rgba versions would disappear. Use sparingly.
  goldSolid: '#c8ae7a',
  goldSolidHi: '#e0c898',

  // Soft glass highlight — for inner top edges of containers.
  glassHi: 'rgba(255, 255, 255, 0.06)',
  glassLo: 'rgba(255, 255, 255, 0.00)',
};

export const radii = {
  sm: 8,
  md: 12,
  lg: 18,
  xl: 28,
  pill: 999,
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const fonts = {
  // System fonts feel native and premium on both iOS and Android.
  regular: undefined as string | undefined,
  weight: {
    regular: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
  },
  size: {
    xs: 11,
    sm: 13,
    md: 15,
    lg: 17,
    xl: 22,
    xxl: 28,
    display: 34,
  },
};
