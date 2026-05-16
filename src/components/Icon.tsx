import React from 'react';
import Svg, { Path, Circle } from 'react-native-svg';
import { colors } from '@/theme';

// Tiny in-house icon set. Using SVGs keeps the bundle small and avoids
// adding a heavy icon font dependency for ~10 icons.

interface IconProps {
  size?: number;
  color?: string;
}

const D = (props: IconProps) => ({
  width: props.size ?? 24,
  height: props.size ?? 24,
  color: props.color ?? colors.text,
});

export const PlayIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M7 5v14l12-7L7 5z" fill={color} />
    </Svg>
  );
};

export const PauseIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M6 5h4v14H6zM14 5h4v14h-4z" fill={color} />
    </Svg>
  );
};

export const SkipIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M6 5l10 7-10 7V5zM18 5h2v14h-2z" fill={color} />
    </Svg>
  );
};

export const PrevIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M18 19l-10-7 10-7v14zM4 5h2v14H4z" fill={color} />
    </Svg>
  );
};

export const HeartIcon = (p: IconProps & { filled?: boolean }) => {
  const { width, height, color } = D(p);
  const fill = p.filled ? color : 'none';
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24">
      <Path
        d="M12 21s-7-4.5-9.5-9C.7 8.6 2.6 5 6 5c2 0 3.5 1 4 2 0.5-1 2-2 4-2 3.4 0 5.3 3.6 3.5 7-2.5 4.5-9.5 9-9.5 9z"
        stroke={color}
        strokeWidth={1.8}
        fill={fill}
      />
    </Svg>
  );
};

export const BookmarkIcon = (p: IconProps & { filled?: boolean }) => {
  const { width, height, color } = D(p);
  const fill = p.filled ? color : 'none';
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24">
      <Path d="M6 4h12v17l-6-3.5L6 21V4z" stroke={color} strokeWidth={1.8} fill={fill} />
    </Svg>
  );
};

export const SparkleIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M12 3l1.8 4.7L18 9l-4.2 1.5L12 15l-1.8-4.5L6 9l4.2-1.3L12 3z" fill={color} />
      <Path d="M19 14l0.8 1.7L21 16.5l-1.2 0.5L19 19l-0.8-2L17 16.5l1.2-0.8L19 14z" fill={color} />
    </Svg>
  );
};

export const HomeIcon = (p: IconProps & { filled?: boolean }) => {
  const { width, height, color } = D(p);
  const fill = p.filled ? color : 'none';
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24">
      <Path d="M4 11l8-7 8 7v9h-5v-6H9v6H4v-9z" stroke={color} strokeWidth={1.8} fill={fill} />
    </Svg>
  );
};

export const LibraryIcon = (p: IconProps & { filled?: boolean }) => {
  const { width, height, color } = D(p);
  const fill = p.filled ? color : 'none';
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24">
      <Path d="M5 4h2v16H5zM9 4h2v16H9zM15 4l4 1-3 14-4-1 3-14z" stroke={color} strokeWidth={1.6} fill={fill} />
    </Svg>
  );
};

export const ProfileIcon = (p: IconProps & { filled?: boolean }) => {
  const { width, height, color } = D(p);
  const fill = p.filled ? color : 'none';
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24">
      <Circle cx={12} cy={8} r={4} stroke={color} strokeWidth={1.8} fill={fill} />
      <Path d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6" stroke={color} strokeWidth={1.8} fill="none" />
    </Svg>
  );
};

export const ExploreIcon = (p: IconProps & { filled?: boolean }) => {
  const { width, height, color } = D(p);
  const fill = p.filled ? color : 'none';
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={1.8} fill={fill === color ? 'rgba(0,0,0,0.0)' : 'none'} />
      <Path d="M15.5 8.5l-2 5-5 2 2-5 5-2z" stroke={color} strokeWidth={1.6} fill={fill} />
    </Svg>
  );
};

export const FlameIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M12 3c1 3 4 4 4 8a4 4 0 11-8 0c0-2 1-3 2-4-1 4 2 3 2 6 0 0 3-1 3-4 0-3-3-4-3-6z" stroke={color} strokeWidth={1.6} fill={color} fillOpacity={0.15} />
    </Svg>
  );
};

export const TrendingIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M3 17l6-6 4 4 8-8" stroke={color} strokeWidth={2} />
      <Path d="M14 7h7v7" stroke={color} strokeWidth={2} />
    </Svg>
  );
};

export const ShuffleIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M3 7h4l10 10h4M3 17h4l10-10h4" stroke={color} strokeWidth={1.8} />
      <Path d="M18 4l3 3-3 3M18 14l3 3-3 3" stroke={color} strokeWidth={1.8} />
    </Svg>
  );
};

export const RepeatIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M4 9V7a2 2 0 012-2h12l-3-3M20 15v2a2 2 0 01-2 2H6l3 3" stroke={color} strokeWidth={1.8} />
    </Svg>
  );
};

export const ChevronDownIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M6 9l6 6 6-6" stroke={color} strokeWidth={2} />
    </Svg>
  );
};

export const ChevronLeftIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M15 6l-6 6 6 6" stroke={color} strokeWidth={2.2} />
    </Svg>
  );
};

export const CloseIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M6 6l12 12M18 6L6 18" stroke={color} strokeWidth={2} />
    </Svg>
  );
};

export const ShareIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M12 3v13M12 3l-4 4M12 3l4 4" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
};

export const CommentIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path
        d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"
        stroke={color}
        strokeWidth={1.8}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </Svg>
  );
};

/**
 * Lyrics icon — speech bubble with three lines inside, signalling
 * "this song has lyrics you can read along to". Used in the player
 * action column to open the immersive lyrics sheet.
 */
export const LyricsIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      {/* Speech-bubble outline */}
      <Path
        d="M4 6a3 3 0 013-3h10a3 3 0 013 3v8a3 3 0 01-3 3H9l-4 4v-4H7a3 3 0 01-3-3V6z"
        stroke={color}
        strokeWidth={1.7}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Three lyric lines inside */}
      <Path d="M8 8.5h8"  stroke={color} strokeWidth={1.6} strokeLinecap="round" />
      <Path d="M8 11.5h6" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
      <Path d="M8 14.5h5" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
};

export const MoreIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Circle cx={5} cy={12} r={1.6} fill={color} />
      <Circle cx={12} cy={12} r={1.6} fill={color} />
      <Circle cx={19} cy={12} r={1.6} fill={color} />
    </Svg>
  );
};

// --- Paywall feature icons ---

export const InfinityIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path
        d="M7 12c0-2 1.5-3.5 3.5-3.5S13 12 13 12s1.5 3.5 3.5 3.5S20 14 20 12s-1.5-3.5-3.5-3.5S13 12 13 12s-1.5 3.5-3.5 3.5S6 14 7 12z"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
      />
    </Svg>
  );
};

export const BoltIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M13 2L5 14h6l-2 8 9-12h-6l1-8z" stroke={color} strokeWidth={1.6} strokeLinejoin="round" fill={color} fillOpacity={0.15} />
    </Svg>
  );
};

export const DownloadIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M12 4v12M12 16l-4-4M12 16l4-4" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M5 19h14" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
};

export const WaveformIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M6 10v4M9 7v10M12 4v16M15 7v10M18 10v4" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
};

export const ArrowRightIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M5 12h14M14 6l6 6-6 6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
};

export const SearchIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path
        d="M21 21l-4.3-4.3M11 18a7 7 0 100-14 7 7 0 000 14z"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
};

// --- Brand icons (Apple / Google / Facebook) ---
// These follow each brand's logo guidelines closely enough for buttons;
// production builds should consider using the official asset packs.

export const AppleIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill={color}>
      <Path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.46 1.58-1.5 3.12-.91 1.33-1.85 2.65-3.33 2.68-1.45.03-1.92-.84-3.57-.84-1.66 0-2.18.81-3.55.87-1.42.05-2.5-1.43-3.42-2.76-1.89-2.71-3.34-7.66-1.39-11 .95-1.65 2.65-2.69 4.5-2.72 1.4-.03 2.71.94 3.57.94.83 0 2.46-1.16 4.13-.99.69.03 2.65.28 3.92 2.11-.1.05-2.33 1.35-2.31 4.02.03 3.18 2.86 4.25 2.93 4.27.01.04.04.13.06.21z" />
    </Svg>
  );
};

export const GoogleIcon = (p: IconProps) => {
  const { width, height } = D(p);
  // Official Google G mark — multi-color paths.
  return (
    <Svg width={width} height={height} viewBox="0 0 48 48">
      <Path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4C12.955 4 4 12.955 4 24s8.955 20 20 20s20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
      <Path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4C16.318 4 9.656 8.337 6.306 14.691z" />
      <Path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
      <Path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
    </Svg>
  );
};

export const FacebookIcon = (p: IconProps) => {
  const { width, height } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24">
      <Path
        fill="#1877F2"
        d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669c1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073"
      />
      <Path
        fill="#fff"
        d="M16.671 15.543l.532-3.47h-3.328v-2.25c0-.949.465-1.874 1.956-1.874h1.513V4.996s-1.374-.235-2.686-.235c-2.741 0-4.533 1.662-4.533 4.669v2.643H7.078v3.47h3.047v8.385a12.118 12.118 0 0 0 3.75 0v-8.385z"
      />
    </Svg>
  );
};

export const TikTokIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill={color}>
      <Path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74a2.89 2.89 0 0 1 2.31-4.64a2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43V8.81a8.16 8.16 0 0 0 4.77 1.52V6.88a4.85 4.85 0 0 1-1.84-.19" />
    </Svg>
  );
};

export const CheckIcon = (p: IconProps) => {
  const { width, height, color } = D(p);
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M5 12l5 5L20 7" stroke={color} strokeWidth={2.2} />
    </Svg>
  );
};
