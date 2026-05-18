import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Share,
  StyleSheet,
  Dimensions,
  Platform,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  GestureHandlerRootView,
  GestureDetector,
  Gesture,
} from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { usePlayer, usePlayerProgress } from '@/contexts/PlayerContext';
import { useFollows } from '@/contexts/FollowsContext';
import { usePlaylists } from '@/contexts/PlaylistsContext';
import { useComments, topPositiveComments, fallbackHandle, avatarColor } from '@/contexts/CommentsContext';
import { useAuth } from '@/contexts/AuthContext';
import { useAppNav, SignupReason } from '@/contexts/NavigationContext';
import type { SongComment } from '@/types';
import { PlaylistPicker } from '@/components/PlaylistPicker';
import { PlatinumProgressBar } from '@/components/PlatinumProgressBar';
import { Artwork } from '@/components/Artwork';
import { songArtworkUri } from '@/lib/artwork';
import {
  PlayIcon,
  PauseIcon,
  SkipIcon,
  PrevIcon,
  ShareIcon,
  BookmarkIcon,
  SparkleIcon,
  ShuffleIcon,
  ChevronDownIcon,
  MoreIcon,
  HeartIcon,
} from '@/components/Icon';
import { CreateVibeSheet } from '@/screens/CreateVibeSheet';
import { HeartBurst, HeartBurstHandle } from '@/components/HeartBurst';
import { PlayerSheet, PlayerSheetHandle, PLAYER_SHEET_PEEK } from '@/components/PlayerSheet';
import { ScrollingTitle } from '@/components/ScrollingTitle';
import { resolveArtistImage, formatCount } from '@/lib/artists/artistData';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// "Now playing" full-bleed view.
//
// Cover art fills the screen. A long bottom gradient fades into pure black so
// the controls sit on a clean dark surface and the bottom nav (which is
// rendered above this screen) reads as part of the same composition.

export function PlayerFeedScreen({ onDismiss }: { onDismiss?: () => void } = {}) {
  const player = usePlayer();
  const progress = usePlayerProgress();
  const insets = useSafeAreaInsets();
  const { playlists } = usePlaylists();
  const comments = useComments();
  const auth = useAuth();
  const nav = useAppNav();
  const [vibeOpen, setVibeOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const playerSheetRef = React.useRef<PlayerSheetHandle>(null);
  const heartBurstRef = React.useRef<HeartBurstHandle>(null);
  // Docked BottomNav height (mirrors RootNavigator's NAV_HEIGHT). The
  // comments / lyrics sheet docks just above it.
  const navHeight = 56 + Math.max(insets.bottom, 8);

  // Gate every engagement-write action behind signup. Anonymous users
  // can listen freely but cannot save, like, follow, or comment.
  // Tapping any of these bounces them to the SignupSheet. Reading +
  // playing is intentionally unblocked so the discovery loop stays
  // friction-free.
  const requireSignup = useCallback((reason?: SignupReason): boolean => {
    if (auth.isAnonymous) {
      nav.openSignup(reason);
      return true;
    }
    return false;
  }, [auth.isAnonymous, nav]);

  // Bookmark icon fills when the current song lives in any user playlist.
  const currentSongId = player.current?.id ?? null;
  const inAnyPlaylist = !!currentSongId && playlists.some((p) => p.song_ids.includes(currentSongId));

  // Like state + action live on the PlayerContext now. Persists to
  // user_song_likes and feeds a 'like' signal into the taste profile.
  const liked = player.liked;
  // The heart is a "send love" button, not a strict toggle: every tap
  // releases a flying heart, and a tap only ever LIKES (never unlikes), so
  // the user can tap it as many times as they like for the animation.
  const toggleLike = useCallback(() => {
    if (!currentSongId) return;
    if (requireSignup('like')) return;
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    heartBurstRef.current?.spawn();
    if (!player.liked) void player.like();
  }, [currentSongId, player, requireSignup]);

  const openPicker = useCallback(() => {
    if (!currentSongId) return;
    if (requireSignup('playlist')) return;
    setPickerOpen(true);
  }, [currentSongId, requireSignup]);

  // Lazily prefetch comments when the song changes so the sheet teaser +
  // drift overlay reflect reality without waiting for the sheet to open.
  useEffect(() => {
    if (currentSongId && comments.loadedSongId !== currentSongId) {
      void comments.loadFor(currentSongId);
    }
  }, [currentSongId, comments]);

  const skip = useCallback(() => {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    player.skip();
  }, [player]);

  const goPrevious = useCallback(() => {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    void player.previous();
  }, [player]);

  // Small synchronous tap feedback used on every transport button. Fires the
  // haptic on press-in (not on press-up) so the buzz lands the instant the
  // user's finger touches the screen — same trick Spotify uses.
  const tapFeedback = useCallback(() => {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
  }, []);

  const onShare = useCallback(async () => {
    const s = player.current;
    if (!s) return;
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    try {
      const result = await Share.share(
        {
          // The URL is the most important piece — both iOS and Android pass it
          // through to social apps so they can render link previews. The
          // message is what shows up if the target only accepts plain text.
          message: `Listening to "${s.title}" on Boulevard`,
          url: s.audio_url,
          title: s.title,
        },
        { dialogTitle: 'Share song', subject: `Boulevard · ${s.title}` },
      );
      // Only treat as a real share when the sheet didn't bounce back as
      // dismissed — otherwise we'd reward the cancel button.
      if (result.action === Share.sharedAction) {
        await player.recordShare();
      }
    } catch {
      // Native sheet failed (unavailable, no targets) — silently ignore.
    }
  }, [player]);

  // Swipe gestures on the cover:
  //   • down  → dismiss the full-screen player
  //   • up    → next song
  //   • left  → next song (TikTok-style)
  //   • right → previous song
  // The transport row sits outside this detector so taps on the controls
  // always win. The comments / lyrics sheet owns its own gesture.
  const pan = Gesture.Pan().onEnd((e) => {
    if (e.translationY > 100 && Math.abs(e.translationX) < 80) {
      if (onDismiss) runOnJS(onDismiss)();
      return;
    }
    if (e.translationY < -80 && Math.abs(e.translationX) < 80) {
      runOnJS(skip)();
      return;
    }
    if (Math.abs(e.translationY) < 60) {
      if (e.translationX < -80) runOnJS(skip)();
      else if (e.translationX > 80) runOnJS(goPrevious)();
    }
  });

  const song = player.current;

  // The artist portrait is denormalized per-song and frequently missing on a
  // given row — resolve it across the whole catalog so the player pill always
  // shows the same photo as the artist page.
  const artistImageUrl = useMemo(
    () => resolveArtistImage(player.catalog, song?.artist_id),
    [player.catalog, song?.artist_id],
  );

  return (
    <GestureHandlerRootView style={styles.root}>
      <View style={styles.coverWrap}>
        {song ? (
          <>
            {/* Persistent backdrop. Same artwork as the animated foreground,
                scaled up, blurred, darkened. Fills the entire screen so
                that when the foreground Ken-Burns layer translates or
                briefly fades during a song swap, the user never sees a
                black edge or empty container — they see a soft blurred
                version of the same image. Does NOT animate. */}
            <ArtworkBackdrop uri={songArtworkUri(song)} songId={song.id} />
            {/* Always the song's own bespoke cover. The artist portrait is a
                separate asset (shown only on the artist pill / profile) — it
                must never stand in for a song's artwork. songArtworkUri()
                owns this precedence app-wide. */}
            <KenBurnsCover uri={songArtworkUri(song)} songId={song.id} />
            {/* Hairline glass reflection on the very top. */}
            <LinearGradient
              colors={[metals.glassHi, 'transparent']}
              locations={[0, 0.18]}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <LinearGradient
              colors={[
                'rgba(10,10,12,0)',
                'rgba(10,10,12,0.25)',
                'rgba(10,10,12,0.70)',
                'rgba(10,10,12,0.92)',
                '#0a0a0c',
              ]}
              locations={[0.30, 0.45, 0.62, 0.82, 1]}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            {/* Dedicated heavier scrim under the controls zone — sits on top
                of the wide gradient and ensures buttons + waveform always
                read cleanly regardless of how busy the cover art is. */}
            <LinearGradient
              colors={['transparent', 'rgba(10,10,12,0.55)', 'rgba(10,10,12,0.92)']}
              locations={[0, 0.4, 1]}
              style={styles.controlsScrim}
              pointerEvents="none"
            />
            <GestureDetector gesture={pan}>
              {/* Capture swipes everywhere above the controls. */}
              <View style={styles.swipeZone} />
            </GestureDetector>
          </>
        ) : (
          <View style={[styles.cover, { backgroundColor: colors.surface }]} />
        )}
      </View>

      {/* Top bar — chevron, breathing brand logo, overflow menu. */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable hitSlop={12} onPress={() => onDismiss?.()} style={styles.iconBtn}>
          <ChevronDownIcon size={22} color={colors.text} />
        </Pressable>
        <BreathingBrandMark />
        <Pressable hitSlop={12} onPress={() => setVibeOpen(true)} style={styles.iconBtn}>
          <MoreIcon size={20} color={colors.text} />
        </Pressable>
      </View>

      {/* Drift comments — top-5 positive/neutral comments float in one
          at a time over the artwork, starting 30s into the song. Tap to
          open the comments sheet. Hidden when there's nothing to show. */}
      {currentSongId && comments.loadedSongId === currentSongId ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <DriftComments
            songId={currentSongId}
            comments={comments.topLevel}
            currentUserId={auth.userId}
            profilesByUserId={comments.profiles}
            elapsedMs={progress.position}
            bottomOffset={insets.bottom + 280}
            onTapOpen={() => playerSheetRef.current?.expand()}
          />
        </View>
      ) : null}

      {/* Bottom content stack. */}
      <View
        style={[
          styles.bottomStack,
          // Reserve room for the BottomNav + the collapsed comments sheet
          // docked above it, so the controls never sit behind the sheet.
          { paddingBottom: navHeight + PLAYER_SHEET_PEEK + spacing.sm },
        ]}
      >
        <View style={styles.titleBlock}>
          <ScrollingTitle text={song?.title ?? ''} style={styles.title} />
          <View style={styles.artistRow}>
            <Pressable
              onPress={() => {
                if (!song?.artist_id) return;
                if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
                nav.openArtistProfile(song.artist_id);
                // The artist page renders beneath this full-screen player
                // overlay — dismiss the player so it becomes visible.
                onDismiss?.();
              }}
              disabled={!song?.artist_id}
              style={({ pressed }) => [
                styles.brandPill,
                !!song?.artist_id && styles.brandPillArtist,
                pressed && !!song?.artist_id && { opacity: 0.7 },
              ]}
              accessibilityLabel={song?.artist_id ? 'Open artist' : undefined}
            >
              {song?.artist_id ? (
                // Small circular artist photo — instantly recognizable,
                // replaces the old "Artist:" text label.
                <Artwork
                  uri={artistImageUrl}
                  name={song.artist_name}
                  size={20}
                  circle
                  recyclingKey={song.artist_id}
                />
              ) : (
                <SparkleIcon size={11} color={metals.goldHi} />
              )}
              <Text style={styles.brandPillText} numberOfLines={1}>
                {song ? formatGenrePill(song) : 'Boulevard Original'}
              </Text>
            </Pressable>
            {song?.artist_id ? <FollowPill artistId={song.artist_id} /> : null}
          </View>
        </View>

        {/* Boulevard Connect — another device of this account owns playback.
            The transport below still works (it remote-controls that device);
            "Play here" moves playback onto this device. */}
        {player.playbackMode === 'remote' ? (
          <View style={styles.connectBar}>
            <View style={styles.connectDot} />
            <Text style={styles.connectText} numberOfLines={1}>
              Playing on {player.activeDeviceLabel ?? 'another device'}
            </Text>
            <Pressable
              onPress={() => { void player.takeOverPlayback(); }}
              style={({ pressed }) => [styles.connectBtn, pressed && { opacity: 0.7 }]}
              accessibilityLabel="Play on this device"
            >
              <Text style={styles.connectBtnText}>Play here</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Transport row — playback controls only. Shuffle pins to the left
            edge; prev / play / skip ride as one centered cluster, balanced
            by an equal-width spacer on the right so the big play button
            sits dead-center. The secondary actions (like, save, share) all
            live together in the right-hand rail. */}
        <View style={styles.transport}>
          <Pressable
            hitSlop={14}
            onPressIn={tapFeedback}
            onPress={() => player.toggleShuffle()}
            style={({ pressed }) => [styles.transportSide, pressed && styles.transportPressed]}
            accessibilityLabel="Shuffle"
          >
            <ShuffleIcon size={22} color={player.isShuffling ? metals.goldSolidHi : colors.text} />
          </Pressable>
          <View style={styles.transportCore}>
            <Pressable
              hitSlop={14}
              onPressIn={tapFeedback}
              onPress={() => player.previous()}
              style={({ pressed }) => pressed ? styles.transportPressed : undefined}
            >
              <PrevIcon size={28} color={colors.text} />
            </Pressable>
            <Pressable
              hitSlop={14}
              onPressIn={tapFeedback}
              onPress={() => player.togglePlay()}
              style={({ pressed }) => [styles.playBtn, pressed && styles.playBtnPressed]}
              accessibilityRole="button"
              accessibilityLabel={player.isPlaying ? 'Pause' : 'Play'}
            >
              <View style={styles.playInner}>
                {player.isPlaying
                  ? <PauseIcon size={26} color={colors.text} />
                  : <PlayIcon size={26} color={colors.text} />}
              </View>
            </Pressable>
            <Pressable
              hitSlop={14}
              onPressIn={tapFeedback}
              onPress={skip}
              style={({ pressed }) => pressed ? styles.transportPressed : undefined}
            >
              <SkipIcon size={28} color={colors.text} />
            </Pressable>
          </View>
          {/* Equal-width spacer mirrors the shuffle slot so prev/play/skip
              stay optically centered. */}
          <View style={styles.transportSide} />
        </View>

        {/* Platinum→gold progress bar — sits between the transport row and
            the bottom nav. Tap or drag to seek. Total duration label sits
            against the right edge so the user always knows the song's length. */}
        <View style={styles.progressBarWrap}>
          <PlatinumProgressBar
            position={progress.position}
            duration={progress.duration}
            onSeek={(ms) => player.seek(ms)}
          />
          <View style={styles.progressMetaRow}>
            <Text style={styles.progressMetaText}>{formatTime(progress.duration)}</Text>
          </View>
        </View>
      </View>

      {/* Vertical action column — the three secondary actions (Like / Save /
          Share) grouped as one evenly-spaced rail on the right edge, so they
          read as a deliberate cluster instead of single icons scattered down
          the screen. `box-none` lets taps fall through everywhere that isn't
          a button. */}
      <View
        style={[
          styles.actionColumn,
          // Anchored so the BOTTOM icon (Share) clears the transport row;
          // the rail then grows upward as one evenly-spaced group.
          { bottom: insets.bottom + 260 },
        ]}
        pointerEvents="box-none"
      >
        <View style={styles.likeSlot}>
          <Pressable hitSlop={10} onPressIn={tapFeedback} onPress={toggleLike} style={({ pressed }) => [styles.actionBtn, pressed && styles.transportPressed]} accessibilityLabel={liked ? 'Liked' : 'Like'}>
            <HeartIcon size={28} color={liked ? colors.like : colors.text} filled={liked} />
            {(song?.like_count ?? 0) > 100 ? <Text style={styles.actionCount}>{formatCount(song?.like_count ?? 0)}</Text> : null}
          </Pressable>
          <HeartBurst ref={heartBurstRef} />
        </View>
        <Pressable hitSlop={10} onPressIn={tapFeedback} onPress={openPicker} style={({ pressed }) => [styles.actionBtn, pressed && styles.transportPressed]} accessibilityLabel={inAnyPlaylist ? 'Edit playlists' : 'Save to playlist'}>
          <BookmarkIcon size={26} color={inAnyPlaylist ? metals.goldSolidHi : colors.text} filled={inAnyPlaylist} />
          {(song?.save_count ?? 0) > 100 ? <Text style={styles.actionCount}>{formatCount(song?.save_count ?? 0)}</Text> : null}
        </Pressable>
        <Pressable hitSlop={10} onPressIn={tapFeedback} onPress={onShare} style={({ pressed }) => [styles.actionBtn, pressed && styles.transportPressed]} accessibilityLabel="Share">
          <ShareIcon size={25} color={colors.text} />
          {(song?.share_count ?? 0) > 100 ? <Text style={styles.actionCount}>{formatCount(song?.share_count ?? 0)}</Text> : null}
        </Pressable>
      </View>

      {/* Comments + lyrics bottom sheet. Collapsed teaser by default;
          swipe up or tap to open. Comments tab first, lyrics second. */}
      <PlayerSheet
        ref={playerSheetRef}
        song={song}
        songId={currentSongId}
        navHeight={navHeight}
        onSeek={(ms) => player.seek(ms)}
      />

      <CreateVibeSheet visible={vibeOpen} onClose={() => setVibeOpen(false)} />
      <PlaylistPicker visible={pickerOpen} songId={currentSongId} onClose={() => setPickerOpen(false)} />
    </GestureHandlerRootView>
  );
}

// ---- helpers ---------------------------------------------------------

function formatTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

/**
 * The brand-pill text. When the song has an artist we show the bare artist
 * name — the small circular artist photo next to it already signals "this is
 * a person you can open / follow", so no "Artist:" prefix is needed. Falls
 * back to a cleaned cross-genre label when the song has no artist (legacy /
 * test rows).
 */
function formatGenrePill(song: { genre?: string; genres?: string[]; artist_name?: string | null }): string {
  if (song.artist_name) return song.artist_name;
  let label = song.genre ?? 'Boulevard Original';
  if (label === 'Viral Mashup' && song.genres && song.genres.length > 1) {
    label = cleanCrossGenre(song.genres[1]);
  }
  return label;
}

function cleanCrossGenre(raw: string): string {
  // "Modern-Country x Trap" → "Country × Trap" — only used in the artist-less
  // fallback above; kept around in case we want to surface the cross-genre
  // tag in another part of the UI later.
  const parts = raw.split(/\s+x\s+/i).map((p) => p.split('-')[0]?.trim()).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]} × ${parts[1]}`;
  return raw;
}

// ---- Breathing brand mark -------------------------------------------
//
// Subtle "boulevard" wordmark at the top of the now-playing surface. Loops
// a slow opacity pulse so the screen feels alive even when the cover is
// motionless. Deliberately quiet — the cover art is the hero; this is just
// a soft signature.

// ---- Artwork backdrop ------------------------------------------------
//
// Static blurred fill that sits behind the animated cover so the screen
// is never left with a black edge when the Ken-Burns transform translates
// or scales. Same image as the foreground, slightly larger so its own
// edges never appear, blurred and darkened. No animation. Memoized on
// the artwork uri so progress ticks never re-render or reload it.

function ArtworkBackdropBase({ uri, songId }: { uri: string | null; songId: string }) {
  // Memoize the source object so referential equality survives parent
  // re-renders. Without this, every `{ uri }` literal is a new object
  // reference and expo-image may treat it as a new source.
  const source = React.useMemo(() => ({ uri: uri ?? undefined }), [uri]);
  return (
    <View style={styles.backdrop} pointerEvents="none">
      <Image
        source={source}
        style={styles.backdropImage}
        contentFit="cover"
        cachePolicy="memory-disk"
        // Match the Ken-Burns layer's crossfade so a song swap doesn't
        // animate the backdrop and foreground out of sync.
        transition={220}
        recyclingKey={songId}
        blurRadius={48}
      />
      <View style={styles.backdropTint} pointerEvents="none" />
    </View>
  );
}

const ArtworkBackdrop = React.memo(
  ArtworkBackdropBase,
  (prev, next) => prev.uri === next.uri && prev.songId === next.songId,
);

// ---- Ken Burns cover -------------------------------------------------
//
// Slow zoom + drift on the hero cover so the screen feels alive without
// adding new assets, bandwidth, or per-frame React work. Everything runs
// on the UI thread via Reanimated worklets, zero impact on the JS thread
// that handles audio playback. The animation is driven by shared values
// so swapping `song.cover_url` does NOT restart the loop (avoids any
// stutter when the next song begins decoding).
//
// Memoized on `uri` + `songId`: the parent re-renders on every position
// tick and we never want the Image to remount or reload mid-track. The
// recyclingKey is the song id, so each song shows its own bespoke cover.

function KenBurnsCoverBase({ uri, songId }: { uri: string | null; songId: string }) {
  const scale = useSharedValue(1.08);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const opacity = useSharedValue(1);

  // Memoize the source so the parent's per-tick re-render never hands the
  // Image a fresh source literal.
  const source = React.useMemo(() => ({ uri: uri ?? undefined }), [uri]);

  useEffect(() => {
    // Slow breathing zoom. Min scale 1.08, max 1.22 — keeping the floor
    // above 1.00 means the translate values can never expose the edge
    // of the underlying container regardless of phase combination, which
    // is what produced the black-on-the-left flicker users were seeing.
    scale.value = withRepeat(
      withTiming(1.22, { duration: 8000, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    // Drift sideways. Different period so the two never sync up. Kept
    // small relative to the over-scale so the image still fills its
    // container at every frame.
    tx.value = withRepeat(
      withTiming(28, { duration: 11000, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    ty.value = withRepeat(
      withTiming(-22, { duration: 13000, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    // No cleanup. We intentionally let the animation persist across
    // re-renders and song swaps. Reanimated tears these down on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { scale: scale.value },
      { translateX: tx.value },
      { translateY: ty.value },
    ],
  }));

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.coverClip, animatedStyle]}
      pointerEvents="none"
    >
      <Image
        source={source}
        style={styles.cover}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={220}
        recyclingKey={songId}
      />
    </Animated.View>
  );
}

const KenBurnsCover = React.memo(
  KenBurnsCoverBase,
  (prev, next) => prev.uri === next.uri && prev.songId === next.songId,
);

// ---- Follow / Unfollow pill ------------------------------------------
//
// Sits next to the genre·artist pill. Tap toggles follow status. When
// followed, the artist's new songs surface in Library → From Your Follows
// and (when push notifications are wired) a notification fires on release.

function FollowPill({ artistId }: { artistId: string }) {
  const follows = useFollows();
  const auth = useAuth();
  const nav = useAppNav();
  const following = follows.isFollowing(artistId);
  return (
    <Pressable
      onPress={() => {
        // Following an artist writes to user_followed_artists and is a
        // social action — gated the same way as save / like / comment.
        if (auth.isAnonymous) { nav.openSignup('follow'); return; }
        void follows.toggleFollow(artistId);
      }}
      hitSlop={8}
      style={({ pressed }) => [
        styles.followPill,
        following && styles.followPillOn,
        pressed && { opacity: 0.85 },
      ]}
      accessibilityLabel={following ? 'Unfollow artist' : 'Follow artist'}
    >
      <Text style={[styles.followPillText, following && styles.followPillTextOn]}>
        {following ? '✓ Following' : '+ Follow'}
      </Text>
    </Pressable>
  );
}

function BreathingBrandMark() {
  const opacity = useSharedValue(0.65);

  useEffect(() => {
    // ~3.6s out, ~3.6s back, forever. inOut easing makes the turnaround
    // feel like breath rather than a bounce.
    opacity.value = withRepeat(
      withTiming(0.95, { duration: 3600, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View style={[styles.brandRow, style]}>
      <Image
        source={require('../../assets/icon.png')}
        style={styles.brandIcon}
        contentFit="contain"
        cachePolicy="memory-disk"
      />
      <Text style={styles.brandWordmark} allowFontScaling={false}>
        BOULEVARD
      </Text>
    </Animated.View>
  );
}

// ---- Drift comments ---------------------------------------------------
//
// Floating TikTok-style comment that appears over the artwork while the
// song plays. Cycles the top-5 most-liked positive/neutral comments:
// one fades in, sits for ~5s, fades out, the next one fades in. Tap
// opens the full comments sheet.
//
// The overlay stays hidden until the listener is 30s into the song — a
// positive comment lands once they've settled into the track, never the
// moment it starts. We deliberately don't crossfade two at once —
// single-track keeps the surface calm and doesn't compete with the
// lyric / title overlays.

/** Playback elapsed time before the first positive comment may drift in. */
const DRIFT_START_MS = 30_000;

interface DriftCommentsProps {
  songId: string;
  comments: SongComment[];
  currentUserId: string | null;
  profilesByUserId: Record<string, { user_id: string; username: string | null; display_name: string | null; avatar_seed: string | null }>;
  /** Current playback position (ms) — gates the overlay until DRIFT_START_MS. */
  elapsedMs: number;
  /** Distance from the bottom of the screen where the pill sits. */
  bottomOffset: number;
  /** Tap handler — opens the full comments sheet. */
  onTapOpen: () => void;
}

function DriftComments({
  songId,
  comments,
  currentUserId,
  profilesByUserId,
  elapsedMs,
  bottomOffset,
  onTapOpen,
}: DriftCommentsProps) {
  // Compute the top-5 once per comment-set change. The same set persists
  // for the lifetime of the song (it only refreshes when CommentsContext
  // reloads), so we can cycle through a stable list.
  const pool = React.useMemo(
    () => topPositiveComments(comments, currentUserId, 5),
    [comments, currentUserId],
  );

  // Index into pool. Reset to 0 whenever the song id changes so we never
  // briefly flash the previous song's comments while the new ones load.
  const [idx, setIdx] = useState(0);
  useEffect(() => { setIdx(0); }, [songId]);

  // The overlay is gated until the listener is 30s into the song. `reached`
  // latches true once the mark is crossed and resets with each new song.
  const [reached, setReached] = useState(false);
  useEffect(() => { setReached(false); }, [songId]);
  useEffect(() => {
    if (!reached && elapsedMs >= DRIFT_START_MS) setReached(true);
  }, [reached, elapsedMs]);

  // Animated opacity for the current pill. -1 means "not yet started."
  const opacity = useSharedValue(0);

  // Run the loop only when there's something to show AND the 30s mark has
  // been reached. The first comment fades in immediately at that mark; each
  // later cycle is: delay 4-9s → fade in 350ms → hold 5s → fade out 350ms.
  useEffect(() => {
    if (pool.length === 0 || !reached) return;
    let cancelled = false;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const tick = async () => {
      let first = true;
      while (!cancelled) {
        if (!first) {
          await sleep(4000 + Math.floor(Math.random() * 5000));
          if (cancelled) return;
        }
        first = false;
        opacity.value = withTiming(1, { duration: 350, easing: Easing.out(Easing.cubic) });
        await sleep(5000);
        if (cancelled) return;
        opacity.value = withTiming(0, { duration: 350, easing: Easing.in(Easing.cubic) });
        await sleep(360);
        if (cancelled) return;
        setIdx((i) => (i + 1) % pool.length);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      opacity.value = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool.length, songId, reached]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  if (pool.length === 0) return null;
  const c = pool[idx];
  if (!c) return null;
  const profile = profilesByUserId[c.user_id];
  const handle = profile?.username ?? fallbackHandle(c.user_id);
  const av = avatarColor(profile?.avatar_seed || c.user_id);

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.driftWrap, { bottom: bottomOffset }, animatedStyle]}
    >
      <Pressable onPress={onTapOpen} style={styles.driftPill} hitSlop={6}>
        <LinearGradient
          colors={[av.from, av.to]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.driftAvatar}
        />
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          <Text style={styles.driftHandle} numberOfLines={1}>{handle}</Text>
          <Text style={styles.driftBody} numberOfLines={2}>{c.body}</Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

// ---- styles ----------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  coverWrap: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
    // The Ken-Burns transform can briefly leave a transparent edge.
    // The ArtworkBackdrop layer above fills the screen with a blurred
    // version of the same image, so we never want black behind it. The
    // surface color is a non-black neutral so the very first frame
    // (before the network image lands) does not flash pure black.
    backgroundColor: colors.surface,
  },
  // Persistent blurred fill behind the animated cover. Slightly larger
  // than the screen so the blur's own soft edges never enter the frame.
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  backdropImage: {
    position: 'absolute',
    top: -40,
    left: -40,
    right: -40,
    bottom: -40,
    transform: [{ scale: 1.15 }],
  },
  backdropTint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(10,10,12,0.42)',
  },
  // Clip-mask for the animated foreground. Prevents any sub-pixel bleed
  // from the transform exposing the layer underneath.
  coverClip: {
    overflow: 'hidden',
  },
  cover: {
    ...StyleSheet.absoluteFillObject,
    width: SCREEN_W,
    height: SCREEN_H,
  },

  swipeZone: {
    // Top ~75% of the screen — captures cover-area swipes (skip / prev /
    // dismiss). Sits above the comments sheet so the two never fight.
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: SCREEN_H * 0.75,
  },

  // Strong dark wash that sits behind the title block + waveform + transport.
  // Independent from the wide-screen gradient so the fall-off matches the
  // bottom-stack content area exactly.
  controlsScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: SCREEN_H * 0.45,
  },

  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  brandIcon: {
    width: 28,
    height: 28,
    borderRadius: 7,
  },
  brandWordmark: {
    color: metals.goldSolid,
    fontSize: 15,
    fontWeight: fonts.weight.bold,
    letterSpacing: 4.5,
  },

  // ---- Drift comment overlay ----
  driftWrap: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.xxl + spacing.md + 28, // keep clear of the right action rail
  },
  driftPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingLeft: 8,
    paddingRight: 14,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(12,12,14,0.78)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  driftAvatar: { width: 28, height: 28, borderRadius: 14 },
  driftHandle: { color: colors.textMuted, fontSize: 11, fontWeight: fonts.weight.semibold },
  driftBody: { color: colors.text, fontSize: fonts.size.sm, lineHeight: 18 },

  bottomStack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
  },

  titleBlock: {
    // Title sits directly above the transport row with zero gap, which
    // pulls it visually further down on the screen — below the bottom of
    // the right-side action column where it stops fighting for space.
    marginBottom: 0,
    // Reserve the right-edge lane for the Like / Save / Share action rail
    // so a long title (or the artist pills) never runs underneath those
    // icons. Without this, titles like "Choir at the Listening" collide
    // with the heart icon.
    paddingRight: 44,
  },
  title: {
    color: colors.text,
    fontSize: 34,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.5,
  },
  brandPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(20,20,24,0.72)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
  },
  // When an artist photo sits in the pill, tighten the left padding so the
  // circular image hugs the pill edge and the pill stays compact.
  brandPillArtist: {
    paddingLeft: 4,
    paddingVertical: 4,
    gap: 7,
  },
  brandPillText: {
    color: colors.text,
    fontSize: fonts.size.xs,
    fontWeight: fonts.weight.semibold,
    letterSpacing: 0.3,
  },
  // Boulevard Connect — shown when another device of the account owns
  // playback. The transport still works (it controls that device); "Play
  // here" pulls playback onto this device instead.
  connectBar: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 8,
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(20,20,24,0.72)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
  },
  connectDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: metals.goldSolidHi,
  },
  connectText: {
    color: colors.textMuted,
    fontSize: fonts.size.xs,
    fontWeight: fonts.weight.semibold,
    flexShrink: 1,
  },
  connectBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.pill,
    backgroundColor: metals.goldSolid,
  },
  connectBtnText: {
    color: '#1a1408',
    fontSize: fonts.size.xs,
    fontWeight: fonts.weight.bold,
  },
  artistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  followPill: {
    // Same vertical rhythm as the brand pill so the two reads as a
    // single metadata cluster, not two floating chips.
    marginTop: 10,
    marginLeft: 2,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
    backgroundColor: 'transparent',
  },
  followPillOn: {
    backgroundColor: metals.gold,
    borderColor: metals.gold,
  },
  followPillText: {
    color: colors.text,
    fontSize: fonts.size.xs,
    fontWeight: fonts.weight.semibold,
    letterSpacing: 0.3,
  },
  followPillTextOn: {
    color: '#1a1408',
  },

  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    // Shuffle | centered prev/play/skip cluster | equal-width spacer.
    // space-between pins shuffle and the spacer to the edges, which leaves
    // the cluster — and the big play button — dead-center.
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xs,
    marginTop: spacing.sm,
  },
  // The prev / play / skip cluster. Kept as its own row so it stays a
  // single centered unit regardless of what flanks it.
  transportCore: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xl,
  },
  // Auxiliary slot inside transport — the shuffle button on the left and a
  // matching invisible spacer on the right. Fixed width so the row stays
  // symmetric even as the shuffle icon swaps active/inactive tints.
  transportSide: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // TikTok-style vertical column anchored to the right edge of the screen.
  // Pinned absolute so the cover art shows through. `box-none` on the
  // container lets taps fall through anywhere that isn't a button. Now
  // three items only (Like / Comment / Save) so the rail no longer
  // visually dominates the lower third.
  actionColumn: {
    position: 'absolute',
    right: spacing.md,
    alignItems: 'center',
    gap: spacing.md,
  },
  actionBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingVertical: 2,
  },
  // Wraps the like button so the flying-heart overlay can be anchored to it;
  // shrink-wraps the Pressable, so the action rail's layout is unchanged.
  likeSlot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionCount: {
    color: colors.text,
    fontSize: 11,
    fontWeight: fonts.weight.semibold,
    marginTop: 4,
    fontVariant: ['tabular-nums'],
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  progressBarWrap: {
    marginTop: spacing.md,
    paddingHorizontal: 4,
  },
  progressMetaRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: -8,
  },
  progressMetaText: {
    color: colors.textMuted,
    fontSize: fonts.size.xs,
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.2,
  },
  playBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    overflow: 'hidden',
    backgroundColor: 'rgba(20,20,24,0.92)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
    alignItems: 'center',
    justifyContent: 'center',
    // Soft outer shadow for depth.
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  playInner: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Pressed-state visuals: shared by skip / prev / shuffle. The play button
  // gets its own treatment (below) so the shadow scales too.
  transportPressed: {
    opacity: 0.55,
    transform: [{ scale: 0.88 }],
  },
  commentBadge: {
    position: 'absolute',
    top: -6,
    right: -8,
    backgroundColor: metals.goldSolidHi,
    borderRadius: 8,
    paddingHorizontal: 5,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  commentBadgeText: {
    color: '#1a1408',
    fontSize: 10,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  playBtnPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.92 }],
  },
});
