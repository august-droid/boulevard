import React, { useState } from 'react';
import { Modal, View, Text, Pressable, FlatList, TextInput, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { usePlaylists } from '@/contexts/PlaylistsContext';
import { useAuth } from '@/contexts/AuthContext';
import { useAppNav } from '@/contexts/NavigationContext';

// Bottom-sheet style picker. Tap a playlist row to toggle the current
// song's membership. "+ New playlist" creates one inline.

interface Props {
  visible: boolean;
  songId: string | null;
  onClose: () => void;
}

export function PlaylistPicker({ visible, songId, onClose }: Props) {
  const { playlists, create, toggleSong, isInPlaylist } = usePlaylists();
  const auth = useAuth();
  const nav = useAppNav();
  // Playlist creation is gated to signed-up users. Anonymous users see
  // a "Sign in to create a playlist" row that bounces to SignupSheet.
  // The same defense is enforced by RLS at the DB level, but we want
  // the UI to be honest about it: never present a TextInput the user
  // can't actually save through.
  const canCreate = !auth.isAnonymous;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  // Inline error so failed save/create surfaces instead of vanishing.
  const [err, setErr] = useState<string | null>(null);

  const showError = (msg: string) => {
    setErr(msg);
    setTimeout(() => setErr((cur) => (cur === msg ? null : cur)), 4000);
  };

  const handleCreate = async () => {
    if (!songId) return;
    const trimmed = name.trim();
    if (!trimmed) { setCreating(false); return; }
    const pl = await create(trimmed);
    if (!pl) {
      showError("Couldn't create playlist. Try again.");
      return; // keep the draft name so the user can retry
    }
    const ok = await toggleSong(pl.id, songId);
    if (!ok) showError("Playlist created, but couldn't add the song.");
    setName('');
    setCreating(false);
  };

  const handleToggle = async (playlistId: string) => {
    if (!songId) return;
    const ok = await toggleSong(playlistId, songId);
    if (!ok) showError("Couldn't save. Try again.");
  };

  if (!visible || !songId) return null;

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ width: '100%' }}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.handle} />
            <Text style={styles.title}>Save to playlist</Text>

            <FlatList
              data={playlists}
              keyExtractor={(p) => p.id}
              renderItem={({ item }) => {
                const inList = isInPlaylist(item.id, songId);
                return (
                  <Pressable
                    onPress={() => handleToggle(item.id)}
                    style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
                  >
                    <View style={styles.rowMeta}>
                      <Text style={styles.rowName}>{item.name}</Text>
                      <Text style={styles.rowSub}>{item.song_count} song{item.song_count === 1 ? '' : 's'}</Text>
                    </View>
                    <View style={[styles.check, inList && styles.checkOn]}>
                      {inList ? <Text style={styles.checkMark}>✓</Text> : null}
                    </View>
                  </Pressable>
                );
              }}
              ListEmptyComponent={
                <Text style={styles.empty}>
                  {canCreate
                    ? 'No playlists yet. Create your first one below.'
                    : 'Sign in to start your own playlists.'}
                </Text>
              }
            />

            {err ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorBannerText}>{err}</Text>
              </View>
            ) : null}

            {/* Create-playlist affordance.
                Signed-up: inline name field + Create.
                Anonymous: a Sign-in CTA that hands off to SignupSheet.
                This matches the Library "+ Add playlist" gating exactly,
                so the rule is consistent across surfaces. */}
            {!canCreate ? (
              <Pressable
                onPress={() => { onClose(); nav.openSignup('playlist'); }}
                style={({ pressed }) => [styles.newRow, pressed && { opacity: 0.7 }]}
              >
                <Text style={styles.gatedRowText}>Sign in to create your own playlist</Text>
              </Pressable>
            ) : creating ? (
              <View style={styles.createBox}>
                <TextInput
                  value={name}
                  onChangeText={setName}
                  placeholder="Playlist name"
                  placeholderTextColor={colors.textMuted}
                  style={styles.input}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={handleCreate}
                />
                <Pressable onPress={handleCreate} style={styles.createBtn}>
                  <Text style={styles.createBtnText}>Create</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable onPress={() => setCreating(true)} style={({ pressed }) => [styles.newRow, pressed && { opacity: 0.7 }]}>
                <Text style={styles.newRowText}>+ New playlist</Text>
              </Pressable>
            )}

            <Pressable onPress={onClose} style={styles.done}>
              <Text style={styles.doneText}>Done</Text>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    maxHeight: '75%',
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.md },
  title: { color: colors.text, fontSize: fonts.size.lg, fontWeight: fonts.weight.bold, marginBottom: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowMeta: { flex: 1, minWidth: 0 },
  rowName: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.semibold },
  rowSub: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: metals.goldHi, borderColor: metals.goldHi },
  checkMark: { color: '#1a1408', fontSize: 14, fontWeight: '800' },
  empty: { color: colors.textMuted, paddingVertical: spacing.lg, textAlign: 'center' },
  newRow: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  newRowText: { color: metals.goldHi, fontSize: fonts.size.md, fontWeight: fonts.weight.semibold },
  gatedRowText: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.semibold, textDecorationLine: 'underline' },
  createBox: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  input: { flex: 1, color: colors.text, backgroundColor: '#0f1116', borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, borderRadius: radii.md, fontSize: fonts.size.md },
  createBtn: { backgroundColor: metals.goldHi, paddingHorizontal: 16, paddingVertical: 11, borderRadius: radii.md },
  createBtnText: { color: '#1a1408', fontWeight: fonts.weight.bold },
  done: { alignItems: 'center', paddingTop: spacing.md, paddingBottom: spacing.sm },
  doneText: { color: colors.textMuted, fontSize: fonts.size.sm },
  errorBanner: { paddingVertical: spacing.xs + 2, paddingHorizontal: spacing.sm, backgroundColor: 'rgba(255,45,85,0.14)', borderColor: 'rgba(255,45,85,0.40)', borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.sm, marginTop: spacing.xs },
  errorBannerText: { color: '#ff8a9b', fontSize: fonts.size.xs, fontWeight: fonts.weight.semibold, textAlign: 'center' },
});
