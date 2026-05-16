import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Modal,
  Platform,
  TextInput,
  Alert,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { usePlayer } from '@/contexts/PlayerContext';
import { useAuth } from '@/contexts/AuthContext';
import { useFollows } from '@/contexts/FollowsContext';
import { usePlaylists, UserPlaylist } from '@/contexts/PlaylistsContext';
import { useAppNav } from '@/contexts/NavigationContext';
import { BrandHeader } from '@/components/BrandHeader';
import { PlayIcon, SparkleIcon, CheckIcon, CloseIcon, MoreIcon } from '@/components/Icon';
import { Song } from '@/types';
import {
  buildFromYourFollows,
  buildNewForYou,
  buildSaved,
  buildDailyYou,
  pickTopGenres,
  BuiltPlaylist,
} from '@/lib/playlists/builders';

// Library — the personal hub. Top half is the AI personalization tracker; the
// rest is the four dynamic playlists computed from the user's listening data
// and the live catalog.
//
// The playlists rebuild whenever the underlying inputs change (catalog,
// taste profile, library), so saves and skips immediately influence what
// shows up the next time the user lands here.

const UNLOCK_THRESHOLD = 20;

export function LibraryScreen() {
  const player = usePlayer();
  const auth = useAuth();
  const follows = useFollows();
  const { playlists: userPlaylists, create, rename, remove } = usePlaylists();
  const { openPlayer, openSignup, openArtistProfile } = useAppNav();
  const [editing, setEditing] = useState<UserPlaylist | null>(null);
  const [detail, setDetail] = useState<UserPlaylist | null>(null);
  // "Create playlist" state. When non-null, the small naming modal is up.
  // Tracks the typed name + an in-flight flag so a double-tap can't
  // double-create. Anonymous users get the SignupSheet instead of the
  // create flow (same gating as comments).
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  // The modal opens exactly once per account, the moment songsHeard crosses
  // 100 while `personalizationUnlockedAt` is still null. We do NOT key off
  // a local boolean alone — a tab re-mount would re-open the modal. Once
  // we've marked unlock in AsyncStorage, the effect's guard prevents re-firing.
  const [unlockModalOpen, setUnlockModalOpen] = useState(false);
  const unlockShownRef = useRef(false);

  // Library playlists. Each rebuilds when its inputs change — saves
  // immediately reshape Daily You, and skips flow through into "New For
  // You" via the taste profile the recommender reads.
  //
  // Layout:
  //   1. Saved (only when non-empty)
  //   2. From Your Follows (only when non-empty)
  //   3. New For You
  //   4-6. Daily You #1, #2, #3 — one per top genre, picked from the
  //        user's taste profile (or library / catalog fallback). Each
  //        Daily You is the same engine as the queue, just locked to
  //        a single genre.
  const playlists: BuiltPlaylist[] = useMemo(() => {
    const topGenres = pickTopGenres(player.catalog, player.library, player.taste, 3);
    return [
      buildSaved(player.library),
      buildFromYourFollows(player.catalog, follows.followedArtistIds),
      buildNewForYou(
        player.catalog,
        player.library,
        player.taste,
        [],                       // recent — pulled inside via library
        auth.songsHeard,
      ),
      buildDailyYou(player.catalog, player.taste, [], auth.songsHeard, topGenres[0], 1),
      buildDailyYou(player.catalog, player.taste, [], auth.songsHeard, topGenres[1], 2),
      buildDailyYou(player.catalog, player.taste, [], auth.songsHeard, topGenres[2], 3),
    ].filter((p) => {
      // Hide Saved / Follows tiles entirely when empty (they read as
      // empty CTAs more than playlists). Daily You tiles also hide
      // when their genre had no matches in the catalog.
      if (p.id === 'saved' || p.id === 'from_your_follows') {
        return p.songs.length > 0;
      }
      if (p.id === 'daily_you_1' || p.id === 'daily_you_2' || p.id === 'daily_you_3') {
        return p.songs.length > 0;
      }
      return true;
    });
  }, [
    player.catalog,
    player.library,
    player.libraryVersion,
    player.taste,
    auth.songsHeard,
    follows.followedArtistIds,
  ]);

  // Fire the unlock celebration the first time songsHeard crosses the
  // threshold WITHIN THIS SESSION. The persistent flag ensures we never
  // re-show across launches; the per-session ref ensures we don't re-show
  // on Library re-mount during the same session.
  //
  // Also fires a local push notification so the unlock lands as a "real"
  // milestone even if the user is in the background when they hit 100.
  useEffect(() => {
    if (unlockShownRef.current) return;
    if (auth.personalizationUnlockedAt) return;
    if (auth.songsHeard < UNLOCK_THRESHOLD) return;
    unlockShownRef.current = true;
    setUnlockModalOpen(true);
    auth.markPersonalizationUnlocked().catch(() => {});
    if (Platform.OS !== 'web') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        .catch(() => {});
    }
    // Best-effort local notification. Permission was requested at app
    // launch (App.tsx); if the user denied, this resolves silently. Web has
    // no local notifications, so the in-app unlock modal is the only signal.
    if (Platform.OS !== 'web') {
      Notifications.scheduleNotificationAsync({
        content: {
          title: 'Your AI is now listening',
          body: 'Boulevard learned your taste. Your personalized playlists are ready.',
          sound: 'default',
        },
        trigger: null, // fire immediately
      }).catch(() => {});
    }
  }, [auth.songsHeard, auth.personalizationUnlockedAt, auth.markPersonalizationUnlocked]);

  const onPlayPlaylist = (p: BuiltPlaylist) => {
    if (p.songs.length === 0) return;
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    void player.playPlaylist(p.songs);
    openPlayer();
  };

  // Hydrate a user-created playlist into actual Song objects from the live
  // catalog, preserving the user's add order. Songs that no longer exist in
  // the catalog (e.g. unpublished) are silently dropped.
  const songsForPlaylist = (p: UserPlaylist): Song[] => {
    const byId = new Map(player.catalog.map((s) => [s.id, s]));
    return p.song_ids.map((id) => byId.get(id)).filter((s): s is Song => !!s);
  };

  const onPlayUserPlaylist = (p: UserPlaylist) => {
    const songs = songsForPlaylist(p);
    if (songs.length === 0) return;
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    void player.playPlaylist(songs);
    openPlayer();
  };

  // Open the playlist detail sheet AND stage its newest song in the player,
  // so the play button is pre-loaded the instant the user lands here instead
  // of an empty player. "Newest" = most recently released (created_at), not
  // most recently added. cuePlaylist no-ops if a song is already playing.
  const onOpenUserPlaylist = (p: UserPlaylist) => {
    setDetail(p);
    const songs = songsForPlaylist(p);
    if (songs.length === 0) return;
    let newest = songs[0];
    for (const s of songs) {
      const st = s.created_at ? new Date(s.created_at).getTime() : 0;
      const nt = newest.created_at ? new Date(newest.created_at).getTime() : 0;
      if (st > nt) newest = s;
    }
    void player.cuePlaylist([newest, ...songs.filter((s) => s.id !== newest.id)]);
  };

  /** Play a playlist starting at a specific song. */
  const onPlayFrom = (p: UserPlaylist, startId: string) => {
    const all = songsForPlaylist(p);
    const idx = all.findIndex((s) => s.id === startId);
    if (idx < 0) return;
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    void player.playPlaylist(all.slice(idx).concat(all.slice(0, idx)));
    openPlayer();
  };

  const onDeleteUserPlaylist = (p: UserPlaylist) => {
    Alert.alert(
      'Delete playlist?',
      `"${p.name}" will be removed. Songs themselves stay in your library.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => { void remove(p.id); setEditing(null); } },
      ],
    );
  };

  return (
    <View style={[styles.root, { paddingTop: spacing.md }]}>
      <BrandHeader />

      <ScrollView
        contentContainerStyle={{ paddingBottom: 160 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.h1}>Library</Text>

        {/* Card disappears after unlock (20 songs heard + notification fired). */}
        {!auth.personalizationUnlockedAt && (
          <PersonalizationCard
            songsHeard={auth.songsHeard}
            unlocked={false}
          />
        )}

        <FollowedArtistsRow
          catalog={player.catalog}
          followedIds={follows.followedArtistIds}
          onOpenArtist={(artistId) => {
            if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
            openArtistProfile(artistId);
          }}
        />

        <View style={styles.sectionHRow}>
          <Text style={styles.sectionH}>Your playlists</Text>
          <Pressable
            onPress={() => {
              // Anonymous users can't create playlists. Same gate as comments:
              // open SignupSheet instead of letting them type a name they
              // can't save. Once signed up they can come back and tap again.
              if (auth.isAnonymous) {
                openSignup();
                return;
              }
              setNewName('');
              setCreatingOpen(true);
            }}
            hitSlop={10}
            style={({ pressed }) => [
              styles.addPlaylistBtn,
              pressed && { opacity: 0.85 },
            ]}
            accessibilityLabel="Create playlist"
          >
            <Text style={styles.addPlaylistPlus}>+</Text>
          </Pressable>
        </View>
        {userPlaylists.length > 0 ? (
          <View style={styles.playlistGroup}>
            {userPlaylists.map((p) => (
              <UserPlaylistTile
                key={p.id}
                playlist={p}
                coverUri={(() => {
                  const id = p.cover_song_id ?? p.song_ids[0];
                  if (!id) return null;
                  return player.catalog.find((s) => s.id === id)?.cover_url ?? null;
                })()}
                onPress={() => onOpenUserPlaylist(p)}
                onEdit={() => setEditing(p)}
              />
            ))}
          </View>
        ) : (
          // Empty state. Without this the entire section disappeared when the
          // user had no playlists yet, which hid the feature itself.
          <Text style={styles.emptyPlaylistsHint}>
            Tap the bookmark icon on any song to add it to a playlist.
          </Text>
        )}

        <Text style={styles.sectionH}>For you</Text>
        <View style={styles.playlistGroup}>
          {playlists.map((p) => (
            <PlaylistTile key={p.id} playlist={p} onPress={() => onPlayPlaylist(p)} />
          ))}
        </View>
      </ScrollView>

      <UnlockModal
        visible={unlockModalOpen}
        onClose={() => setUnlockModalOpen(false)}
      />

      <EditPlaylistModal
        playlist={editing}
        onClose={() => setEditing(null)}
        onRename={(name) => { if (editing) void rename(editing.id, name); setEditing(null); }}
        onDelete={() => { if (editing) onDeleteUserPlaylist(editing); }}
      />

      <PlaylistDetailSheet
        playlist={detail}
        songs={detail ? songsForPlaylist(detail) : []}
        onClose={() => setDetail(null)}
        onPlayAll={() => { if (detail) { onPlayUserPlaylist(detail); setDetail(null); } }}
        onPlayFrom={(songId) => { if (detail) { onPlayFrom(detail, songId); setDetail(null); } }}
        onOpenArtist={(artistId) => {
          // RN <Modal> stacks above any in-tree overlay, so we close the
          // sheet first or the artist page would render behind it.
          setDetail(null);
          openArtistProfile(artistId);
        }}
      />

      {/* Create-playlist naming modal. Small, centered, single field +
          Save / Cancel. Confirms with the PlaylistsContext.create call;
          new playlist appears at the top of the list on success. */}
      <Modal
        visible={creatingOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setCreatingOpen(false)}
      >
        <Pressable
          style={styles.createBackdrop}
          onPress={() => setCreatingOpen(false)}
        >
          <Pressable style={styles.createSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.createTitle}>New playlist</Text>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder="Playlist name"
              placeholderTextColor={colors.textDim}
              style={styles.createInput}
              maxLength={60}
              autoFocus
              returnKeyType="done"
              editable={!creating}
              onSubmitEditing={async () => {
                if (!newName.trim() || creating) return;
                setCreating(true);
                const pl = await create(newName);
                setCreating(false);
                if (pl) {
                  setCreatingOpen(false);
                  setNewName('');
                } else {
                  Alert.alert('Could not create playlist', 'Please try again.');
                }
              }}
            />
            <View style={styles.createActions}>
              <Pressable
                onPress={() => setCreatingOpen(false)}
                disabled={creating}
                hitSlop={8}
                style={styles.createCancelBtn}
              >
                <Text style={styles.createCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={async () => {
                  if (!newName.trim() || creating) return;
                  setCreating(true);
                  const pl = await create(newName);
                  setCreating(false);
                  if (pl) {
                    setCreatingOpen(false);
                    setNewName('');
                  } else {
                    Alert.alert('Could not create playlist', 'Please try again.');
                  }
                }}
                disabled={creating || !newName.trim()}
                hitSlop={8}
                style={[
                  styles.createSaveBtn,
                  (!newName.trim() || creating) && { opacity: 0.5 },
                ]}
              >
                <Text style={styles.createSaveText}>{creating ? 'Saving…' : 'Save'}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// ---- AI Personalization card ----------------------------------------

interface PersonalizationCardProps {
  songsHeard: number;
  unlocked: boolean;
}

function PersonalizationCard({ songsHeard, unlocked }: PersonalizationCardProps) {
  const progress = Math.min(1, songsHeard / UNLOCK_THRESHOLD);
  const count = Math.min(UNLOCK_THRESHOLD, songsHeard);

  return (
    <View style={styles.persoCard}>
      {/* Soft gold halo so the card reads as "this is the prize moment". */}
      <LinearGradient
        colors={['rgba(200,174,122,0.10)', 'rgba(10,10,12,0)']}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={styles.persoHeader}>
        <View style={styles.persoIcon}>
          <SparkleIcon size={14} color={metals.goldSolidHi} />
        </View>
        <Text style={styles.persoTitle}>AI Personalization</Text>
        {unlocked && (
          <View style={styles.persoBadge}>
            <CheckIcon size={11} color={colors.bg} />
            <Text style={styles.persoBadgeText}>READY</Text>
          </View>
        )}
      </View>
      <Text style={styles.persoSub}>
        {unlocked
          ? 'Your AI is now learning your taste. Your playlists below adapt to every save, skip and replay.'
          : 'Listen to 20 songs and Boulevard will start tuning your library to your taste.'}
      </Text>

      {!unlocked && (
        <>
          <View style={styles.progressTrack}>
            <LinearGradient
              colors={['#dde0e6', '#c5b489', '#b89762']}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={[styles.progressFill, { width: `${progress * 100}%` }]}
            />
          </View>
          <View style={styles.progressMeta}>
            <Text style={styles.progressCount}>{count} / {UNLOCK_THRESHOLD} songs analyzed</Text>
          </View>
        </>
      )}
    </View>
  );
}

// ---- Playlist tile ---------------------------------------------------

interface PlaylistTileProps {
  playlist: BuiltPlaylist;
  onPress: () => void;
}

function PlaylistTile({ playlist, onPress }: PlaylistTileProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.tile, pressed && { opacity: 0.85 }]}
    >
      {playlist.coverUrl ? (
        <Image
          source={{ uri: playlist.coverUrl }}
          style={styles.tileCover}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={playlist.id}
        />
      ) : (
        <View style={[styles.tileCover, styles.tileCoverPlaceholder]}>
          <SparkleIcon size={20} color={colors.textMuted} />
        </View>
      )}
      <View style={styles.tileBody}>
        <Text style={styles.tileName} numberOfLines={1}>{playlist.name}</Text>
        <Text style={styles.tileDesc} numberOfLines={2}>{playlist.description}</Text>
        <Text style={styles.tileCount}>{playlist.songs.length} songs</Text>
      </View>
      <View style={styles.tilePlayBtn}>
        <PlayIcon size={16} color={colors.bg} />
      </View>
    </Pressable>
  );
}

// ---- Followed artists row -------------------------------------------
//
// Horizontal scroll of artists the user has followed. Tapping an artist
// plays their songs from the catalog. Renders nothing when the user
// hasn't followed anyone, so the section vanishes for new users.

interface FollowedArtistsRowProps {
  catalog: Song[];
  followedIds: Set<string>;
  /** Tap opens the artist profile — Play and Radio are explicit actions
   *  on that page, so the list itself is just a directory of follows. */
  onOpenArtist: (artistId: string) => void;
}

interface FollowedArtist {
  id: string;
  name: string;
  imageUrl: string | null;
  songs: Song[];
}

function FollowedArtistsRow({ catalog, followedIds, onOpenArtist }: FollowedArtistsRowProps) {
  const artists = useMemo<FollowedArtist[]>(() => {
    if (followedIds.size === 0) return [];
    const byId = new Map<string, FollowedArtist>();
    for (const song of catalog) {
      if (!song.artist_id || !followedIds.has(song.artist_id)) continue;
      const existing = byId.get(song.artist_id);
      if (existing) {
        existing.songs.push(song);
      } else {
        byId.set(song.artist_id, {
          id: song.artist_id,
          name: song.artist_name ?? 'Unknown artist',
          imageUrl: song.artist_image_url ?? null,
          songs: [song],
        });
      }
    }
    return [...byId.values()];
  }, [catalog, followedIds]);

  if (artists.length === 0) return null;

  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text style={styles.sectionH}>Following</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: spacing.md, paddingRight: spacing.lg }}
      >
        {artists.map((a) => (
          <Pressable
            key={a.id}
            onPress={() => onOpenArtist(a.id)}
            style={({ pressed }) => [styles.followedTile, pressed && { opacity: 0.85 }]}
          >
            {a.imageUrl ? (
              <Image source={{ uri: a.imageUrl }} style={styles.followedAvatar} contentFit="cover" cachePolicy="memory-disk" recyclingKey={a.id} />
            ) : (
              <View style={[styles.followedAvatar, { backgroundColor: colors.surface }]} />
            )}
            <Text style={styles.followedName} numberOfLines={1}>{a.name}</Text>
            <Text style={styles.followedSongCount}>{a.songs.length} song{a.songs.length === 1 ? '' : 's'}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

// ---- User playlist tile ---------------------------------------------

interface UserPlaylistTileProps {
  playlist: UserPlaylist;
  coverUri: string | null;
  onPress: () => void;
  onEdit: () => void;
}

function UserPlaylistTile({ playlist, coverUri, onPress, onEdit }: UserPlaylistTileProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.tile, pressed && { opacity: 0.85 }]}
    >
      {coverUri ? (
        <Image
          source={{ uri: coverUri }}
          style={styles.tileCover}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={playlist.id}
        />
      ) : (
        <View style={[styles.tileCover, styles.tileCoverPlaceholder]}>
          <SparkleIcon size={20} color={colors.textMuted} />
        </View>
      )}
      <View style={styles.tileBody}>
        <Text style={styles.tileName} numberOfLines={1}>{playlist.name}</Text>
        <Text style={styles.tileCount}>{playlist.song_count} song{playlist.song_count === 1 ? '' : 's'}</Text>
      </View>
      <Pressable
        onPress={onEdit}
        hitSlop={10}
        style={({ pressed }) => [styles.tileEditBtn, pressed && { opacity: 0.6 }]}
        accessibilityLabel="Edit playlist"
      >
        <MoreIcon size={18} color={colors.textMuted} />
      </Pressable>
    </Pressable>
  );
}

// ---- Edit playlist modal (rename / delete) --------------------------

interface EditPlaylistModalProps {
  playlist: UserPlaylist | null;
  onClose: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}

function EditPlaylistModal({ playlist, onClose, onRename, onDelete }: EditPlaylistModalProps) {
  const [name, setName] = useState('');
  useEffect(() => { setName(playlist?.name ?? ''); }, [playlist]);
  if (!playlist) return null;
  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && trimmed !== playlist.name;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.editCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.editTitle}>Edit playlist</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Playlist name"
            placeholderTextColor={colors.textMuted}
            style={styles.editInput}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => canSave && onRename(trimmed)}
          />
          <Pressable
            onPress={() => canSave && onRename(trimmed)}
            disabled={!canSave}
            style={({ pressed }) => [
              styles.editPrimary,
              !canSave && { opacity: 0.4 },
              pressed && canSave && { opacity: 0.85 },
            ]}
          >
            <Text style={styles.editPrimaryText}>Save name</Text>
          </Pressable>
          <Pressable
            onPress={onDelete}
            style={({ pressed }) => [styles.editDanger, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.editDangerText}>Delete playlist</Text>
          </Pressable>
          <Pressable onPress={onClose} style={styles.editCancel}>
            <Text style={styles.editCancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ---- Playlist detail sheet ------------------------------------------
//
// Bottom-sheet that opens when the user taps a playlist tile. Shows the
// playlist's songs and a Play-all button. Tapping a row plays from that
// song; the rest of the playlist follows in order.

interface PlaylistDetailSheetProps {
  playlist: UserPlaylist | null;
  songs: Song[];
  onClose: () => void;
  onPlayAll: () => void;
  onPlayFrom: (songId: string) => void;
  /** Tap on the artist subtitle of a song row opens that artist's
   *  profile. Parent dismisses the sheet first so the page is visible. */
  onOpenArtist: (artistId: string) => void;
}

function PlaylistDetailSheet({ playlist, songs, onClose, onPlayAll, onPlayFrom, onOpenArtist }: PlaylistDetailSheetProps) {
  if (!playlist) return null;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.detailBackdrop} onPress={onClose}>
        <Pressable style={styles.detailSheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.detailHandle} />
          <View style={styles.detailHeader}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.detailTitle} numberOfLines={1}>{playlist.name}</Text>
              <Text style={styles.detailSubtitle}>{playlist.song_count} song{playlist.song_count === 1 ? '' : 's'}</Text>
            </View>
            <Pressable
              onPress={onPlayAll}
              disabled={songs.length === 0}
              style={({ pressed }) => [styles.detailPlayAll, songs.length === 0 && { opacity: 0.4 }, pressed && { opacity: 0.85 }]}
            >
              <PlayIcon size={16} color={colors.bg} />
              <Text style={styles.detailPlayAllText}>Play all</Text>
            </Pressable>
          </View>
          {songs.length === 0 ? (
            <Text style={styles.detailEmpty}>This playlist is empty.</Text>
          ) : (
            <ScrollView style={{ maxHeight: 540 }} showsVerticalScrollIndicator={false}>
              {songs.map((s) => (
                <Pressable
                  key={s.id}
                  onPress={() => onPlayFrom(s.id)}
                  style={({ pressed }) => [styles.songRow, pressed && { opacity: 0.7 }]}
                >
                  {s.cover_url ? (
                    <Image source={{ uri: s.cover_url }} style={styles.songRowCover} contentFit="cover" cachePolicy="memory-disk" recyclingKey={s.id} />
                  ) : (
                    <View style={[styles.songRowCover, { backgroundColor: colors.surface }]} />
                  )}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.songRowTitle} numberOfLines={1}>{s.title}</Text>
                    {s.artist_id && s.artist_name ? (
                      // Nested Pressable: native gesture arbitration sends
                      // taps on this view to its own onPress, so tapping
                      // the artist opens the artist page while tapping the
                      // title / cover still plays the song.
                      <Pressable
                        onPress={() => onOpenArtist(s.artist_id!)}
                        hitSlop={4}
                        accessibilityLabel={`Open ${s.artist_name}`}
                      >
                        <Text style={styles.songRowSub} numberOfLines={1}>{s.artist_name}</Text>
                      </Pressable>
                    ) : (
                      <Text style={styles.songRowSub} numberOfLines={1}>
                        {(s.artist_name ?? s.genre) || ''}
                      </Text>
                    )}
                  </View>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ---- Unlock celebration modal ---------------------------------------

interface UnlockModalProps {
  visible: boolean;
  onClose: () => void;
}

function UnlockModal({ visible, onClose }: UnlockModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <LinearGradient
            colors={['rgba(200,174,122,0.18)', 'rgba(10,10,12,0)']}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          <Pressable onPress={onClose} style={styles.modalClose} hitSlop={10}>
            <CloseIcon size={20} color={colors.textDim} />
          </Pressable>
          <View style={styles.modalIcon}>
            <SparkleIcon size={28} color={metals.goldSolidHi} />
          </View>
          <Text style={styles.modalEyebrow}>PERSONALIZATION READY</Text>
          <Text style={styles.modalTitle}>Your AI is now listening for you.</Text>
          <Text style={styles.modalBody}>
            We've analyzed your first 20 songs. From here on, your library
            adapts to every save, skip and replay. The more you listen, the
            sharper it gets.
          </Text>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.modalCta, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.modalCtaText}>Let's go</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

// ---- styles ---------------------------------------------------------

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.lg,
  },

  h1: {
    color: colors.text,
    fontSize: fonts.size.display,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.6,
    marginBottom: spacing.lg,
  },

  // ---- Personalization card ----
  persoCard: {
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
    padding: spacing.lg,
    overflow: 'hidden',
    marginBottom: spacing.lg,
  },
  persoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: 6,
  },
  persoIcon: {
    width: 24,
    height: 24,
    borderRadius: 6,
    backgroundColor: 'rgba(200,174,122,0.10)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  persoTitle: {
    flex: 1,
    color: colors.text,
    fontSize: fonts.size.lg,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.2,
  },
  persoBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.pill,
    backgroundColor: metals.goldSolidHi,
  },
  persoBadgeText: {
    color: colors.bg,
    fontSize: 10,
    fontWeight: fonts.weight.bold,
    letterSpacing: 1,
  },
  persoSub: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    lineHeight: 20,
    marginBottom: spacing.md,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
  },
  progressMeta: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    marginTop: 10,
  },
  progressCount: {
    color: colors.text,
    fontSize: fonts.size.sm,
    fontWeight: fonts.weight.semibold,
    fontVariant: ['tabular-nums'],
  },
  persoHint: {
    color: colors.textDim,
    fontSize: fonts.size.xs,
    marginTop: 6,
    letterSpacing: 0.2,
  },

  // ---- Section heading ----
  sectionH: {
    color: colors.text,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.2,
    marginTop: spacing.lg,
    marginBottom: spacing.sm + 2,
  },
  // Section header row: title on the left, + button on the right.
  sectionHRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  addPlaylistBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
    marginTop: spacing.lg,
    marginBottom: spacing.sm + 2,
  },
  addPlaylistPlus: {
    color: colors.text,
    fontSize: 22,
    fontWeight: fonts.weight.semibold,
    lineHeight: 24,
    marginTop: -2,
  },

  // ---- Create-playlist modal ----
  createBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  createSheet: {
    width: '100%',
    backgroundColor: colors.bgElevated,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    gap: spacing.md,
  },
  createTitle: {
    color: colors.text,
    fontSize: fonts.size.lg,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.2,
  },
  createInput: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderRadius: radii.lg,
    fontSize: fonts.size.md,
  },
  createActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.md,
  },
  createCancelBtn: { paddingHorizontal: spacing.md, paddingVertical: 8 },
  createCancelText: { color: colors.textMuted, fontSize: fonts.size.md, fontWeight: fonts.weight.semibold },
  createSaveBtn: {
    backgroundColor: colors.text,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radii.pill,
  },
  createSaveText: {
    color: '#0a0a0c',
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.bold,
    letterSpacing: 0.2,
  },

  // ---- Followed artists ----
  followedTile: { width: 96, alignItems: 'center' },
  followedAvatar: { width: 88, height: 88, borderRadius: 44, marginBottom: 8 },
  followedName: { color: colors.text, fontSize: fonts.size.sm, fontWeight: fonts.weight.bold, textAlign: 'center' },
  followedSongCount: { color: colors.textMuted, fontSize: fonts.size.xs, marginTop: 2, textAlign: 'center' },

  emptyPlaylistsHint: {
    color: colors.textDim,
    fontSize: fonts.size.sm,
    lineHeight: 20,
    marginBottom: spacing.md,
  },

  // ---- Playlists ----
  playlistGroup: {
    gap: spacing.sm + 2,
  },
  tileEditBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.xs,
  },

  // ---- Edit playlist modal ----
  editCard: {
    width: '100%',
    maxWidth: 380,
    borderRadius: radii.xl,
    backgroundColor: colors.bgElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.xl,
  },
  editTitle: {
    color: colors.text,
    fontSize: fonts.size.lg,
    fontWeight: fonts.weight.bold,
    marginBottom: spacing.md,
  },
  editInput: {
    color: colors.text,
    backgroundColor: '#0f1116',
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: radii.md,
    fontSize: fonts.size.md,
    marginBottom: spacing.md,
  },
  editPrimary: {
    backgroundColor: metals.goldHi,
    paddingVertical: 12,
    borderRadius: radii.md,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  editPrimaryText: {
    color: '#1a1408',
    fontWeight: fonts.weight.bold,
    fontSize: fonts.size.md,
  },
  editDanger: {
    paddingVertical: 12,
    borderRadius: radii.md,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  editDangerText: {
    color: '#ff6b6b',
    fontSize: fonts.size.sm,
    fontWeight: fonts.weight.semibold,
  },
  editCancel: {
    paddingVertical: 8,
    alignItems: 'center',
  },
  editCancelText: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
  },

  // ---- Playlist detail sheet ----
  detailBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  detailSheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    maxHeight: '85%',
  },
  detailHandle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.sm },
  detailHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md },
  detailTitle: { color: colors.text, fontSize: fonts.size.xl, fontWeight: fonts.weight.bold, letterSpacing: -0.3 },
  detailSubtitle: { color: colors.textMuted, fontSize: fonts.size.sm, marginTop: 2 },
  detailPlayAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radii.pill,
    backgroundColor: colors.text,
  },
  detailPlayAllText: { color: colors.bg, fontWeight: fonts.weight.bold, fontSize: fonts.size.sm },
  detailEmpty: { color: colors.textMuted, fontSize: fonts.size.sm, textAlign: 'center', paddingVertical: spacing.xl },
  songRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  songRowCover: { width: 48, height: 48, borderRadius: radii.sm },
  songRowTitle: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.semibold },
  songRowSub: { color: colors.textMuted, fontSize: fonts.size.xs, marginTop: 2 },
  tile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.sm + 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  tileCover: {
    width: 72,
    height: 72,
    borderRadius: radii.md,
    backgroundColor: colors.bg,
  },
  tileCoverPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileBody: {
    flex: 1,
    minWidth: 0,
  },
  tileName: {
    color: colors.text,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.1,
  },
  tileDesc: {
    color: colors.textMuted,
    fontSize: fonts.size.xs,
    marginTop: 2,
    lineHeight: 16,
  },
  tileCount: {
    color: metals.goldSolid,
    fontSize: 11,
    fontWeight: fonts.weight.semibold,
    letterSpacing: 0.3,
    marginTop: 6,
  },
  tilePlayBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.xs,
  },

  // ---- Unlock modal ----
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380,
    borderRadius: radii.xl,
    backgroundColor: colors.bgElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
    padding: spacing.xl,
    overflow: 'hidden',
    alignItems: 'center',
  },
  modalClose: {
    position: 'absolute',
    top: spacing.md,
    right: spacing.md,
    zIndex: 2,
  },
  modalIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(200,174,122,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  modalEyebrow: {
    color: metals.goldSolid,
    fontSize: 11,
    fontWeight: fonts.weight.bold,
    letterSpacing: 2.4,
    marginBottom: 8,
    textAlign: 'center',
  },
  modalTitle: {
    color: colors.text,
    fontSize: 22,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.4,
    textAlign: 'center',
    marginBottom: 10,
  },
  modalBody: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    lineHeight: 21,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  modalCta: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.text,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  modalCtaText: {
    color: colors.bg,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.bold,
    letterSpacing: 0.1,
  },
});
