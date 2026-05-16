import React from 'react';
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { Artwork } from '@/components/Artwork';
import { SparkleIcon } from '@/components/Icon';
import { songArtworkUri } from '@/lib/artwork';
import { usePlayer } from '@/contexts/PlayerContext';

// Celebration pop-up — fires when the listener is the first person, platform
// wide, to stream a song (the record_stream RPC returned a count of 1).
// PlayerContext owns the trigger + once-per-session guard; this component
// just renders it. Mounted once at the app root, shared by every shell.

export function FirstListenerModal() {
  const player = usePlayer();
  const song = player.firstListen;

  return (
    <Modal
      visible={!!song}
      transparent
      animationType="fade"
      onRequestClose={player.dismissFirstListen}
    >
      <Pressable style={styles.backdrop} onPress={player.dismissFirstListen}>
        {song ? (
          // Inner Pressable swallows taps so clicking the card doesn't dismiss.
          <Pressable style={styles.card} onPress={() => {}}>
            <LinearGradient
              colors={['rgba(200,174,122,0.22)', 'rgba(10,10,12,0)']}
              style={styles.glow}
              pointerEvents="none"
            />
            <View style={styles.badge}>
              <SparkleIcon size={26} color={metals.goldSolidHi} />
            </View>
            <Text style={styles.eyebrow}>FIRST LISTENER</Text>
            <Text style={styles.title}>You discovered it first</Text>
            <Text style={styles.sub}>
              You&apos;re the first person on Boulevard to ever stream this track.
              That discovery is credited to you.
            </Text>

            <View style={styles.songRow}>
              <Artwork
                uri={songArtworkUri(song)}
                name={song.title}
                size={52}
                radius={10}
                recyclingKey={song.id}
                style={styles.cover}
              />
              <View style={styles.songMeta}>
                <Text style={styles.songTitle} numberOfLines={1}>{song.title}</Text>
                <Text style={styles.songArtist} numberOfLines={1}>
                  {song.artist_name ?? 'Boulevard'}
                </Text>
              </View>
            </View>

            <Pressable
              onPress={player.dismissFirstListen}
              style={({ pressed }) => [styles.cta, pressed && { opacity: 0.9 }]}
              accessibilityLabel="Close"
            >
              <Text style={styles.ctaText}>Keep listening</Text>
            </Pressable>
          </Pressable>
        ) : null}
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.66)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.bgElevated,
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.goldHi,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    alignItems: 'center',
    overflow: 'hidden',
  },
  glow: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 200,
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.goldHi,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  eyebrow: {
    color: metals.goldSolidHi,
    fontSize: 11,
    fontWeight: fonts.weight.bold,
    letterSpacing: 2.6,
    marginBottom: 6,
  },
  title: {
    color: colors.text,
    fontSize: fonts.size.xxl,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  sub: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    lineHeight: 20,
    textAlign: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  songRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.sm,
    marginTop: spacing.lg,
  },
  cover: {
    width: 52,
    height: 52,
    borderRadius: 10,
    backgroundColor: colors.bg,
  },
  songMeta: { flex: 1, minWidth: 0 },
  songTitle: {
    color: colors.text,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.semibold,
  },
  songArtist: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    marginTop: 2,
  },
  cta: {
    marginTop: spacing.lg,
    height: 50,
    width: '100%',
    borderRadius: radii.pill,
    backgroundColor: metals.goldSolid,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: {
    color: '#0a0a0c',
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.bold,
    letterSpacing: 0.2,
  },
});
