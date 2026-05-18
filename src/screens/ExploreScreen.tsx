import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  Platform,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Video, ResizeMode } from 'expo-av';
import * as Haptics from 'expo-haptics';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { usePlayer, PlayContext } from '@/contexts/PlayerContext';
import { useExplore } from '@/contexts/ExploreContext';
import { buildExplore, ExploreSection, RankedSong, PlayMetrics } from '@/lib/ranking/Trending';
import { buildForYou } from '@/lib/recommendation/ForYouEngine';
import { buildSurpriseQueue } from '@/lib/recommendation/SurpriseEngine';
import { moodById } from '@/lib/mood/moodCatalog';
import {
  SESSION_WORLDS,
  worldToAnchor,
  buildWorldPlaylist,
  type SessionWorld,
} from '@/lib/recommendation/SessionContext';
import { fetchTodayStats } from '@/lib/stats/SongStats';
import { Song, SongStats } from '@/types';
import { PlayIcon, PauseIcon, SparkleIcon, ShuffleIcon } from '@/components/Icon';
import { ExploreHeader } from '@/components/ExploreHeader';
import { SearchSheet } from '@/components/SearchSheet';
import { MoodChipsRow } from '@/components/MoodChipsRow';
import { Artwork } from '@/components/Artwork';
import { RightClickable } from '@/components/desktop/SongContextMenu';
import { useAppNav } from '@/contexts/NavigationContext';
import { songArtworkUri } from '@/lib/artwork';

// Explore — the discovery surface.
//
// Layout (spec PART 1): brand header, a looping-video hero banner, the
// dynamic mood-chip row, then a long-scrollable stack of shelves (For You,
// New Releases, Trending Now, Top Artists Today, Because You Played, More
// <Mood>, Boulevard Breakouts) and a Top 100 Today list at the bottom.
//
// Tapping a card starts playback and surfaces the docked mini-player; it
// never force-opens the full player — the user stays on Explore with their
// scroll position intact (this screen stays mounted for the app's lifetime).

const CARD_W = 168;
const CARD_H = 168;

// 16:9 looping silent dance footage behind the Explore hero banner. Bundled
// so it resolves to a static URL on web and a packaged asset on native.
const HERO_VIDEO = require('../../assets/hero-dance.mp4');

type Shelf =
  | { kind: 'songs'; id: string; title: string; subtitle: string; songs: Song[] }
  | { kind: 'artists'; id: string; title: string; subtitle: string };

// Every Explore row — the shelves AND the full Top 100 list — is virtualized
// by the single outer FlatList, so 100 ranked rows never all mount at once.
type ExploreRow =
  | { kind: 'shelf'; shelf: Shelf }
  | { kind: 'top100head' }
  | { kind: 'top100row'; song: Song; rank: number };

export function ExploreScreen() {
  const player = usePlayer();
  const explore = useExplore();
  const { openArtistProfile, openPlayer } = useAppNav();
  const [searchOpen, setSearchOpen] = useState(false);
  // On desktop web the DesktopShell already provides a logo (sidebar) and a
  // search field (top bar), so the in-screen brand header is redundant there.
  // Always false on native + mobile-web — that layout is unchanged.
  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === 'web' && width >= 1024;

  // Explore taps start playback but keep the user on Explore — the docked
  // mini-player surfaces what is playing.
  const playSong = useCallback((s: Song, context?: PlayContext) => {
    void player.playSpecific(s, context);
  }, [player]);
  const playList = useCallback((songs: Song[], context?: PlayContext) => {
    if (songs.length === 0) return;
    void player.playPlaylist(songs, context);
  }, [player]);

  // Explore "worlds" — tapping a world builds an emotionally-consistent
  // playlist from the live catalog (microtags / mood / energy) and opens a
  // mood_focus session so the queue tail stays inside that emotional world.
  const playWorld = useCallback((world: SessionWorld) => {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    // Pass the behavioural identity profile so the world skews away from
    // identity mismatches (e.g. "Energy" → gym rap / dark electronic for a
    // mature listener, not childish party pop) while staying on-theme.
    const songs = buildWorldPlaylist(player.catalog, world, 28, player.getIdentityProfile());
    if (songs.length === 0) return;
    void player.playPlaylist(songs, {
      sessionMode: 'mood_focus',
      sessionAnchor: worldToAnchor(world),
    });
  }, [player]);

  // Today's per-song stats — drives play counts + Breakouts momentum.
  const [serverStats, setServerStats] = useState<Map<string, SongStats>>(new Map());
  useEffect(() => {
    let cancelled = false;
    fetchTodayStats()
      .then((m) => { if (!cancelled) setServerStats(m); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // New Releases + Trending Now come straight from the editorial ranker.
  const sections = useMemo<ExploreSection[]>(
    () => buildExplore({ catalog: player.catalog, serverStats }),
    [player.catalog, serverStats],
  );
  const newReleases = useMemo(
    () => (sections.find((s) => s.id === 'new_releases')?.songs ?? []).map((r) => r.song),
    [sections],
  );
  const trendingNow = useMemo(
    () => (sections.find((s) => s.id === 'trending_now')?.songs ?? []).map((r) => r.song),
    [sections],
  );

  // Boulevard Breakouts — songs gaining traction (rising stage / high velocity).
  const breakouts = useMemo(() => {
    return player.catalog
      .filter((s) => {
        const stage = s.distribution_stage ?? 'new_test';
        const vel = serverStats.get(s.id)?.velocity_score ?? 0;
        return stage === 'rising' || vel > 0.55;
      })
      .map((s) => ({ s, v: (serverStats.get(s.id)?.velocity_score ?? 0) + (s.launch_score ?? 0) * 0.3 }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 16)
      .map((x) => x.s);
  }, [player.catalog, serverStats]);

  // More <Mood> — the For You engine weighted hard toward the user's top mood.
  const topMoodId = explore.moodOrder[0];
  const moreLikeMood = useMemo(() => {
    if (player.catalog.length === 0 || !topMoodId) return [];
    return buildForYou({
      catalog: player.catalog,
      taste: player.taste,
      session: player.getSession(),
      topMoodIds: explore.moodOrder.slice(0, 3),
      sessionMoodId: topMoodId,
      suppressedIds: explore.exposureLog?.suppressedIds(),
      interactionCount: 999,
      limit: 16,
    }).songs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.catalog, player.taste, explore.moodOrder, topMoodId, explore.exposureLog]);

  // Because you played X — songs in the same lane as the current / last song.
  const anchor = player.current;
  const becauseYouLiked = useMemo(() => {
    if (!anchor) return [];
    return player.catalog
      .filter((s) => s.id !== anchor.id && (s.genre === anchor.genre || s.mood === anchor.mood))
      .sort((a, b) => (b.hook_strength ?? 0) - (a.hook_strength ?? 0))
      .slice(0, 16);
  }, [anchor, player.catalog]);

  // Predictively warm the most likely first taps.
  useEffect(() => {
    const targets = [...explore.forYou.slice(0, 3), ...trendingNow.slice(0, 2)];
    if (targets.length > 0) player.warmSongs(targets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explore.forYou, trendingNow]);

  // The ordered shelf stack (spec PART 1).
  const shelves = useMemo<Shelf[]>(() => {
    const out: Shelf[] = [];
    if (explore.forYou.length > 0)
      out.push({ kind: 'songs', id: 'for_you', title: 'For You', subtitle: explore.forYouSubtitle, songs: explore.forYou });
    if (newReleases.length > 0)
      out.push({ kind: 'songs', id: 'new_releases', title: 'New Releases', subtitle: 'Fresh drops you need', songs: newReleases });
    if (trendingNow.length > 0)
      out.push({ kind: 'songs', id: 'trending_now', title: 'Trending Now', subtitle: "What's hot right now", songs: trendingNow });
    out.push({ kind: 'artists', id: 'top_artists', title: 'Top Artists Today', subtitle: 'Most played in the last 24 hours' });
    if (becauseYouLiked.length > 0 && anchor)
      out.push({ kind: 'songs', id: 'because', title: `Because you played ${anchor.artist_name ?? anchor.title}`, subtitle: 'More in that lane', songs: becauseYouLiked });
    if (moreLikeMood.length > 0 && topMoodId)
      out.push({ kind: 'songs', id: 'more_mood', title: `More ${moodById(topMoodId)?.label ?? 'For You'}`, subtitle: 'Based on your current mood', songs: moreLikeMood });
    if (breakouts.length > 0)
      out.push({ kind: 'songs', id: 'breakouts', title: 'Boulevard Breakouts', subtitle: 'Songs gaining traction', songs: breakouts });
    return out;
  }, [explore.forYou, explore.forYouSubtitle, newReleases, trendingNow, becauseYouLiked, anchor, moreLikeMood, topMoodId, breakouts]);

  // Top 100 Today — ranked strictly by last-24h play volume (today's plays
  // from song_daily_stats) so the chart genuinely reflects what is most
  // popular right now. Ties — common on a fresh catalog where most songs have
  // no plays yet — break on the server trending score, then the editorial
  // launch_score, then a stable hash so the order is deterministic and the
  // chart is never empty.
  const top100 = useMemo<Song[]>(() => {
    if (player.catalog.length === 0) return [];
    const hashScore = (id: string) => {
      let h = 0;
      for (let i = 0; i < id.length; i++) { h = ((h << 5) - h) + id.charCodeAt(i); h |= 0; }
      return Math.abs(h) / 0x7fffffff;
    };
    return player.catalog
      .map((song) => {
        const s = serverStats.get(song.id);
        return {
          song,
          plays24h: s?.plays ?? 0,
          trending: s?.trending_score ?? 0,
          editorial: song.launch_score ?? 0,
          hash: hashScore(song.id),
        };
      })
      .sort((a, b) =>
        b.plays24h - a.plays24h
        || b.trending - a.trending
        || b.editorial - a.editorial
        || b.hash - a.hash,
      )
      .slice(0, 100)
      .map((x) => x.song);
  }, [player.catalog, serverStats]);

  // Flatten the shelves + the entire Top 100 into one virtualized list so the
  // 100 ranked rows never all mount at once.
  const rows = useMemo<ExploreRow[]>(() => {
    const out: ExploreRow[] = shelves.map((shelf) => ({ kind: 'shelf', shelf }));
    if (top100.length > 0) {
      out.push({ kind: 'top100head' });
      top100.forEach((song, i) => out.push({ kind: 'top100row', song, rank: i + 1 }));
    }
    return out;
  }, [shelves, top100]);

  // ---- Hero banner CTAs ----
  // Both buttons open the full Player page. "Play now" continues the user's
  // personalized lane (For You / Trending). "Surprise me" is NOT shuffle — it
  // builds a controlled high-upside discovery queue (SurpriseEngine) and runs
  // it as a discovery_focus session so the autoplay tail stays in discovery.
  const onHeroPlayNow = useCallback(() => {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    const lane = explore.forYou.length > 0 ? explore.forYou : trendingNow;
    if (lane.length === 0) return;
    playList(lane);
    openPlayer();
  }, [explore.forYou, trendingNow, playList, openPlayer]);

  const onHeroSurprise = useCallback(() => {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    const { songs } = buildSurpriseQueue({
      catalog: player.catalog,
      taste: player.taste,
      identity: player.getIdentityProfile(),
      session: player.getSession(),
      topMoodIds: explore.moodOrder,
      stats: serverStats,
      suppressedIds: explore.exposureLog?.suppressedIds(),
      limit: 26,
    });
    const queue = songs.length > 0 ? songs : player.catalog;
    if (queue.length === 0) return;
    playList(queue, { sessionMode: 'discovery_focus', sessionAnchor: { label: 'Surprise Me' } });
    openPlayer();
  }, [player, explore.moodOrder, explore.exposureLog, serverStats, playList, openPlayer]);

  // Until the real catalog finishes loading, show a loading state instead of
  // the bundled seed list.
  if (player.catalog.length === 0) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={metals.goldHi} size="large" />
      </View>
    );
  }

  return (
    <>
      <FlatList
        style={styles.root}
        data={rows}
        keyExtractor={(r) =>
          r.kind === 'shelf'
            ? r.shelf.id
            : r.kind === 'top100head'
              ? 'top100head'
              : `top100_${r.song.id}`
        }
        ListHeaderComponent={
          <View>
            {!isDesktop && <ExploreHeader onSearch={() => setSearchOpen(true)} />}
            <HeroCard
              isDesktop={isDesktop}
              onPlayNow={onHeroPlayNow}
              onSurprise={onHeroSurprise}
            />
            <MoodChipsRow />
            <WorldsRow onPlay={playWorld} />
          </View>
        }
        renderItem={({ item }) => {
          if (item.kind === 'top100head') {
            return (
              <View style={top100Styles.head}>
                <Text style={top100Styles.title}>Top 100 Today</Text>
                <Text style={top100Styles.subtitle}>Updated every 24 hours</Text>
              </View>
            );
          }
          if (item.kind === 'top100row') {
            const idx = item.rank - 1;
            return (
              <Top100Row
                song={item.song}
                rank={item.rank}
                plays={item.song.stream_count ?? 0}
                onPress={() => playList(top100.slice(idx).concat(top100.slice(0, idx)))}
              />
            );
          }
          const shelf = item.shelf;
          if (shelf.kind === 'artists') {
            return (
              <TopArtistsShelf
                title={shelf.title}
                subtitle={shelf.subtitle}
                catalog={player.catalog}
                serverStats={serverStats}
                onOpenArtist={openArtistProfile}
              />
            );
          }
          return (
            <SongShelf
              sectionId={shelf.id}
              title={shelf.title}
              subtitle={shelf.subtitle}
              songs={shelf.songs}
              serverStats={serverStats}
              onPlay={
                shelf.id === 'more_mood' && topMoodId
                  ? (s) => playSong(s, { moodId: topMoodId })
                  : playSong
              }
            />
          );
        }}
        contentContainerStyle={{ paddingBottom: 160 }}
        showsVerticalScrollIndicator={false}
      />
      <SearchSheet visible={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}

// ---- Hero banner -----------------------------------------------------
//
// A looping, silent, autoplaying 16:9 dance clip behind the Explore hero.
// expo-av's Video renders a real <video autoPlay muted loop playsInline> on
// web and a native inline video on iOS/Android, so one component covers all
// platforms. A fallback gradient sits behind the video (and a dark/gold
// scrim above it) so the banner never flashes blank, shifts layout, or
// leaves the CTAs unreadable — even if the clip is slow or fails to load.

function HeroCard({
  isDesktop,
  onPlayNow,
  onSurprise,
}: {
  isDesktop: boolean;
  onPlayNow: () => void;
  onSurprise: () => void;
}) {
  const [videoFailed, setVideoFailed] = useState(false);
  const videoRef = useRef<Video>(null);
  return (
    <View style={[styles.heroCard, isDesktop ? styles.heroCardDesktop : styles.heroCardMobile]}>
      {/* Layer 0 — fallback backdrop. Visible while the clip buffers and if
          it fails entirely. */}
      <LinearGradient
        colors={['#2c2417', '#171310', '#0b0a08']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Layer 1 — looping silent dance footage. */}
      {!videoFailed && (
        <Video
          ref={videoRef}
          style={StyleSheet.absoluteFill}
          videoStyle={styles.heroVideoInner}
          source={HERO_VIDEO}
          resizeMode={ResizeMode.COVER}
          shouldPlay
          isLooping
          isMuted
          useNativeControls={false}
          // A browser can drop the initial muted-autoplay when the `muted`
          // property lands a tick after the autoplay attempt. Once the clip
          // has loaded, muted is guaranteed — so re-kick playback then.
          onLoad={() => { videoRef.current?.playAsync().catch(() => {}); }}
          onError={() => setVideoFailed(true)}
          accessibilityLabel="Two people dancing"
        />
      )}
      {/* Layer 2 — dark, moody scrim so the CTAs stay readable and the
          banner sits in the app's dark palette rather than glowing. */}
      <LinearGradient
        colors={['rgba(6,5,4,0.42)', 'rgba(5,4,3,0.66)', 'rgba(3,2,2,0.95)']}
        locations={[0, 0.5, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {/* Layer 2b — restrained warm gold wash rising from the bottom-left. */}
      <LinearGradient
        colors={['rgba(160,128,72,0)', 'rgba(170,134,74,0.2)']}
        start={{ x: 1, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {/* Layer 3 — CTAs, pinned bottom-left above the overlay. */}
      <View style={styles.heroCtaRow}>
        <Pressable
          onPress={onPlayNow}
          style={({ pressed }) => [styles.heroPrimary, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
          accessibilityLabel="Play now"
        >
          <PlayIcon size={16} color="#0a0a0c" />
          <Text style={styles.heroPrimaryText}>Play now</Text>
        </Pressable>
        <Pressable
          onPress={onSurprise}
          style={({ pressed }) => [styles.heroSecondary, pressed && { opacity: 0.7 }]}
          accessibilityRole="button"
          accessibilityLabel="Surprise me"
        >
          <ShuffleIcon size={15} color="#ffffff" />
          <Text style={styles.heroSecondaryText}>Surprise me</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---- Explore worlds --------------------------------------------------
//
// Dynamic emotional "worlds" — Night Drive, Heartbreak Spiral, Euphoric EDM,
// etc. Tapping one drops the user into that world: an emotionally-consistent
// playlist built live from the catalog (microtags / mood / energy) plus a
// mood_focus contextual session so the queue tail stays inside the world.
// The world set lives in SessionContext.SESSION_WORLDS.

// A distinct 3-stop gradient per world — a vivid accent that blooms at the
// top and sinks into near-black, so each tile reads as a lit, cinematic place
// rather than a flat colour chip.
const WORLD_GRADIENTS: Record<string, [string, string, string]> = {
  night_drive: ['#3a56b0', '#1b2444', '#0a0c16'],
  main_character: ['#dcbd82', '#82602e', '#1c1408'],
  heartbreak_spiral: ['#7a3a62', '#3c2238', '#130c13'],
  euphoric_edm: ['#9d5dff', '#48268f', '#120a24'],
  sad_gym: ['#5278a0', '#283a4e', '#0d1118'],
  floating_indie: ['#56938b', '#2c4b47', '#0e1a18'],
  rage_trap: ['#ad3030', '#511b1b', '#140808'],
  sunset_afrobeats: ['#f0954f', '#8c4a22', '#1d0e06'],
};

function WorldsRow({ onPlay }: { onPlay: (w: SessionWorld) => void }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Worlds</Text>
        <Text style={styles.sectionSubtitle}>Step into an emotional world</Text>
      </View>
      <FlatList
        data={SESSION_WORLDS}
        keyExtractor={(w) => w.id}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.worldRow}
        renderItem={({ item }) => {
          const grad = WORLD_GRADIENTS[item.id] ?? ['#3a3a44', '#23232c', '#121218'];
          return (
            <Pressable
              onPress={() => onPlay(item)}
              style={({ pressed }) => [
                styles.worldTile,
                pressed && { opacity: 0.94, transform: [{ scale: 0.97 }] },
              ]}
              accessibilityLabel={`Enter ${item.label}`}
            >
              {/* Base — vivid accent blooming from the top, sinking to black. */}
              <LinearGradient
                colors={grad}
                locations={[0, 0.55, 1]}
                start={{ x: 0, y: 0 }}
                end={{ x: 0.9, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
              {/* Top catch-light — a soft glassy highlight on the upper edge. */}
              <LinearGradient
                colors={[metals.glassHi, 'transparent']}
                style={styles.worldGlass}
                pointerEvents="none"
              />
              {/* Cinematic bottom vignette — pools the label in shadow. */}
              <LinearGradient
                colors={['transparent', 'rgba(6,5,8,0.74)']}
                style={styles.worldScrim}
                pointerEvents="none"
              />
              {/* Enter affordance — a glassy play bubble, top-right. */}
              <View style={styles.worldEnter}>
                <PlayIcon size={11} color="#ffffff" />
              </View>
              <View style={styles.worldTileBody}>
                <Text style={styles.worldEyebrow}>
                  {item.kind === 'genre' ? 'GENRE' : 'MOOD'}
                </Text>
                <Text style={styles.worldLabel} numberOfLines={2}>{item.label}</Text>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

// ---- Song shelf ------------------------------------------------------
//
// Horizontal row of song tiles. Works directly off a Song[]; the metrics a
// Tile needs for its rank badge are not relevant here, so a zero stub is fine.

const DUMMY_METRICS: PlayMetrics = {
  plays_24h: 0, replays: 0, saves: 0, completions_70: 0, skips: 0, plays_prev_day: 0,
};

interface SongShelfProps {
  sectionId: string;
  title: string;
  subtitle: string;
  songs: Song[];
  serverStats: Map<string, SongStats>;
  onPlay: (s: Song) => void;
}

function SongShelf({ sectionId, title, subtitle, songs, serverStats, onPlay }: SongShelfProps) {
  if (songs.length === 0) return null;
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.sectionSubtitle}>{subtitle}</Text>
      </View>
      <FlatList
        data={songs}
        keyExtractor={(s) => `${sectionId}_${s.id}`}
        renderItem={({ item, index }) => (
          <Tile
            ranked={{ song: item, score: 0, metrics: DUMMY_METRICS }}
            rank={index + 1}
            serverStats={serverStats}
            onPress={() => onPlay(item)}
            sectionId={sectionId}
          />
        )}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        ItemSeparatorComponent={() => <View style={{ width: spacing.md }} />}
        directionalLockEnabled
        nestedScrollEnabled
      />
    </View>
  );
}

// ---- Top Artists shelf -----------------------------------------------

interface TopArtistsShelfProps {
  title: string;
  subtitle: string;
  catalog: Song[];
  serverStats: Map<string, SongStats>;
  onOpenArtist: (artistId: string) => void;
}

interface ArtistAggregate {
  artistId: string;
  artistName: string;
  artistImageUrl: string | null;
  totalPlays: number;
  topSong: Song;
}

function TopArtistsShelf({ title, subtitle, catalog, serverStats, onOpenArtist }: TopArtistsShelfProps) {
  const artists = useMemo<ArtistAggregate[]>(() => {
    const byArtist = new Map<string, ArtistAggregate>();
    for (const song of catalog) {
      if (!song.artist_id || !song.artist_name) continue;
      const plays = displayPlays(song);
      const existing = byArtist.get(song.artist_id);
      if (!existing) {
        byArtist.set(song.artist_id, {
          artistId: song.artist_id,
          artistName: song.artist_name,
          artistImageUrl: song.artist_image_url ?? null,
          totalPlays: plays,
          topSong: song,
        });
      } else {
        existing.totalPlays += plays;
        if (plays > displayPlays(existing.topSong)) existing.topSong = song;
        // artist_image_url is denormalized per-song and frequently missing;
        // keep the first real portrait we see across any of the artist's rows.
        if (!existing.artistImageUrl && song.artist_image_url) {
          existing.artistImageUrl = song.artist_image_url;
        }
      }
    }
    return [...byArtist.values()]
      .sort((a, b) => b.totalPlays - a.totalPlays)
      .slice(0, 10);
  }, [catalog, serverStats]);

  if (artists.length === 0) return null;

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionTitleRow}>
          <SparkleIcon size={14} color={colors.text} />
          <Text style={styles.sectionTitle}>{title}</Text>
        </View>
        <Text style={styles.sectionSubtitle}>{subtitle}</Text>
      </View>
      <FlatList
        data={artists}
        keyExtractor={(a) => a.artistId}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        ItemSeparatorComponent={() => <View style={{ width: spacing.md }} />}
        directionalLockEnabled
        nestedScrollEnabled
        renderItem={({ item, index }) => (
          <Pressable
            onPress={() => {
              if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
              onOpenArtist(item.artistId);
            }}
            style={({ pressed }) => [styles.artistTile, pressed && { opacity: 0.85 }]}
          >
            <Artwork
              uri={item.artistImageUrl ?? item.topSong.cover_url}
              name={item.artistName}
              size={CARD_W}
              circle
              recyclingKey={item.artistId}
            />
            <View style={styles.artistRank}>
              <Text style={styles.artistRankText}>{index + 1}</Text>
            </View>
            <Text style={styles.artistName} numberOfLines={1}>{item.artistName}</Text>
            <Text style={styles.artistPlays}>{formatPlays(item.totalPlays)} plays</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

// ---- Tile ------------------------------------------------------------

interface TileProps {
  ranked: RankedSong;
  rank: number;
  sectionId: string;
  serverStats: Map<string, SongStats>;
  onPress: () => void;
}

function Tile({ ranked, rank, sectionId, serverStats, onPress }: TileProps) {
  const { song } = ranked;
  const player = usePlayer();
  const { width } = useWindowDimensions();
  // Desktop web gets a right-click menu; native + mobile-web are unchanged.
  const isDesktop = Platform.OS === 'web' && width >= 1024;
  const plays = displayPlays(song);
  const subtitle = plays === 1 ? '1 play' : `${formatPlays(plays)} plays`;
  const isCurrent = player.current?.id === song.id;
  const isPlaying = isCurrent && player.isPlaying;

  const inner = (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.tile, pressed && { opacity: 0.85 }]}>
      <View style={styles.tileImageWrap}>
        <Image
          source={{ uri: songArtworkUri(song) ?? undefined }}
          style={styles.tileImage}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={120}
          recyclingKey={song.id}
        />
        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.55)']}
          style={styles.tileOverlay}
          pointerEvents="none"
        />
        <LinearGradient
          colors={[metals.glassHi, 'transparent']}
          locations={[0, 0.45]}
          style={styles.tileGlass}
          pointerEvents="none"
        />
        {sectionId === 'trending_now' && rank <= 3 && (
          <View style={styles.rankBadge}>
            <Text style={styles.rankText}>{rank}</Text>
          </View>
        )}
        <View style={[styles.tilePlayBubble, isCurrent && styles.tilePlayBubbleActive]}>
          {isPlaying
            ? <PauseIcon size={14} color={colors.bg} />
            : <PlayIcon size={14} color={colors.bg} />}
        </View>
      </View>
      <Text style={[styles.tileTitle, isCurrent && { color: metals.goldHi }]} numberOfLines={1}>{song.title}</Text>
      <Text style={styles.tileSubtitle} numberOfLines={1}>
        {isCurrent ? (isPlaying ? 'Playing now' : 'Paused') : subtitle}
      </Text>
    </Pressable>
  );
  return isDesktop ? <RightClickable song={song}>{inner}</RightClickable> : inner;
}

// ---- Top 100 Today ---------------------------------------------------
//
// One ranked row of the Top 100 chart. The rows are flattened into the main
// Explore FlatList (see `rows` above) so the whole 100-row list is virtualized
// — only on-screen rows ever mount.

function Top100Row({ song, rank, plays, onPress }: {
  song: Song;
  rank: number;
  plays: number;
  onPress: () => void;
}) {
  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === 'web' && width >= 1024;
  const inner = (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [top100Styles.row, pressed && { opacity: 0.7 }]}
    >
      <Text style={top100Styles.rank}>{rank}</Text>
      {song.cover_url ? (
        <Image
          source={{ uri: song.cover_url }}
          style={top100Styles.cover}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={song.id}
        />
      ) : (
        <View style={[top100Styles.cover, { backgroundColor: colors.surface }]} />
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={top100Styles.songTitle} numberOfLines={1}>{song.title}</Text>
        <Text style={top100Styles.songSub} numberOfLines={1}>{song.artist_name ?? song.genre}</Text>
      </View>
      <View style={top100Styles.statsCol}>
        <Text style={top100Styles.streamCount}>{formatStreamCount(plays)}</Text>
        <Text style={top100Styles.streamCountLabel}>streams</Text>
      </View>
    </Pressable>
  );
  return isDesktop ? <RightClickable song={song}>{inner}</RightClickable> : inner;
}

// ---- helpers ---------------------------------------------------------

function formatPlays(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

// Lifetime stream count for a Top 100 row. Shows the exact number for small
// counts and abbreviates K/M once it grows.
function formatStreamCount(plays: number): string {
  if (plays >= 1_000_000) return `${(plays / 1_000_000).toFixed(1)}M`;
  if (plays >= 10_000) return `${Math.round(plays / 1000)}K`;
  if (plays >= 1_000) return `${(plays / 1000).toFixed(1)}K`;
  return `${plays}`;
}

// Real lifetime stream count for a song — the qualified-stream counter
// (>= 30s or >= 70% plays) maintained server-side by the record_stream RPC.
// The same number on web, iOS, Android and desktop.
function displayPlays(song: Song): number {
  return song.stream_count ?? 0;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  loading: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ---- Hero banner ----
  heroCard: {
    position: 'relative',
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    overflow: 'hidden',
    // Fallback fill — guarantees a defined backdrop before the video paints.
    backgroundColor: '#171310',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  // Mobile runs the banner full-bleed — edge to edge, no side margin or
  // corner radius — for an immersive hero. A true 16:9 box sets the height.
  heroCardMobile: { aspectRatio: 16 / 9 },
  // Desktop keeps the inset, rounded card and caps the height so the wide
  // banner never becomes a giant block. object-fit: cover crops either way.
  heroCardDesktop: {
    height: 260,
    marginHorizontal: spacing.lg,
    borderRadius: radii.lg,
  },
  // The inner <video> element — fills the banner so cover-cropping works.
  heroVideoInner: { width: '100%', height: '100%' },
  heroCtaRow: {
    position: 'absolute',
    left: spacing.lg,
    bottom: spacing.lg,
    zIndex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  heroPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: radii.pill,
    backgroundColor: '#ffffff',
  },
  heroPrimaryText: { color: '#0a0a0c', fontWeight: fonts.weight.bold, fontSize: fonts.size.md },
  heroSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.32)',
  },
  heroSecondaryText: { color: '#ffffff', fontWeight: fonts.weight.bold, fontSize: fonts.size.sm },

  // ---- Section / shelf ----
  section: { marginBottom: spacing.xl + 4 },
  sectionHeader: { paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  sectionTitle: {
    color: colors.text,
    fontSize: fonts.size.xl,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.3,
  },
  sectionSubtitle: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    marginTop: 3,
    letterSpacing: 0.1,
  },
  row: { paddingHorizontal: spacing.lg },

  // ---- Explore worlds ----
  worldRow: { paddingHorizontal: spacing.lg, gap: spacing.md },
  worldTile: {
    width: 150,
    height: 172,
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 7 },
    elevation: 5,
  },
  worldGlass: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: '34%',
  },
  worldScrim: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    height: '64%',
  },
  worldEnter: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.30)',
  },
  worldTileBody: {
    position: 'absolute',
    left: 13,
    right: 13,
    bottom: 13,
  },
  worldEyebrow: {
    color: 'rgba(255,255,255,0.66)',
    fontSize: 10,
    fontWeight: fonts.weight.bold,
    letterSpacing: 1.5,
    marginBottom: 3,
  },
  worldLabel: {
    color: '#ffffff',
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.2,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },

  // ---- Top Artists tile ----
  artistTile: { width: CARD_W, alignItems: 'center' },
  artistRank: {
    position: 'absolute',
    top: 8,
    left: 8,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'rgba(10,10,12,0.78)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  artistRankText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: fonts.weight.bold,
    fontVariant: ['tabular-nums'],
  },
  artistName: {
    color: colors.text,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.1,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  artistPlays: {
    color: colors.textMuted,
    fontSize: fonts.size.xs,
    marginTop: 2,
    textAlign: 'center',
  },

  // ---- Song tile ----
  tile: { width: CARD_W },
  tileImageWrap: {
    width: CARD_W,
    height: CARD_H,
    borderRadius: radii.md,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  tileImage: { width: '100%', height: '100%' },
  tileOverlay: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    height: '50%',
  },
  tileGlass: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: '30%',
  },
  tilePlayBubble: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tilePlayBubbleActive: {
    backgroundColor: metals.goldHi,
    shadowColor: metals.goldHi,
    shadowOpacity: 0.6,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  rankBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    minWidth: 26,
    height: 26,
    paddingHorizontal: 6,
    borderRadius: 13,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinumHi,
  },
  rankText: {
    color: colors.text,
    fontWeight: fonts.weight.bold,
    fontSize: fonts.size.sm,
    fontVariant: ['tabular-nums'],
  },
  tileTitle: {
    color: colors.text,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.semibold,
    marginTop: 10,
    letterSpacing: -0.1,
  },
  tileSubtitle: {
    color: colors.textMuted,
    fontSize: fonts.size.xs,
    marginTop: 3,
    letterSpacing: 0.1,
  },
});

const top100Styles = StyleSheet.create({
  head: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  title: {
    color: colors.text,
    fontSize: fonts.size.xl,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.3,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    marginTop: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  rank: {
    color: colors.textDim,
    fontSize: fonts.size.sm,
    fontWeight: fonts.weight.bold,
    fontVariant: ['tabular-nums'],
    width: 28,
    textAlign: 'right',
  },
  cover: {
    width: 48,
    height: 48,
    borderRadius: radii.sm,
  },
  songTitle: {
    color: colors.text,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.semibold,
  },
  songSub: {
    color: colors.textMuted,
    fontSize: fonts.size.xs,
    marginTop: 2,
  },
  statsCol: {
    alignItems: 'flex-end',
    minWidth: 48,
  },
  streamCount: {
    color: colors.text,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.semibold,
    fontVariant: ['tabular-nums'],
  },
  streamCountLabel: {
    color: colors.textDim,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: 1,
  },
});
