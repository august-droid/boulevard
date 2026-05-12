import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Modal,
  Platform,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { usePlayer } from '@/contexts/PlayerContext';
import { useAuth } from '@/contexts/AuthContext';
import { BrandHeader } from '@/components/BrandHeader';
import { PlayIcon, SparkleIcon, CheckIcon, CloseIcon } from '@/components/Icon';
import {
  buildNewForYou,
  buildYourBestOnes,
  buildGymBeast,
  buildCeoMode,
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
  // The modal opens exactly once per account, the moment songsHeard crosses
  // 100 while `personalizationUnlockedAt` is still null. We do NOT key off
  // a local boolean alone — a tab re-mount would re-open the modal. Once
  // we've marked unlock in AsyncStorage, the effect's guard prevents re-firing.
  const [unlockModalOpen, setUnlockModalOpen] = useState(false);
  const unlockShownRef = useRef(false);

  // The four library playlists. Each rebuilds when its inputs change — saves
  // immediately reshape "Your Best Ones", and skips flow through into "New
  // For You" via the taste profile the recommender reads.
  const playlists: BuiltPlaylist[] = useMemo(() => [
    buildNewForYou(
      player.catalog,
      player.library,
      player.taste,
      [],                       // recent — pulled inside via library
      auth.songsHeard,
    ),
    buildYourBestOnes(player.library),
    buildGymBeast(player.catalog),
    buildCeoMode(player.catalog),
  ], [
    player.catalog,
    player.library,
    player.libraryVersion,
    player.taste,
    auth.songsHeard,
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
    // launch (App.tsx); if the user denied, this resolves silently.
    Notifications.scheduleNotificationAsync({
      content: {
        title: 'Your AI is now listening',
        body: 'Boulevard learned your taste. Your personalized playlists are ready.',
        sound: 'default',
      },
      trigger: null, // fire immediately
    }).catch(() => {});
  }, [auth.songsHeard, auth.personalizationUnlockedAt, auth.markPersonalizationUnlocked]);

  const onPlayPlaylist = (p: BuiltPlaylist) => {
    if (p.songs.length === 0) return;
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    player.playPlaylist(p.songs);
  };

  return (
    <View style={[styles.root, { paddingTop: spacing.md }]}>
      <BrandHeader />

      <ScrollView
        contentContainerStyle={{ paddingBottom: 160 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.h1}>Library</Text>

        <PersonalizationCard
          songsHeard={auth.songsHeard}
          unlocked={Boolean(auth.personalizationUnlockedAt)}
        />

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

  // ---- Playlists ----
  playlistGroup: {
    gap: spacing.sm + 2,
  },
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
