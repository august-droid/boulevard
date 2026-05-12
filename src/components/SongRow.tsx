import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { colors, fonts, radii, spacing } from '@/theme';
import { Song } from '@/types';
import { PlayIcon } from './Icon';

interface Props {
  song: Song;
  onPress: () => void;
  subtitle?: string;
}

export function SongRow({ song, onPress, subtitle }: Props) {
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]} onPress={onPress}>
      <Image
        source={{ uri: song.cover_url }}
        style={styles.cover}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={120}
        recyclingKey={song.id}
      />
      <View style={styles.meta}>
        <Text style={styles.title} numberOfLines={1}>{song.title}</Text>
        <Text style={styles.sub} numberOfLines={1}>
          {subtitle ?? `AI Music · ${song.genre}`}
        </Text>
      </View>
      <View style={styles.play}>
        <PlayIcon size={18} color={colors.textMuted} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    gap: spacing.md,
  },
  cover: {
    width: 48,
    height: 48,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
  },
  meta: {
    flex: 1,
  },
  title: {
    color: colors.text,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.semibold,
  },
  sub: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    marginTop: 2,
  },
  play: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
