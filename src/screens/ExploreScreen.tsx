import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  Dimensions,
  ListRenderItem,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { usePlayer } from '@/contexts/PlayerContext';
import { buildExplore, ExploreSection, pickHero, RankedSong } from '@/lib/ranking/Trending';
import { fetchTodayStats } from '@/lib/stats/SongStats';
import { SongStats } from '@/types';
import { PlayIcon, SparkleIcon, FlameIcon, TrendingIcon } from '@/components/Icon';
import { BrandHeader } from '@/components/BrandHeader';
import { Song } from '@/types';

const { width } = Dimensions.get('window');
const HERO_H = Math.round(width * 0.95);
const CARD_W = 168;
const CARD_H = 168;

export function ExploreScreen() {
  const insets = useSafeAreaInsets();
  const player = usePlayer();

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
    if (hero) urls.add(hero.song.cover_url);
    for (const s of sections) for (const r of s.songs) urls.add(r.song.cover_url);
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
    <FlatList
      style={styles.root}
      data={sections}
      keyExtractor={(s) => s.id}
      ListHeaderComponent={
        <View style={{ paddingTop: spacing.md }}>
          <BrandHeader />
          <GenreGrid
            catalog={player.catalog}
            onPick={(_genre, song) => {
              if (song) { player.playSpecific(song); return; }
              // Genre had no direct match — fall back to overall top.
              const fallback = [...player.catalog].sort(
                (a, b) => (b.launch_score ?? 0) - (a.launch_score ?? 0),
              )[0];
              if (fallback) player.playSpecific(fallback);
            }}
          />
        </View>
      }
      renderItem={({ item }) => {
        const sectionView = <Section section={item} onPlay={(s) => player.playSpecific(s)} />;
        // Inject the featured hero after Trending Now per the layout spec.
        if (item.id === 'trending_now' && hero) {
          return (
            <View>
              {sectionView}
              <Hero ranked={hero} onPlay={() => player.playSpecific(hero.song)} />
            </View>
          );
        }
        return sectionView;
      }}
      contentContainerStyle={{ paddingBottom: 160 }}
      showsVerticalScrollIndicator={false}
    />
  );
}

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
  onPlay: () => void;
}

function Hero({ ranked, onPlay }: HeroProps) {
  const { song, metrics } = ranked;
  return (
    <Pressable onPress={onPlay} style={styles.hero}>
      <Image
        source={{ uri: song.cover_url }}
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
          {song.mood} · {song.genre} · {formatPlays(metrics.plays_24h)} plays today
        </Text>
        <View style={styles.heroCta}>
          <PlayIcon size={16} color={colors.bg} />
          <Text style={styles.heroCtaText}>Play</Text>
        </View>
      </View>
    </Pressable>
  );
}

// ---- Section ---------------------------------------------------------

interface SectionProps {
  section: ExploreSection;
  onPlay: (s: Song) => void;
}

function Section({ section, onPlay }: SectionProps) {
  const renderItem: ListRenderItem<RankedSong> = ({ item, index }) => (
    <Tile ranked={item} rank={index + 1} onPress={() => onPlay(item.song)} sectionId={section.id} />
  );
  const icon = section.id === 'trending_now' ? <TrendingIcon size={14} color={colors.text} /> :
                section.id === 'rising_fast' ? <FlameIcon size={14} color={colors.text} /> :
                section.id === 'boulevard_picks' ? <SparkleIcon size={14} color={colors.text} /> : null;

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionTitleRow}>
          {icon}
          <Text style={styles.sectionTitle}>{section.title}</Text>
        </View>
        <Text style={styles.sectionSubtitle}>{section.subtitle}</Text>
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

// ---- Tile ------------------------------------------------------------

interface TileProps {
  ranked: RankedSong;
  rank: number;
  sectionId: string;
  onPress: () => void;
}

function Tile({ ranked, rank, sectionId, onPress }: TileProps) {
  const { song, metrics } = ranked;
  // Per-section subtitle so each carousel feels distinct.
  const subtitle = (() => {
    if (sectionId === 'trending_now') return `${formatPlays(metrics.plays_24h)} plays today`;
    if (sectionId === 'rising_fast') {
      const prev = Math.max(1, metrics.plays_prev_day);
      const pct = Math.round(((metrics.plays_24h - prev) / prev) * 100);
      return pct > 0 ? `+${pct}% today` : `${pct}% today`;
    }
    if (sectionId === 'most_replayed') {
      const rate = metrics.plays_24h > 0 ? metrics.replays / metrics.plays_24h : 0;
      return `${Math.round(rate * 100)}% replay rate`;
    }
    if (sectionId === 'new_today') return 'New';
    return `${song.mood} · ${song.genre}`;
  })();

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.tile, pressed && { opacity: 0.85 }]}>
      <View style={styles.tileImageWrap}>
        <Image
          source={{ uri: song.cover_url }}
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
        {(sectionId === 'trending_now' || sectionId === 'rising_fast') && rank <= 3 && (
          <View style={styles.rankBadge}>
            <Text style={styles.rankText}>{rank}</Text>
          </View>
        )}
        <View style={styles.tilePlayBubble}>
          <PlayIcon size={14} color={colors.bg} />
        </View>
      </View>
      <Text style={styles.tileTitle} numberOfLines={1}>{song.title}</Text>
      <Text style={styles.tileSubtitle} numberOfLines={1}>{subtitle}</Text>
    </Pressable>
  );
}

// ---- helpers ---------------------------------------------------------

function formatPlays(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
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

  // Genre grid — 2-column image-backed tiles
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
