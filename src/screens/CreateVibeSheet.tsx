import React from 'react';
import { Modal, View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { colors, fonts, radii, spacing } from '@/theme';
import { ACTIVITIES, Activity } from '@/types';
import { usePlayer } from '@/contexts/PlayerContext';
import { CloseIcon, CheckIcon, SparkleIcon } from '@/components/Icon';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function CreateVibeSheet({ visible, onClose }: Props) {
  const player = usePlayer();
  const insets = useSafeAreaInsets();

  const choose = async (a: Activity) => {
    await player.setVibe(player.vibe === a ? null : a);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <BlurView tint="dark" intensity={20} style={StyleSheet.absoluteFill} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}>
          <View style={styles.handle} />

          <View style={styles.header}>
            <View>
              <Text style={styles.title}>Create a vibe</Text>
              <Text style={styles.subtitle}>Tell us how you want to feel.</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={12} style={styles.close}>
              <CloseIcon size={20} color={colors.textMuted} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.grid} showsVerticalScrollIndicator={false}>
            {ACTIVITIES.map(({ id, label }) => {
              const active = player.vibe === id;
              return (
                <Pressable
                  key={id}
                  onPress={() => choose(id)}
                  style={[styles.tile, active && styles.tileActive]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  {active && (
                    <View style={styles.check}>
                      <CheckIcon size={14} color={colors.bg} />
                    </View>
                  )}
                  <Text style={[styles.tileLabel, active && styles.tileLabelActive]}>{label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>

          <Pressable
            onPress={async () => {
              // Random pick gives the user a "surprise me" path the spec calls for.
              const rand = ACTIVITIES[Math.floor(Math.random() * ACTIVITIES.length)];
              await player.setVibe(rand.id);
              onClose();
            }}
            style={styles.surprise}
          >
            <SparkleIcon size={16} color={colors.text} />
            <Text style={styles.surpriseText}>Surprise me</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    maxHeight: '85%',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: 'center',
    marginBottom: spacing.md,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: spacing.lg,
  },
  title: {
    color: colors.text,
    fontSize: fonts.size.xl,
    fontWeight: fonts.weight.bold,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    marginTop: 4,
  },
  close: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: colors.surface,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  tile: {
    width: '47%',
    minHeight: 76,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    justifyContent: 'center',
  },
  tileActive: {
    backgroundColor: colors.surfaceHover,
    borderColor: colors.text,
  },
  tileLabel: {
    color: colors.text,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.semibold,
  },
  tileLabelActive: {
    color: colors.text,
  },
  check: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  surprise: {
    marginTop: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  surpriseText: {
    color: colors.text,
    fontSize: fonts.size.md,
    fontWeight: fonts.weight.semibold,
  },
});
