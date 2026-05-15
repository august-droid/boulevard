import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  Dimensions,
  ListRenderItem,
  Platform,
  Modal,
  ScrollView,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { usePlayer } from '@/contexts/PlayerContext';
import { buildExplore, ExploreSection, pickHero, RankedSong } from '@/lib/ranking/Trending';
import { fetchTodayStats } from '@/lib/stats/SongStats';
import { SongStats } from '@/types';
import { PlayIcon, PauseIcon, SparkleIcon, FlameIcon, TrendingIcon, ShuffleIcon } from '@/components/Icon';
import { BrandHeader } from '@/components/BrandHeader';
import { MoodChipsRow } from '@/components/MoodChipsRow';
import { useAppNav } from '@/contexts/NavigationContext';
import { Song } from '@/types';

const { width } = Dimensions.get('window');
const HERO_H = Math.round(width * 0.95);
const CARD_W = 168;
const CARD_H = 168;

export function ExploreScreen() {
  const insets = useSafeAreaInsets();
  const player = usePlayer();
  const { openPlayer, openArtistProfile } = useAppNav();
  // Wrap every "start playback" tap so it immediately raises the full-
  // screen player. Without this, Explore taps started audio silently in
  // the background and the user had to find the mini-player to see what
  // was playing.
  const playSong = useCallback((s: Song) => {
    void player.playSpecific(s);
    openPlayer();
  }, [player, openPlayer]);
  const playList = useCallback((songs: Song[]) => {
    if (songs.length === 0) return;
    void player.playPlaylist(songs);
    openPlayer();
  }, [player, openPlayer]);

  // Top 30 sheet visibility. Tapping the "Top 30 Global" pill opens a list
  // of the actual 30 songs rather than auto-playing them so the user can
  // pick from the list.
  const [top30Open, setTop30Open] = useState(false);

  // Pull today's stats once when the user enters Explore. The fetcher caches
  // for 5 minutes, so tab-switching doesn't re-fire the request.
  const [serverStats, setServerStats] = useState<Map<string, SongStats>>(new Map());
  useEffect(() => {
    let cancelled = false;
    fetchTodayStats()
      .then((m) => { if (!cancelled) setServerStats(m); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const sections = useMemo<ExploreSection[]>(
    () => buildExplore({ catalog: player.catalog, serverStats }),
    [player.catalog, serverStats],
  );

  const hero = useMemo(() => pickHero(sections), [sections]);

  // Warm expo-image's cache with every tile that's about to render. First
  // paint is still over-the-network, but subsequent renders (scroll back,
  // returning to Explore, tapping a tile) are instant from disk.
  useEffect(() => {
    const urls = new Set<string>();
    if (hero) urls.add(hero.song.artist_image_url ?? hero.song.cover_url);
    for (const s of sections) for (const r of s.songs) urls.add(r.song.artist_image_url ?? r.song.cover_url);
    if (urls.size > 0) {
      Image.prefetch(Array.from(urls), 'memory-disk').catch(() => {});
    }
  }, [sections, hero]);

  // ============================================================
  // Predictive AUDIO preload — the perceived-latency superpower.
  // The moment Explore mounts (and any time the catalog / sections change),
  // we tell the player to warm the top-likely-tap songs:
  //   • the #1 trending hero
  //   • the first 3 tiles in Trending Now
  //   • the per-genre top song for each of the 6 genre tiles
  // expo-av decodes them in the background. When the user taps any of them,
  // audio.play() uses the preloaded sound and starts in ~10-50 ms.
  // ============================================================
  useEffect(() => {
    const targets: Song[] = [];
    if (hero) targets.push(hero.song);
    const trending = sections.find((s) => s.id === 'trending_now');
    if (trending) targets.push(...trending.songs.slice(0, 3).map((r) => r.song));
    // Top song per genre tile.
    for (const g of MAIN_GENRES) {
      const wanted = new Set(g.slugs.map((s) => s.toLowerCase()));
      const top = player.catalog
        .filter((s) => wanted.has((s.genre ?? '').toLowerCase())
          || (s.genres ?? []).some((x) => wanted.has(x.toLowerCase())))
        .sort((a, b) => (b.launch_score ?? 0) - (a.launch_score ?? 0))[0];
      if (top) targets.push(top);
    }
    // De-dupe by id and hand off to the player's preloader.
    const seen = new Set<string>();
    const unique = targets.filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
    if (unique.length > 0) player.warmSongs(unique);
    // We intentionally don't depend on `player` here — warmSongs is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, hero, player.catalog]);

  // The vertical scroller is a FlatList — far more reliable than a ScrollView
  // when nested horizontal FlatLists are inside (which the old code had two
  // of: GenreChips + every Section). With ScrollView, native gesture
  // arbitration on iOS was claiming our vertical pans for the horizontal
  // children. FlatList sidesteps that entirely.
  //
  // Page order (per product spec):
  //   1. Header
  //   2. Top 6 genre chips
  //   3. Trending Now (the most-engaged surface comes right after genres)
  //   4. Featured #1 trending hero card
  //   5. Rising Fast / Most Replayed / … the rest of the sections
  return (
    <>
    <FlatList
      style={styles.root}
      data={sections}
      keyExtractor={(s) => s.id}
      ListHeaderComponent={
        <View style={{ paddingTop: spacing.md }}>
          <BrandHeader />
          <QuickActions
            onSurprise={() => {
              if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
              const c = player.catalog;
              if (c.length === 0) return;
              const pick = c[Math.floor(Math.random() * c.length)];
              if (pick) playSong(pick);
            }}
            onTopGlobal={() => {
              if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
              setTop30Open(true);
            }}
          />
          <MoodChipsRow
            onPick={(mood) => {
              // Personalized mood pick — reads the player's own recent
              // plays + interaction count so two users tapping the same
              // mood get different songs based on their taste.
              const list = player.buildMoodList(mood, 20);
              playList(list);
            }}
          />
        </View>
      }
      renderItem={({ item }) => {
        // Top Artists is rendered as portrait tiles rather than song tiles —
        // it sits in the same slot Boulevard Picks used to occupy.
        if (item.id === 'top_artists') {
          return (
            <TopArtistsShelf
              title={item.title}
              subtitle={item.subtitle}
              catalog={player.catalog}
              serverStats={serverStats}
              onOpenArtist={openArtistProfile}
            />
          );
        }
        const sectionView = (
          <Section
            section={item}
            serverStats={serverStats}
            onPlay={playSong}
          />
        );
        // Inject the featured hero after Trending Now per the layout spec.
        if (item.id === 'trending_now' && hero) {
          return (
            <View>
              {sectionView}
              <Hero
                ranked={hero}
                serverStats={serverStats}
                onPlay={() => playSong(hero.song)}
              />
            </View>
          );
        }
        return sectionView;
      }}
      ListFooterComponent={
        // Inline Top 30 — flat list view that lives at the BOTTOM of Explore,
        // after Weird Tracks + New Today + the rest of the shelves. Same
        // ranking the "Top 30 Global" pill opens, but always-visible and
        // scannable. Tap a row to play from that position.
        <Top30List
          catalog={player.catalog}
          serverStats={serverStats}
          onPlayFrom={(songs, idx) => playList(songs.slice(idx).concat(songs.slice(0, idx)))}
        />
      }
      contentContainerStyle={{ paddingBottom: 160 }}
      showsVerticalScrollIndicator={false}
    />
    <Top30Sheet
      visible={top30Open}
      catalog={player.catalog}
      serverStats={serverStats}
      onClose={() => setTop30Open(false)}
      onPlayAll={(songs) => { setTop30Open(false); playList(songs); }}
      onPlayFrom={(songs, idx) => {
        setTop30Open(false);
        playList(songs.slice(idx).concat(songs.slice(0, idx)));
      }}
    />
    </>
  );
}

// ---- Inline Top 30 list (Explore footer) -----------------------------
//
// A flat, scannable list view of the top 30 ranked songs that lives at
// the BOTTOM of Explore — after Weird Tracks, New Today and the other
// shelves. Same ranking as the "Top 30 Global" modal (trending_score →
// launch_score → stable hash) but always visible and scrollable inline.
// Designed for quick overview: rank · cover · title · artist · plays.

function Top30List({
  catalog,
  serverStats,
  onPlayFrom,
}: {
  catalog: Song[];
  serverStats: Map<string, SongStats>;
  onPlayFrom: (songs: Song[], idx: number) => void;
}) {
  const ranked = useMemo(() => {
    if (catalog.length === 0) return [] as Song[];
    const hashScore = (id: string) => {
      let h = 0;
      for (let i = 0; i < id.length; i++) { h = ((h << 5) - h) + id.charCodeAt(i); h |= 0; }
      return Math.abs(h) / 0x7fffffff;
    };
    const scored = catalog.map((song) => {
      const s = serverStats.get(song.id);
      const serverScore = s ? (s.trending_score * 1.0 + Math.log10(1 + s.plays) * 0.1) : 0;
      const editorial = song.launch_score ?? 0;
      const score = serverScore > 0 ? serverScore : editorial > 0 ? editorial : hashScore(song.id);
      return { song, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 30).map((x) => x.song);
  }, [catalog, serverStats]);

  if (ranked.length === 0) return null;

  return (
    <View style={top30ListStyles.section}>
      <View style={top30ListStyles.header}>
        <Text style={top30ListStyles.title}>Top 30 Global</Text>
        <Text style={top30ListStyles.subtitle}>Last 24h · most-streamed right now</Text>
      </View>
      {ranked.map((s, idx) => {
        const stat = serverStats.get(s.id);
        const plays = stat?.plays ?? 0;
        return (
          <Pressable
            key={s.id}
            onPress={() => onPlayFrom(ranked, idx)}
            style={({ pressed }) => [top30ListStyles.row, pressed && { opacity: 0.7 }]}
          >
            <Text style={top30ListStyles.rank}>{idx + 1}</Text>
            {s.cover_url ? (
              <Image
                source={{ uri: s.cover_url }}
                style={top30ListStyles.cover}
                contentFit="cover"
                cachePolicy="memory-disk"
                recyclingKey={s.id}
              />
            ) : (
              <View style={[top30ListStyles.cover, { backgroundColor: colors.surface }]} />
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={top30ListStyles.songTitle} numberOfLines={1}>{s.title}</Text>
              <Text style={top30ListStyles.songSub} numberOfLines={1}>
                {s.artist_name ?? s.genre}
              </Text>
            </View>
            <View style={top30ListStyles.statsCol}>
              <Text style={top30ListStyles.plays24h}>{formatPlays24h(plays)}</Text>
              <Text style={top30ListStyles.plays24hLabel}>24h</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * 24h stream count formatter — compact and right-aligned in the list row.
 * Shown for every Top 30 entry so the user can see relative momentum at
 * a glance: "0", "127", "4.2K", "38K", "1.4M".
 */
function formatPlays24h(plays: number): string {
  if (plays >= 1_000_000) return `${(plays / 1_000_000).toFixed(1)}M`;
  if (plays >= 10_000)    return `${Math.round(plays / 1000)}K`;
  if (plays >= 1_000)     return `${(plays / 1000).toFixed(1)}K`;
  return `${plays}`;
}

const top30ListStyles = StyleSheet.create({
  section: {
    marginTop: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
  header: {
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
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  rank: {
    color: colors.textDim,
    fontSize: fonts.size.sm,
    fontWeight: fonts.weight.bold,
    fontVariant: ['tabular-nums'],
    width: 24,
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

// ---- Top 30 Global sheet ---------------------------------------------
//
// Bottom-sheet that opens when the user taps the "Top 30 Global" pill.
// Shows the actual 30 ranked songs so the user can browse before playing.
// Ranking mirrors player.playPopular: trending_score → launch_score →
// stable hash, so the sheet shows the same chart the auto-play would have
// produced.

interface Top30SheetProps {
  visible: boolean;
  catalog: Song[];
  serverStats: Map<string, SongStats>;
  onClose: () => void;
  onPlayAll: (songs: Song[]) => void;
  onPlayFrom: (songs: Song[], idx: number) => void;
}

function Top30Sheet({ visible, catalog, serverStats, onClose, onPlayAll, onPlayFrom }: Top30SheetProps) {
  const ranked = useMemo(() => {
    if (catalog.length === 0) return [] as Song[];
    const hashScore = (id: string) => {
      let h = 0;
      for (let i = 0; i < id.length; i++) { h = ((h << 5) - h) + id.charCodeAt(i); h |= 0; }
      return Math.abs(h) / 0x7fffffff;
    };
    const scored = catalog.map((song) => {
      const s = serverStats.get(song.id);
      const serverScore = s ? (s.trending_score * 1.0 + Math.log10(1 + s.plays) * 0.1) : 0;
      const editorial = song.launch_score ?? 0;
      const score = serverScore > 0 ? serverScore : editorial > 0 ? editorial : hashScore(song.id);
      return { song, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 30).map((x) => x.song);
  }, [catalog, serverStats]);

  if (!visible) return null;
  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <Pressable style={top30Styles.backdrop} onPress={onClose}>
        <Pressable style={top30Styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={top30Styles.handle} />
          <View style={top30Styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={top30Styles.title}>Top 30 Global</Text>
              <Text style={top30Styles.subtitle}>{ranked.length} most-streamed right now</Text>
            </View>
            <Pressable
              onPress={() => onPlayAll(ranked)}
              disabled={ranked.length === 0}
              style={({ pressed }) => [top30Styles.playAll, ranked.length === 0 && { opacity: 0.4 }, pressed && { opacity: 0.85 }]}
            >
              <PlayIcon size={16} color={colors.bg} />
              <Text style={top30Styles.playAllText}>Play all</Text>
            </Pressable>
          </View>
          <ScrollView style={{ maxHeight: 580 }} showsVerticalScrollIndicator={false}>
            {ranked.map((s, idx) => {
              const plays = serverStats.get(s.id)?.plays ?? 0;
              return (
                <Pressable
                  key={s.id}
                  onPress={() => onPlayFrom(ranked, idx)}
                  style={({ pressed }) => [top30Styles.row, pressed && { opacity: 0.7 }]}
                >
                  <Text style={top30Styles.rank}>{idx + 1}</Text>
                  {s.cover_url ? (
                    <Image source={{ uri: s.cover_url }} style={top30Styles.cover} contentFit="cover" cachePolicy="memory-disk" recyclingKey={s.id} />
                  ) : (
                    <View style={[top30Styles.cover, { backgroundColor: colors.surface }]} />
                  )}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={top30Styles.songTitle} numberOfLines={1}>{s.title}</Text>
                    <Text style={top30Styles.songSub} numberOfLines={1}>{s.artist_name ?? s.genre}</Text>
                  </View>
                  <View style={top30ListStyles.statsCol}>
                    <Text style={top30ListStyles.plays24h}>{formatPlays24h(plays)}</Text>
                    <Text style={top30ListStyles.plays24hLabel}>24h</Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const top30Styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    maxHeight: '85%',
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md },
  title: { color: colors.text, fontSize: fonts.size.xl, fontWeight: fonts.weight.bold, letterSpacing: -0.3 },
  subtitle: { color: colors.textMuted, fontSize: fonts.size.sm, marginTop: 2 },
  playAll: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: spacing.md, paddingVertical: 10,
    borderRadius: radii.pill, backgroundColor: colors.text,
  },
  playAllText: { color: colors.bg, fontWeight: fonts.weight.bold, fontSize: fonts.size.sm },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider,
  },
  rank: { color: colors.textDim, fontSize: fonts.size.sm, fontWeight: fonts.weight.bold, fontVariant: ['tabular-nums'], width: 24, textAlign: 'right' },
  cover: { width: 48, height: 48, borderRadius: radii.sm },
  songTitle: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.semibold },
  songSub: { color: colors.textMuted, fontSize: fonts.size.xs, marginTop: 2 },
});

// ---- Genre tiles -----------------------------------------------------
//
// Fixed list of the top US listening genres. The tiles are always the same
// regardless of catalog composition. Each chip maps to one or more
// underlying genre slugs — when tapped, we play the highest-launch-score
// song in the live catalog that matches any of those slugs.
//
// Visual: 2-column grid of image-backed banner tiles. The tile's background
// image is the cover art of the highest-launch-score song in that genre,
// dimmed with a dark gradient so the genre label reads clearly on top.

// ---- Most Popular in US button -------------------------------------
//
// Prominent CTA at the top of Explore. One tap plays the top 30 songs
// nationwide, ranked by the live trending score from the server (with a
// cold-start fallback to editorial launch_score). The button is the
// single highest-affordance action on the screen.

// ---- Quick actions (Surprise Me + Top 30 Global) ----------------------
//
// Two side-by-side primary actions at the very top of Explore. Lets the
// user dive into something instantly without scanning genres first.

function QuickActions({ onSurprise, onTopGlobal }: { onSurprise: () => void; onTopGlobal: () => void }) {
  return (
    <View style={styles.quickRow}>
      <Pressable onPress={onSurprise} style={({ pressed }) => [styles.quickBtn, styles.quickSurprise, pressed && styles.quickPressed]} accessibilityLabel="Play a surprise song">
        <View style={styles.quickIconCircle}><ShuffleIcon size={20} color="#1a1408" /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.quickTitle}>Surprise me</Text>
          <Text style={styles.quickSub}>Random pick.</Text>
        </View>
      </Pressable>
      <Pressable onPress={onTopGlobal} style={({ pressed }) => [styles.quickBtn, styles.quickGlobal, pressed && styles.quickPressed]} accessibilityLabel="Play the top 30 global">
        <View style={styles.quickIconCircle}><TrendingIcon size={20} color="#1a1408" /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.quickTitle}>Top 30 Global</Text>
          <Text style={styles.quickSub}>Most streamed.</Text>
        </View>
      </Pressable>
    </View>
  );
}

// ---- Horizontal scrolling genre chips ---------------------------------
//
// Derived from the catalog itself — every unique `genre` becomes a chip.
// Sorted by song count so the most-populated genre leads. Tap = play that
// genre's full playlist sorted by launch_score. No mapping layer, so the
// chip label and the actual played songs always match.

function GenreChipsRow({ catalog, onPick }: { catalog: Song[]; onPick: (label: string) => void }) {
  const chips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of catalog) {
      const g = (s.genre ?? '').trim();
      if (!g) continue;
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count }));
  }, [catalog]);

  if (chips.length === 0) return null;

  return (
    <FlatList
      data={chips}
      keyExtractor={(c) => c.label}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chipsRow}
      renderItem={({ item }) => (
        <Pressable onPress={() => onPick(item.label)} style={({ pressed }) => [styles.chip, pressed && { opacity: 0.85 }]}>
          <Text style={styles.chipLabel}>{item.label}</Text>
          <Text style={styles.chipCount}>{item.count}</Text>
        </Pressable>
      )}
    />
  );
}

function PopularNowButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.popularBtn,
        pressed && { opacity: 0.92, transform: [{ scale: 0.992 }] },
      ]}
      accessibilityLabel="Play the most popular songs in the US"
    >
      {/* Warm gold gradient pulled from the Boulevard brand metals. */}
      <LinearGradient
        colors={['#e0c898', '#c8ae7a', '#8a6f3f']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.popularIcon}>
        <FlameIcon size={22} color="#1a1408" />
      </View>
      <View style={styles.popularBody}>
        <Text style={styles.popularTitle}>Most Popular in US</Text>
        <Text style={styles.popularSub}>Top 30 right now. Hit play.</Text>
      </View>
      <View style={styles.popularPlay}>
        <PlayIcon size={18} color="#1a1408" />
      </View>
    </Pressable>
  );
}

interface MainGenre {
  label: string;
  /** Lowercase slugs in the catalog that count as this surface genre. */
  slugs: string[];
  /** Locally-bundled cover image — bound via require() so Metro bundles it. */
  image: number;
}

// Each tile's image is curated to instantly communicate the genre at a
// glance — pop concert microphone, city-night rap mic, R&B neon dusk, indie
// bedroom poster wall, Texas cowboy at sunset, big-room DJ set.
const MAIN_GENRES: MainGenre[] = [
  {
    label: 'Pop',
    slugs: ['pop', 'dance pop', 'female pop', 'dark alt-pop', 'country pop', 'dream pop'],
    image: require('../../assets/genres/pop.jpg'),
  },
  {
    label: 'Rap',
    slugs: ['rap', 'hiphop', 'hip-hop', 'melodic rap', 'southern rap', 'trap', 'psy-trap'],
    image: require('../../assets/genres/rap.jpg'),
  },
  {
    label: 'R&B',
    slugs: ['rnb', 'r&b', 'late-night r&b'],
    image: require('../../assets/genres/rnb.jpg'),
  },
  {
    label: 'Indie',
    slugs: ['indie', 'indiepop', 'indie pop'],
    image: require('../../assets/genres/indie.jpg'),
  },
  {
    label: 'Country',
    slugs: ['country', 'country pop', 'americana'],
    image: require('../../assets/genres/country.jpg'),
  },
  {
    label: 'House',
    slugs: ['edm', 'electronic', 'house', 'techno', 'dance', 'experimental fusion'],
    image: require('../../assets/genres/house.jpg'),
  },
];

interface GenreGridProps {
  catalog: Song[];
  onPick: (genre: MainGenre, song: Song | null) => void;
}

function GenreGrid({ catalog, onPick }: GenreGridProps) {
  // Pre-compute the top song (and therefore the cover) per surface genre
  // once per catalog change. Each tile uses this song as both its visual
  // identity and the song that plays when the tile is tapped.
  const topPerGenre = useMemo(() => {
    const m = new Map<string, Song | null>();
    for (const g of MAIN_GENRES) {
      const wanted = new Set(g.slugs.map((s) => s.toLowerCase()));
      const candidates = catalog.filter((s) => {
        if (wanted.has((s.genre ?? '').toLowerCase())) return true;
        return (s.genres ?? []).some((x) => wanted.has(x.toLowerCase()));
      });
      candidates.sort((a, b) => (b.launch_score ?? 0) - (a.launch_score ?? 0));
      m.set(g.label, candidates[0] ?? null);
    }
    return m;
  }, [catalog]);

  return (
    <View style={styles.genreGrid}>
      {MAIN_GENRES.map((g) => {
        const top = topPerGenre.get(g.label) ?? null;
        return (
          <Pressable
            key={g.label}
            onPress={() => onPick(g, top)}
            style={({ pressed }) => [
              styles.genreTile,
              pressed && { opacity: 0.92, transform: [{ scale: 0.985 }] },
            ]}
          >
            {/* Full-bleed curated cover for this genre. */}
            <Image
              source={g.image}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              cachePolicy="memory-disk"
              recyclingKey={g.label}
            />
            {/* Bottom-up dark wash so the genre label always reads cleanly. */}
            <LinearGradient
              colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.78)']}
              locations={[0.45, 1]}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <Text style={styles.genreTileLabel}>{g.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---- Hero -----------------------------------------------------------

interface HeroProps {
  ranked: RankedSong;
  serverStats: Map<string, SongStats>;
  onPlay: () => void;
}

function Hero({ ranked, serverStats, onPlay }: HeroProps) {
  const { song } = ranked;
  const player = usePlayer();
  const plays = displayPlays(song.id, serverStats);
  const isCurrent = player.current?.id === song.id;
  const isPlaying = isCurrent && player.isPlaying;
  return (
    <Pressable onPress={onPlay} style={styles.hero}>
      <Image
        source={{ uri: song.artist_image_url ?? song.cover_url }}
        style={styles.heroImage}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={200}
        recyclingKey={song.id}
      />
      <LinearGradient
        colors={['transparent', 'transparent', 'rgba(10,10,12,0.85)', '#0a0a0c']}
        locations={[0, 0.35, 0.85, 1]}
        style={StyleSheet.absoluteFill}
      />
      {/* Hairline glass reflection along the top edge. */}
      <LinearGradient
        colors={[metals.glassHi, 'transparent']}
        locations={[0, 0.25]}
        style={styles.heroGlass}
        pointerEvents="none"
      />
      <View style={styles.heroBadge}>
        <FlameIcon size={12} color={metals.goldHi} />
        <Text style={styles.heroBadgeText}>#1 TRENDING</Text>
      </View>
      <View style={styles.heroFooter}>
        <Text style={styles.heroTitle} numberOfLines={1}>{song.title}</Text>
        <Text style={styles.heroMeta} numberOfLines={1}>
          {song.mood} · {song.genre} · {formatPlays(plays)} plays
        </Text>
        <View style={[styles.heroCta, isCurrent && styles.heroCtaActive]}>
          {isPlaying
            ? <PauseIcon size={16} color={colors.bg} />
            : <PlayIcon size={16} color={colors.bg} />}
          <Text style={styles.heroCtaText}>
            {isCurrent ? (isPlaying ? 'Playing' : 'Paused') : 'Play'}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

// ---- Section ---------------------------------------------------------

interface SectionProps {
  section: ExploreSection;
  serverStats: Map<string, SongStats>;
  onPlay: (s: Song) => void;
}

function Section({ section, serverStats, onPlay }: SectionProps) {
  const renderItem: ListRenderItem<RankedSong> = ({ item, index }) => (
    <Tile
      ranked={item}
      rank={index + 1}
      serverStats={serverStats}
      onPress={() => onPlay(item.song)}
      sectionId={section.id}
    />
  );
  const icon = section.id === 'trending_now' ? <TrendingIcon size={14} color={colors.text} /> :
                section.id === 'hidden_gems' ? <FlameIcon size={14} color={colors.text} /> : null;

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionTitleRow}>
          {icon}
          <Text style={styles.sectionTitle}>{section.title}</Text>
        </View>
      </View>
      <FlatList
        data={section.songs}
        keyExtractor={(item) => `${section.id}_${item.song.id}`}
        renderItem={renderItem}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        ItemSeparatorComponent={() => <View style={{ width: spacing.md }} />}
        // Lock the gesture to horizontal so a vertical pan inside a tile
        // bubbles up to the parent ScrollView instead of being eaten here.
        directionalLockEnabled
        nestedScrollEnabled
      />
    </View>
  );
}

// ---- Top Artists shelf -----------------------------------------------
//
// Replaces the old Boulevard Picks shelf. Renders the catalog's most-played
// artists in the last 24 hours as portrait tiles. Tapping an artist plays
// their highest-scoring song.
//
// Data source: today's `song_daily_stats.plays` aggregated by `artist_id`.
// When stats are empty (cold day, no traffic), falls back to launch_score
// so the shelf is never blank.

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
      // Use the SAME play count the song tiles show app-wide (deterministic
      // baseline + live server plays). Always a whole number, and an
      // artist's total now reads consistently with their own songs.
      const plays = displayPlays(song.id, serverStats);

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
        // Keep the artist's most-played song as the representative one.
        if (plays > displayPlays(existing.topSong.id, serverStats)) existing.topSong = song;
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
            {item.artistImageUrl ? (
              <Image
                source={{ uri: item.artistImageUrl }}
                style={styles.artistAvatar}
                contentFit="cover"
                cachePolicy="memory-disk"
                recyclingKey={item.artistId}
              />
            ) : (
              <View style={[styles.artistAvatar, { backgroundColor: colors.surface }]} />
            )}
            <View style={styles.artistRank}>
              <Text style={styles.artistRankText}>{index + 1}</Text>
            </View>
            <Text style={styles.artistName} numberOfLines={1}>{item.artistName}</Text>
            <Text style={styles.artistPlays}>
              {formatPlays(item.totalPlays)} plays
            </Text>
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
  // Single, consistent subtitle across every section: total plays. The
  // count grows as the server-side daily stats refresh (every ~5 min).
  const plays = displayPlays(song.id, serverStats);
  const subtitle = `${formatPlays(plays)} plays`;
  const isCurrent = player.current?.id === song.id;
  const isPlaying = isCurrent && player.isPlaying;

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.tile, pressed && { opacity: 0.85 }]}>
      <View style={styles.tileImageWrap}>
        <Image
          source={{ uri: song.artist_image_url ?? song.cover_url }}
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
        {/* Hairline reflection on the top edge of every tile. */}
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
      <Text style={styles.tileSubtitle} numberOfLines={1}>{isCurrent ? (isPlaying ? 'Playing now' : 'Paused') : subtitle}</Text>
    </Pressable>
  );
}

// ---- helpers ---------------------------------------------------------

function formatPlays(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  // Always a whole number — never leak a raw float into the UI.
  return String(Math.round(n));
}

// Deterministic per-song baseline play count, so the catalog has variety the
// moment it loads (rather than every song showing the same zero). Stable per
// song.id, so a given song always shows the same baseline. Real plays from
// the server are added on top in `displayPlays` below — so the number
// genuinely grows as people stream.
function baselinePlays(songId: string): number {
  let h = 0;
  for (let i = 0; i < songId.length; i++) {
    h = ((h << 5) - h) + songId.charCodeAt(i);
    h |= 0;
  }
  const MIN = 20_000;
  const MAX = 400_000;
  return MIN + (Math.abs(h) % (MAX - MIN));
}

function displayPlays(songId: string, serverStats: Map<string, SongStats>): number {
  return baselinePlays(songId) + (serverStats.get(songId)?.plays ?? 0);
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  headerRow: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  h1: {
    color: colors.text,
    fontSize: fonts.size.display,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.6,
  },
  sub: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    marginTop: 6,
    letterSpacing: 0.1,
  },

  // ---- Quick actions row (Surprise Me + Top 30 Global) ----
  quickRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  quickBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    borderRadius: radii.lg,
    overflow: 'hidden',
  },
  quickSurprise: { backgroundColor: '#e0c898' },
  quickGlobal: { backgroundColor: '#c5b489' },
  quickPressed: { opacity: 0.92, transform: [{ scale: 0.99 }] },
  quickIconCircle: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(26,20,8,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  quickTitle: {
    color: '#1a1408',
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.2,
  },
  quickSub: { color: 'rgba(26,20,8,0.72)', fontSize: 11, marginTop: 1 },

  // ---- Horizontal genre chips ----
  chipsRow: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: '#16181d',
    borderWidth: 1,
    borderColor: '#262932',
    borderRadius: 99,
  },
  chipLabel: { color: colors.text, fontSize: 13, fontWeight: '600' },
  chipCount: { color: colors.textMuted, fontSize: 11 },

  // Genre grid — 2-column image-backed tiles (legacy, retained for fallback)
  // ---- Most Popular in US button (top of Explore) ----
  popularBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.lg,
    overflow: 'hidden',
    // Soft lift so it reads as the screen's hero affordance.
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  popularIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(26,20,8,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  popularBody: {
    flex: 1,
    minWidth: 0,
  },
  popularTitle: {
    color: '#1a1408',
    fontSize: fonts.size.lg,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.2,
  },
  popularSub: {
    color: 'rgba(26,20,8,0.78)',
    fontSize: 12,
    marginTop: 2,
  },
  popularPlay: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },

  genreGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: spacing.lg,
    gap: spacing.sm + 2,
    marginBottom: spacing.lg,
  },
  genreTile: {
    width: '48.5%',
    // Taller tile gives the gradient + emoji watermark room to breathe.
    height: 110,
    borderRadius: radii.md,
    overflow: 'hidden',
    justifyContent: 'flex-end',
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
    // Subtle lift so the tiles read as cards rather than fills.
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 4,
  },
  genreTileLabel: {
    color: '#ffffff',
    // Bumped up — bolder label balances the larger tile + emoji watermark.
    fontSize: 22,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.3,
    // Drop-shadow keeps the label readable against any gradient stop.
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowRadius: 8,
    textShadowOffset: { width: 0, height: 2 },
  },

  // Hero
  hero: {
    height: HERO_H,
    marginHorizontal: spacing.lg,
    borderRadius: radii.xl,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    marginBottom: spacing.xl,
    // Ultra-subtle platinum outline + lifted shadow for depth.
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
    shadowColor: '#000',
    shadowOpacity: 0.55,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  heroGlass: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '22%',
  },
  heroImage: {
    ...StyleSheet.absoluteFillObject,
    width: undefined,
    height: undefined,
  },
  heroBadge: {
    position: 'absolute',
    top: 16,
    left: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
  },
  heroBadgeText: {
    color: colors.text,
    fontSize: 10,
    fontWeight: fonts.weight.bold,
    letterSpacing: 1.2,
  },
  heroFooter: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 20,
  },
  heroTitle: {
    color: colors.text,
    fontSize: fonts.size.xxl,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.4,
  },
  heroMeta: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    marginTop: 6,
    textTransform: 'capitalize',
    letterSpacing: 0.15,
  },
  heroCta: {
    marginTop: 14,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: radii.pill,
    backgroundColor: colors.text,
  },
  heroCtaActive: {
    backgroundColor: metals.goldHi,
  },
  heroCtaText: {
    color: colors.bg,
    fontWeight: fonts.weight.bold,
    fontSize: fonts.size.sm,
  },

  // Section
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

  // Top Artists tile — circular portrait + name + plays.
  artistTile: { width: CARD_W, alignItems: 'center' },
  artistAvatar: {
    width: CARD_W,
    height: CARD_W,
    borderRadius: CARD_W / 2,
    backgroundColor: colors.surface,
  },
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

  // Tile
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
