import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Dimensions,
  Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { usePlayer } from '@/contexts/PlayerContext';
import { useFollows } from '@/contexts/FollowsContext';
import { useAuth } from '@/contexts/AuthContext';
import { useAppNav } from '@/contexts/NavigationContext';
import { fetchTodayStats } from '@/lib/stats/SongStats';
import { fetchFollowerCount, bumpFollowerCache } from '@/lib/artists/artistFollowers';
import {
  buildArtistRadio,
  formatCount,
  getArtistById,
  getLatestDrops,
  getSimilarArtists,
  getTopSongs,
  songPlays,
} from '@/lib/artists/artistData';
import {
  ChevronLeftIcon,
  MoreIcon,
  PlayIcon,
  SparkleIcon,
  WaveformIcon,
} from '@/components/Icon';
import { Artwork } from '@/components/Artwork';
import type { Song, SongStats } from '@/types';

const { width: SCREEN_W } = Dimensions.get('window');
const HERO_H = Math.round(SCREEN_W * 1.05);

interface Props {
  artistId: string;
  /** Pop this profile off the navigation stack. */
  onBack: () => void;
}

// Full-screen artist profile. Sits above the active tab so the user can
// tap back and land on whatever they were doing — playback never stops,
// the BottomNav and MiniPlayer stay docked because RootNavigator renders
// them at root.

export function ArtistProfileScreen({ artistId, onBack }: Props) {
  const insets = useSafeAreaInsets();
  const player = usePlayer();
  const follows = useFollows();
  const auth = useAuth();
  const nav = useAppNav();

  // Pull fresh server stats when the screen opens so play counts on the
  // hero stat row and the top-songs list reflect today's traffic. The
  // fetcher caches for 5 min so re-opening is free.
  const [serverStats, setServerStats] = useState<Map<string, SongStats>>(new Map());
  useEffect(() => {
    let cancelled = false;
    fetchTodayStats()
      .then((m) => { if (!cancelled) setServerStats(m); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Followers come from a separate count query so we can show a real
  // social proof number. Null while loading; we display "0" in that case.
  const [followerCount, setFollowerCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchFollowerCount(artistId).then((n) => { if (!cancelled) setFollowerCount(n); });
    return () => { cancelled = true; };
  }, [artistId]);

  const artist = useMemo(
    () => getArtistById(player.catalog, artistId, serverStats, followerCount),
    [player.catalog, artistId, serverStats, followerCount],
  );
  const topSongs = useMemo(
    () => getTopSongs(player.catalog, artistId, serverStats, 5),
    [player.catalog, artistId, serverStats],
  );
  const allSongs = useMemo(
    () => getTopSongs(player.catalog, artistId, serverStats, 200),
    [player.catalog, artistId, serverStats],
  );
  const drops = useMemo(
    () => getLatestDrops(player.catalog, artistId, 6),
    [player.catalog, artistId],
  );
  const similar = useMemo(
    () => getSimilarArtists(player.catalog, artistId, serverStats, 8),
    [player.catalog, artistId, serverStats],
  );

  const following = follows.isFollowing(artistId);

  // Gate every social write behind signup — same pattern as
  // PlayerFeedScreen so the flow feels consistent.
  const requireSignup = useCallback((): boolean => {
    if (auth.isAnonymous) {
      nav.openSignup();
      return true;
    }
    return false;
  }, [auth.isAnonymous, nav]);

  const tap = useCallback(() => {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
  }, []);

  const onToggleFollow = useCallback(() => {
    tap();
    if (requireSignup()) return;
    // Read the live follow state at click time rather than the value
    // captured in this closure. Two rapid taps would otherwise both see
    // the pre-tap value and double-bump the count in the same direction.
    const wasFollowing = follows.isFollowing(artistId);
    const delta = wasFollowing ? -1 : 1;
    bumpFollowerCache(artistId, delta);
    setFollowerCount((c) => (c == null ? c : Math.max(0, c + delta)));
    void follows.toggleFollow(artistId);
  }, [tap, requireSignup, follows, artistId]);

  const onPlayTop = useCallback(() => {
    tap();
    if (topSongs.length === 0) return;
    void player.playPlaylist(topSongs);
    nav.openPlayer();
  }, [tap, topSongs, player, nav]);

  const onStartRadio = useCallback(() => {
    tap();
    const radio = buildArtistRadio(player.catalog, artistId, serverStats, 30);
    if (radio.length === 0) return;
    void player.playPlaylist(radio);
    nav.openPlayer();
  }, [tap, player, artistId, serverStats, nav]);

  const onPlaySong = useCallback((s: Song) => {
    tap();
    void player.playSpecific(s);
    nav.openPlayer();
  }, [tap, player, nav]);

  const onOpenSimilar = useCallback((id: string) => {
    tap();
    nav.openArtistProfile(id);
  }, [tap, nav]);

  if (!artist) {
    return (
      <View style={[styles.root, styles.empty]}>
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <Pressable hitSlop={12} onPress={onBack} style={styles.iconBtn}>
            <ChevronLeftIcon size={22} color={colors.text} />
          </Pressable>
          <View style={{ flex: 1 }} />
          <View style={styles.iconBtn} />
        </View>
        <Text style={styles.emptyTitle}>Artist not available</Text>
        <Text style={styles.emptySub}>This artist isn't in the catalog right now.</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 200 }}
      >
        {/* Hero — full-bleed cinematic image with a long fade into the page.
            Falls back to a seeded gradient + initial when the artist has no
            portrait so the hero is never a flat grey block. */}
        <View style={[styles.hero, { height: HERO_H }]}>
          <Artwork
            uri={artist.image_url}
            name={artist.name}
            fill
            recyclingKey={artist.id}
          />
          {/* Soft top vignette so the back / more buttons read against any image. */}
          <LinearGradient
            colors={['rgba(10,10,12,0.55)', 'transparent']}
            locations={[0, 0.35]}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          {/* Long bottom fade into pure background. */}
          <LinearGradient
            colors={[
              'rgba(10,10,12,0)',
              'rgba(10,10,12,0.20)',
              'rgba(10,10,12,0.65)',
              'rgba(10,10,12,0.92)',
              colors.bg,
            ]}
            locations={[0.30, 0.50, 0.72, 0.88, 1]}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />

          {/* Artist meta pinned to the bottom of the hero. */}
          <View style={[styles.heroMeta, { paddingBottom: spacing.md }]}>
            <View style={styles.nameRow}>
              <Text style={styles.name} numberOfLines={2}>{artist.name}</Text>
              <View style={styles.verifiedDot}>
                <SparkleIcon size={11} color={metals.goldHi} />
              </View>
            </View>

            {/* Stats row. Followers fall back to "0" while the count
                query is in flight so the layout never shows blanks. */}
            <View style={styles.statsRow}>
              <Stat label="Songs" value={formatCount(artist.song_count)} />
              <View style={styles.statDivider} />
              <Stat label="Monthly Listeners" value={formatCount(artist.monthly_listeners)} />
              <View style={styles.statDivider} />
              <Stat
                label="Followers"
                value={formatCount(artist.follower_count ?? 0)}
              />
            </View>
          </View>
        </View>

        {/* Primary actions — Follow + Play Top + Start Radio. */}
        <View style={styles.actionsRow}>
          <Pressable
            onPress={onToggleFollow}
            style={({ pressed }) => [
              styles.followBtn,
              following && styles.followBtnOn,
              pressed && { opacity: 0.85 },
            ]}
            accessibilityLabel={following ? 'Unfollow artist' : 'Follow artist'}
          >
            <Text style={[styles.followBtnText, following && styles.followBtnTextOn]}>
              {following ? '✓ Following' : '+ Follow'}
            </Text>
          </Pressable>

          <Pressable
            onPress={onPlayTop}
            disabled={topSongs.length === 0}
            style={({ pressed }) => [
              styles.primaryBtn,
              topSongs.length === 0 && { opacity: 0.4 },
              pressed && { opacity: 0.85 },
            ]}
            accessibilityLabel="Play top songs"
          >
            <PlayIcon size={16} color={colors.bg} />
            <Text style={styles.primaryBtnText}>Play Top</Text>
          </Pressable>

          <Pressable
            onPress={onStartRadio}
            style={({ pressed }) => [styles.ghostBtn, pressed && { opacity: 0.85 }]}
            accessibilityLabel="Start radio"
          >
            <WaveformIcon size={16} color={colors.text} />
            <Text style={styles.ghostBtnText}>Radio</Text>
          </Pressable>
        </View>

        {/* Top Songs. */}
        {topSongs.length > 0 ? (
          <Section title="Top Songs">
            {topSongs.map((s, idx) => (
              <SongRow
                key={s.id}
                rank={idx + 1}
                song={s}
                plays={songPlays(s, serverStats)}
                isCurrent={player.current?.id === s.id}
                isPlaying={player.current?.id === s.id && player.isPlaying}
                onPress={() => onPlaySong(s)}
              />
            ))}
            {allSongs.length > topSongs.length ? (
              <Pressable
                onPress={() => {
                  tap();
                  void player.playPlaylist(allSongs);
                  nav.openPlayer();
                }}
                style={({ pressed }) => [styles.seeAll, pressed && { opacity: 0.7 }]}
              >
                <Text style={styles.seeAllText}>See all {allSongs.length} songs</Text>
              </Pressable>
            ) : null}
          </Section>
        ) : null}

        {/* Latest Drops — horizontal cards. */}
        {drops.length > 0 ? (
          <Section title="Latest Drops">
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.dropsRow}
            >
              {drops.map((s) => (
                <DropCard
                  key={s.id}
                  song={s}
                  onPress={() => onPlaySong(s)}
                />
              ))}
            </ScrollView>
          </Section>
        ) : null}

        {/* Similar Artists — circular avatars. */}
        {similar.length > 0 ? (
          <Section title="Similar Artists">
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.similarRow}
            >
              {similar.map((a) => (
                <Pressable
                  key={a.id}
                  onPress={() => onOpenSimilar(a.id)}
                  style={({ pressed }) => [styles.similarTile, pressed && { opacity: 0.85 }]}
                >
                  <Artwork
                    uri={a.image_url}
                    name={a.name}
                    size={SIMILAR_W}
                    circle
                    recyclingKey={a.id}
                    style={styles.similarAvatar}
                  />
                  <Text style={styles.similarName} numberOfLines={1}>{a.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </Section>
        ) : null}
      </ScrollView>

      {/* Top bar — back + more. Floats above the hero so it sits on top of
          any image. */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <Pressable hitSlop={12} onPress={onBack} style={styles.iconBtn}>
          <ChevronLeftIcon size={22} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable hitSlop={12} onPress={tap} style={styles.iconBtn}>
          <MoreIcon size={20} color={colors.text} />
        </Pressable>
      </View>
    </View>
  );
}

// ---- subcomponents ---------------------------------------------------

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statCol}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function SongRow({
  rank,
  song,
  plays,
  isCurrent,
  isPlaying,
  onPress,
}: {
  rank: number;
  song: Song;
  plays: number;
  isCurrent: boolean;
  isPlaying: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.songRow, pressed && { opacity: 0.7 }]}
    >
      <Text style={[styles.songRank, isCurrent && { color: metals.goldSolidHi }]}>{rank}</Text>
      <Artwork
        uri={song.cover_url ?? song.artist_image_url}
        name={song.title}
        size={48}
        radius={8}
        recyclingKey={song.id}
        style={styles.songArt}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.songTitle, isCurrent && { color: metals.goldSolidHi }]} numberOfLines={1}>
          {song.title}
        </Text>
        <Text style={styles.songSub} numberOfLines={1}>
          {isCurrent && isPlaying ? 'Playing now' : `${formatCount(plays)} plays`}
        </Text>
      </View>
      <Pressable
        hitSlop={10}
        onPress={(e) => { e.stopPropagation(); onPress(); }}
        style={({ pressed }) => [styles.songPlay, pressed && { opacity: 0.7 }]}
        accessibilityLabel="Play"
      >
        <PlayIcon size={18} color={colors.text} />
      </Pressable>
    </Pressable>
  );
}

function DropCard({ song, onPress }: { song: Song; onPress: () => void }) {
  // Release date — created_at when present, otherwise "New" so the card
  // never shows undefined.
  const date = song.created_at ? formatDate(song.created_at) : 'New';
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.dropCard, pressed && { opacity: 0.85 }]}
    >
      <Artwork
        uri={song.cover_url ?? song.artist_image_url}
        name={song.title}
        size={DROP_W}
        radius={radii.md}
        recyclingKey={song.id}
        style={styles.dropArt}
      />
      <View style={styles.dropPlay}>
        <PlayIcon size={14} color={colors.bg} />
      </View>
      <Text style={styles.dropTitle} numberOfLines={1}>{song.title}</Text>
      <Text style={styles.dropDate} numberOfLines={1}>Single  ·  {date}</Text>
    </Pressable>
  );
}

function formatDate(iso: string): string {
  // YYYY-MM-DD → "May 14, 2026" style, falling back to the raw string when
  // the date can't be parsed (malformed catalog row).
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const DROP_W = 156;
const SIMILAR_W = 88;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  empty: { alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyTitle: { color: colors.text, fontSize: fonts.size.xl, fontWeight: fonts.weight.bold, marginTop: spacing.lg },
  emptySub: { color: colors.textMuted, fontSize: fonts.size.sm, marginTop: spacing.xs, textAlign: 'center' },

  topBar: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },

  hero: {
    width: '100%',
    justifyContent: 'flex-end',
  },
  heroMeta: {
    paddingHorizontal: spacing.lg,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  name: {
    color: colors.text,
    fontSize: fonts.size.display,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.6,
    flexShrink: 1,
  },
  verifiedDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20,20,24,0.65)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.md,
    gap: spacing.md,
  },
  statCol: { flexShrink: 1 },
  statValue: {
    color: colors.text,
    fontSize: fonts.size.lg,
    fontWeight: fonts.weight.bold,
    letterSpacing: 0.2,
  },
  statLabel: {
    color: colors.textMuted,
    fontSize: fonts.size.xs,
    marginTop: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    height: 28,
    backgroundColor: metals.platinum,
  },

  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  followBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
    backgroundColor: 'transparent',
  },
  followBtnOn: {
    backgroundColor: metals.gold,
    borderColor: metals.gold,
  },
  followBtnText: {
    color: colors.text,
    fontSize: fonts.size.sm,
    fontWeight: fonts.weight.semibold,
    letterSpacing: 0.3,
  },
  followBtnTextOn: { color: '#1a1408' },

  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radii.pill,
    backgroundColor: metals.goldSolid,
  },
  primaryBtnText: {
    color: colors.bg,
    fontSize: fonts.size.sm,
    fontWeight: fonts.weight.bold,
    letterSpacing: 0.3,
  },

  ghostBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
    backgroundColor: 'rgba(20,20,24,0.55)',
  },
  ghostBtnText: {
    color: colors.text,
    fontSize: fonts.size.sm,
    fontWeight: fonts.weight.semibold,
    letterSpacing: 0.3,
  },

  section: {
    marginTop: spacing.xl,
    paddingHorizontal: 0,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: fonts.size.lg,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.2,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },

  songRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
  },
  songRank: {
    color: colors.textMuted,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.semibold,
    width: 20,
    textAlign: 'center',
  },
  songArt: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: colors.surface,
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
  songPlay: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  seeAll: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  seeAllText: {
    color: metals.goldSolidHi,
    fontSize: fonts.size.sm,
    fontWeight: fonts.weight.semibold,
  },

  dropsRow: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  dropCard: {
    width: DROP_W,
  },
  dropArt: {
    width: DROP_W,
    height: DROP_W,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  dropPlay: {
    position: 'absolute',
    right: 8,
    top: DROP_W - 32,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: metals.goldSolid,
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  dropTitle: {
    color: colors.text,
    fontSize: fonts.size.sm,
    fontWeight: fonts.weight.semibold,
    marginTop: spacing.sm,
  },
  dropDate: {
    color: colors.textMuted,
    fontSize: fonts.size.xs,
    marginTop: 2,
  },

  similarRow: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  similarTile: {
    width: SIMILAR_W,
    alignItems: 'center',
  },
  similarAvatar: {
    width: SIMILAR_W,
    height: SIMILAR_W,
    borderRadius: SIMILAR_W / 2,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  similarName: {
    color: colors.text,
    fontSize: fonts.size.xs,
    fontWeight: fonts.weight.semibold,
    marginTop: spacing.xs,
    textAlign: 'center',
  },
});
