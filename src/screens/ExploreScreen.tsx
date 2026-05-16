import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import * as Haptics from 'expo-haptics';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { usePlayer, PlayContext } from '@/contexts/PlayerContext';
import { useExplore } from '@/contexts/ExploreContext';
import { buildExplore, ExploreSection, RankedSong, PlayMetrics } from '@/lib/ranking/Trending';
import { buildForYou } from '@/lib/recommendation/ForYouEngine';
import { moodById } from '@/lib/mood/moodCatalog';
import { fetchTodayStats } from '@/lib/stats/SongStats';
import { Song, SongStats } from '@/types';
import { PlayIcon, PauseIcon, SparkleIcon, ShuffleIcon } from '@/components/Icon';
import { ExploreHeader } from '@/components/ExploreHeader';
import { SearchSheet } from '@/components/SearchSheet';
import { MoodChipsRow } from '@/components/MoodChipsRow';
import { MoodHeroFigure } from '@/components/MoodHeroFigure';
import { Artwork } from '@/components/Artwork';
import { RightClickable } from '@/components/desktop/SongContextMenu';
import { useAppNav } from '@/contexts/NavigationContext';
import { songArtworkUri } from '@/lib/artwork';

// Explore — the discovery surface.
//
// Layout (spec PART 1): brand header, a "Made for your mood" hero card, the
// dynamic mood-chip row, then a long-scrollable stack of shelves (For You,
// New Releases, Trending Now, Top Artists Today, Because You Played, More
// <Mood>, Boulevard Breakouts) and a Top 100 Today list at the bottom.
//
// Tapping a card starts playback and surfaces the docked mini-player; it
// never force-opens the full player — the user stays on Explore with their
// scroll position intact (this screen stays mounted for the app's lifetime).

const CARD_W = 168;
const CARD_H = 168;

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
  const { openArtistProfile } = useAppNav();
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
      out.push({ kind: 'songs', id: 'for_you', title: 'For You', subtitle: 'Based on your listening', songs: explore.forYou });
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
  }, [explore.forYou, newReleases, trendingNow, becauseYouLiked, anchor, moreLikeMood, topMoodId, breakouts]);

  // Top 100 Today — ranked by 24h momentum (server trending + plays) with an
  // editorial and stable-hash fallback so the chart is never empty.
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
        const serverScore = s ? (s.trending_score * 1.0 + Math.log10(1 + s.plays) * 0.1) : 0;
        const editorial = song.launch_score ?? 0;
        const score = serverScore > 0 ? serverScore : editorial > 0 ? editorial : hashScore(song.id);
        return { song, score };
      })
      .sort((a, b) => b.score - a.score)
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
              onPlayNow={() => playList(explore.forYou.length > 0 ? explore.forYou : trendingNow)}
              onSurprise={() => {
                if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
                const c = player.catalog;
                const pick = c[Math.floor(Math.random() * c.length)];
                if (pick) playSong(pick);
              }}
            />
            <MoodChipsRow />
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

// ---- Hero card -------------------------------------------------------

function HeroCard({ onPlayNow, onSurprise }: { onPlayNow: () => void; onSurprise: () => void }) {
  return (
    <View style={styles.heroCard}>
      <LinearGradient
        colors={['#e0c898', '#c8ae7a', '#8a6f3f']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Listener-with-headphones illustration tucked into the right side. */}
      <View style={styles.heroFigure} pointerEvents="none">
        <MoodHeroFigure height={112} />
      </View>
      <View style={styles.heroCardBody}>
        <View style={styles.heroTopBlock}>
          <View style={styles.heroBadgeRow}>
            <SparkleIcon size={14} color="#1a1408" />
            <Text style={styles.heroEyebrow}>MADE FOR YOU</Text>
          </View>
          <Text style={styles.heroCardTitle}>Made for your mood</Text>
          <Text style={styles.heroCardSub}>Fresh songs for how you feel right now</Text>
        </View>
        <View style={styles.heroCtaRow}>
          <Pressable
            onPress={onPlayNow}
            style={({ pressed }) => [styles.heroPrimary, pressed && { opacity: 0.88 }]}
            accessibilityLabel="Play now"
          >
            <PlayIcon size={16} color="#ffffff" />
            <Text style={styles.heroPrimaryText}>Play now</Text>
          </Pressable>
          <Pressable
            onPress={onSurprise}
            style={({ pressed }) => [styles.heroSecondary, pressed && { opacity: 0.7 }]}
            accessibilityLabel="Surprise me"
          >
            <ShuffleIcon size={15} color="#1a1408" />
            <Text style={styles.heroSecondaryText}>Surprise Me</Text>
          </Pressable>
        </View>
      </View>
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
        <Text style={top100Styles.plays24h}>{formatPlays24h(plays)}</Text>
        <Text style={top100Styles.plays24hLabel}>24h</Text>
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

function formatPlays24h(plays: number): string {
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

  // ---- Hero card ----
  heroCard: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    borderRadius: radii.lg,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  heroCardBody: { padding: spacing.lg },
  // The headphones illustration, tucked into the upper-right of the banner.
  heroFigure: {
    position: 'absolute',
    top: spacing.md,
    right: spacing.md,
  },
  // Badge + title + sub reserve room on the right so they never run under
  // the illustration. The CTA row below spans the full width.
  heroTopBlock: {
    paddingRight: 104,
  },
  heroBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
  },
  heroEyebrow: {
    color: '#1a1408',
    fontSize: 11,
    fontWeight: fonts.weight.bold,
    letterSpacing: 1.6,
  },
  heroCardTitle: {
    color: '#1a1408',
    fontSize: fonts.size.xxl,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.4,
  },
  heroCardSub: {
    color: 'rgba(26,20,8,0.78)',
    fontSize: fonts.size.sm,
    marginTop: 4,
    marginBottom: spacing.md,
  },
  heroCtaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  heroPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: radii.pill,
    backgroundColor: '#1a1408',
  },
  heroPrimaryText: { color: '#ffffff', fontWeight: fonts.weight.bold, fontSize: fonts.size.md },
  heroSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(26,20,8,0.14)',
  },
  heroSecondaryText: { color: '#1a1408', fontWeight: fonts.weight.bold, fontSize: fonts.size.sm },

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
  plays24h: {
    color: colors.text,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.semibold,
    fontVariant: ['tabular-nums'],
  },
  plays24hLabel: {
    color: colors.textDim,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: 1,
  },
});
