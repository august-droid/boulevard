import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Alert, Animated, Easing, Linking } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { usePlayer } from '@/contexts/PlayerContext';
import { useAuth } from '@/contexts/AuthContext';
import { useAppNav } from '@/contexts/NavigationContext';
import { SparkleIcon, CheckIcon } from '@/components/Icon';
import { BrandHeader } from '@/components/BrandHeader';
import { PaywallScreen } from '@/screens/PaywallScreen';
import { ReviewScreen } from '@/screens/ReviewScreen';
import { SignupSheet } from '@/screens/SignupSheet';
import { isAdmin } from '@/lib/admin/adminClient';
import { supabase, HAS_SUPABASE } from '@/lib/supabase';
import { pickSoundIdentity, pickCurrentPhase, topMicrotags, prettyMicrotag } from '@/lib/identity/SoundIdentity';
import type { Song } from '@/types';

// Profile is an IDENTITY LAYER, not a settings dashboard.
// Three identity-driven blocks at the top:
//   1. YOUR SOUND — long-term sonic identity, animated aura
//   2. CURRENT PHASE — the user's session-mood right now
//   3. YOUR ARTISTS — top artists with relationship labels
// Settings / dev / admin live below, deprioritized.

export function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const player = usePlayer();
  const auth = useAuth();
  const { openArtistProfile } = useAppNav();
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [signupOpen, setSignupOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!auth.userId) return;
      const isA = await isAdmin(auth.userId);
      if (cancelled) return;
      setAdmin(isA);
      if (isA && HAS_SUPABASE && supabase) {
        const { count } = await supabase
          .from('songs')
          .select('id', { count: 'exact', head: true })
          .eq('approved_by_human', false)
          .eq('approval_status', 'pending');
        if (!cancelled) setPendingCount(count ?? 0);
      }
    })();
    return () => { cancelled = true; };
  }, [auth.userId, reviewOpen]);

  const copyUserId = async () => {
    if (!auth.userId) return;
    await Clipboard.setStringAsync(auth.userId);
    Alert.alert('Copied', 'Your user ID is in your clipboard.');
  };

  // Identity computations — re-run when the lifetime taste changes.
  const identity = useMemo(() => pickSoundIdentity(player.taste), [player.taste]);

  // User-type chip — a behavior-driven persona, NOT a settings status. The
  // chip reads as "what kind of listener am I?" rather than "what plan
  // tier am I on" — keeps the surface identity-shaped.
  const savedCount = player.library?.saved().length ?? 0;
  const userType = useMemo(
    () => classifyUserType({
      songsHeard: auth.songsHeard,
      skipCount: auth.skipCount,
      savedCount,
      isPremium: auth.isPremium,
    }),
    [auth.songsHeard, auth.skipCount, auth.isPremium, savedCount],
  );

  // Current phase reads the session profile imperatively. The session
  // updates with each signal, which also bumps taste — so this memo
  // refreshes whenever taste does. Good enough for an identity surface
  // that the user looks at occasionally, not in real time.
  const session = player.getSession();
  const phase = useMemo(() => pickCurrentPhase(session.microtag_scores), [session.microtag_scores]);
  const topTags = useMemo(() => topMicrotags(player.taste?.microtag_scores, 3), [player.taste]);
  const phaseTags = useMemo(() => topMicrotags(session.microtag_scores, 3), [session.microtag_scores]);

  // Top artists from the user's saved library — grouped by artist_id,
  // ordered by count. Without real per-user play counts, this is the
  // best local proxy for "who you actually listen to."
  const topArtists = useMemo(() => aggregateTopArtists(player.library?.saved() ?? []), [player.library, player.libraryVersion]);

  return (
    <View style={[styles.root, { paddingTop: spacing.md }]}>
      <BrandHeader />
      <ScrollView contentContainerStyle={{ paddingBottom: 160 }} showsVerticalScrollIndicator={false}>

        {/* ===== YOUR SOUND (hero) ===== */}
        <View style={styles.hero}>
          <AnimatedAura colors={identity.identity.palette} />
          <View style={styles.heroTopRow}>
            <Text style={styles.eyebrow}>YOUR SOUND</Text>
            {/* User-type chip — a behavioral persona, sits opposite the eyebrow */}
            <View style={styles.userTypeChip}>
              <Text style={styles.userTypeEmoji}>{userType.emoji}</Text>
              <Text style={styles.userTypeLabel}>{userType.label}</Text>
            </View>
          </View>
          <Text style={styles.heroName}>{identity.identity.name}</Text>
          <Text style={styles.heroDescriptors}>
            {identity.identity.descriptors.join(' • ')}
          </Text>
          <View style={styles.heroProgressTrack}>
            <View style={[styles.heroProgressFill, { width: `${Math.round(identity.strength * 100)}%` }]} />
          </View>
          <Text style={styles.heroProgressLabel}>
            {identity.strength > 0 ? `${Math.round(identity.strength * 100)}% formed` : 'Listen to start forming'}
          </Text>
          {topTags.length > 0 && (
            <View style={styles.tagRow}>
              {topTags.map((t) => (
                <View key={t} style={styles.tag}><Text style={styles.tagText}>{prettyMicrotag(t)}</Text></View>
              ))}
            </View>
          )}
        </View>

        {/* ===== Premium upgrade — prominent gold button right under the hero.
            Only renders when the user isn't already on Premium. ===== */}
        {!auth.isPremium && (
          <Pressable onPress={() => setPaywallOpen(true)} style={({ pressed }) => [pressed && { opacity: 0.92, transform: [{ scale: 0.99 }] }]}>
            <LinearGradient
              colors={['#e0c898', '#c8ae7a', '#a88a4e']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.goldUpgrade}
            >
              <SparkleIcon size={18} color="#1a1408" />
              <View style={{ flex: 1 }}>
                <Text style={styles.goldUpgradeText}>Upgrade to Premium</Text>
                <Text style={styles.goldUpgradeSub}>Unlimited songs · Early drops · Save your library</Text>
              </View>
              <Text style={styles.goldUpgradeArrow}>→</Text>
            </LinearGradient>
          </Pressable>
        )}

        {/* Sign-in entry. Only shows for users still on the anonymous
            session. After the SignupSheet auto-fires at 5 completions
            and gets dismissed, this is the only remaining surface that
            lets them log in to recover their library on a new device. */}
        {!auth.hasSignedUp && (
          <Pressable
            onPress={() => setSignupOpen(true)}
            style={({ pressed }) => [
              styles.signInRow,
              pressed && { opacity: 0.85 },
            ]}
          >
            <View style={styles.signInIcon}>
              <SparkleIcon size={16} color={colors.text} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.signInTitle}>Sign in or create an account</Text>
              <Text style={styles.signInSub}>Save your library across devices</Text>
            </View>
            <Text style={styles.signInArrow}>→</Text>
          </Pressable>
        )}

        {/* ===== CURRENT PHASE ===== */}
        {phase ? (
          <View style={styles.phaseCard}>
            <Text style={styles.cardEyebrow}>CURRENT PHASE</Text>
            <Text style={styles.phaseName}>{phaseLabel(phase.identity.name)}</Text>
            <Text style={styles.phaseHint}>Listening spike</Text>
            {phaseTags.length > 0 && (
              <View style={styles.phaseTagRow}>
                {phaseTags.map((t) => (
                  <Text key={t} style={styles.phaseTagText}>{prettyMicrotag(t).toLowerCase()}</Text>
                ))}
              </View>
            )}
          </View>
        ) : (
          <View style={styles.phaseCard}>
            <Text style={styles.cardEyebrow}>CURRENT PHASE</Text>
            <Text style={styles.phaseName}>Reading the room…</Text>
            <Text style={styles.phaseHint}>Play a few songs to lock in your current vibe</Text>
          </View>
        )}

        {/* ===== YOUR ARTISTS ===== */}
        <Text style={styles.sectionH}>YOUR ARTISTS</Text>
        {topArtists.length === 0 ? (
          <Text style={styles.emptyHint}>Save songs to see who you're really into.</Text>
        ) : (
          <View style={styles.artistList}>
            {topArtists.map((a, i) => (
              <Pressable
                key={a.artistId}
                onPress={() => openArtistProfile(a.artistId)}
                style={({ pressed }) => [styles.artistRow, pressed && { opacity: 0.7 }]}
                accessibilityLabel={`Open ${a.name}`}
              >
                {a.imageUrl ? (
                  <Image source={{ uri: a.imageUrl }} style={styles.artistAvatar} contentFit="cover" cachePolicy="memory-disk" recyclingKey={a.artistId} />
                ) : (
                  <View style={[styles.artistAvatar, { backgroundColor: colors.surface }]} />
                )}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.artistName} numberOfLines={1}>{a.name}</Text>
                  <Text style={styles.artistRelationship}>{RELATIONSHIPS[i] ?? 'in your rotation'}</Text>
                </View>
                <Text style={styles.artistMinutes}>{a.count} saved</Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* ===== Admin + dev (deprioritized) ===== */}
        {admin && (
          <Pressable onPress={() => setReviewOpen(true)} style={styles.reviewEntry}>
            <View style={styles.reviewEntryIcon}>
              <CheckIcon size={18} color={metals.goldSolidHi} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.reviewEntryTitle}>Review Queue</Text>
              <Text style={styles.reviewEntrySub}>
                {pendingCount > 0
                  ? `${pendingCount} song${pendingCount === 1 ? '' : 's'} awaiting your approval`
                  : 'No songs awaiting review right now'}
              </Text>
            </View>
            {pendingCount > 0 && (
              <View style={styles.reviewBadge}>
                <Text style={styles.reviewBadgeText}>{pendingCount}</Text>
              </View>
            )}
          </Pressable>
        )}

        <View style={styles.devCard}>
          <Text style={styles.devCardLabel}>Your user ID</Text>
          <Pressable onPress={copyUserId} style={styles.devIdRow}>
            <Text style={styles.devIdText} numberOfLines={1}>{auth.userId ?? ''}</Text>
            <Text style={styles.devCopyHint}>Tap to copy</Text>
          </Pressable>
        </View>

        {/* ===== Legal ===== */}
        <Text style={styles.sectionH}>LEGAL</Text>
        <View style={styles.legalCard}>
          <LegalRow
            label="Privacy Policy"
            onPress={() => Linking.openURL('https://boulevardai.app/privacy-policy')}
          />
          <View style={styles.legalDivider} />
          <LegalRow
            label="Terms of Service"
            onPress={() => Linking.openURL('https://boulevardai.app/terms')}
          />
          <View style={styles.legalDivider} />
          <LegalRow
            label="Delete Account"
            sub="Request deletion of your account and associated data"
            onPress={() => Linking.openURL('https://boulevardai.app/delete-account')}
          />
        </View>
      </ScrollView>

      <PaywallScreen
        visible={paywallOpen}
        onClose={() => setPaywallOpen(false)}
        onOpenSignIn={() => {
          setPaywallOpen(false);
          setSignupOpen(true);
        }}
      />
      <ReviewScreen visible={reviewOpen} onClose={() => setReviewOpen(false)} />
      <SignupSheet visible={signupOpen} onClose={() => setSignupOpen(false)} />
    </View>
  );
}

// ===== Animated aura =================================================
//
// Slow pulse on opacity so the hero card feels alive without being noisy.
// Each identity has its own 3-stop palette which the gradient locks to.

function AnimatedAura({ colors: palette }: { colors: [string, string, string] }) {
  const opacity = useRef(new Animated.Value(0.65)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1.0, duration: 3200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.65, duration: 3200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => { loop.stop(); };
  }, [opacity]);

  return (
    <Animated.View style={[StyleSheet.absoluteFill, { opacity }]} pointerEvents="none">
      <LinearGradient
        colors={palette}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

// ===== Legal row ======================================================
//
// A single tappable row in the Legal section. Opens a hosted page in the
// device browser via Linking — no in-app navigation, no destructive logic.

function LegalRow({ label, sub, onPress }: { label: string; sub?: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.legalRow, pressed && { opacity: 0.6 }]}
      accessibilityRole="link"
      accessibilityLabel={label}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.legalLabel}>{label}</Text>
        {sub ? <Text style={styles.legalSub}>{sub}</Text> : null}
      </View>
      <Text style={styles.legalArrow}>→</Text>
    </Pressable>
  );
}

// ===== Helpers ========================================================

/** Convert an identity NAME into a session-flavored phase label.
 *  e.g. "Main Character Era" → "Main Character at Night" if it's late. */
function phaseLabel(name: string): string {
  const hour = new Date().getHours();
  if (hour >= 22 || hour < 5) return `${name} at Night`;
  if (hour >= 6 && hour < 11) return `${name}, Morning`;
  return name;
}

/**
 * Behavior-driven user persona. NOT a plan tier — this answers "what kind
 * of listener am I?" using engagement signals. Premium users get their
 * own "AI Member" tag so the chip works as both identity and status.
 */
interface UserType { label: string; sub: string; emoji: string }

function classifyUserType(opts: {
  songsHeard: number;
  skipCount: number;
  savedCount: number;
  isPremium: boolean;
}): UserType {
  const { songsHeard, skipCount, savedCount, isPremium } = opts;
  if (isPremium) return { label: 'AI Member', sub: 'Unlimited everything', emoji: '✨' };
  if (songsHeard < 5) return { label: 'Just Arrived', sub: 'Welcome to Boulevard', emoji: '🌅' };

  const skipRate = skipCount / Math.max(1, songsHeard);
  const saveRate = savedCount / Math.max(1, songsHeard);

  if (savedCount >= 10 && saveRate > 0.15) return { label: 'The Curator', sub: 'You build, not just listen', emoji: '🎯' };
  if (skipRate > 0.55) return { label: 'The Critic', sub: 'Picky, and that\'s fine', emoji: '🥷' };
  if (skipRate < 0.18 && songsHeard >= 20) return { label: 'The Loyalist', sub: 'Found your sound', emoji: '💎' };
  if (songsHeard >= 100) return { label: 'Heavy Rotation', sub: 'You live here now', emoji: '🔥' };
  if (songsHeard >= 30) return { label: 'Regular Listener', sub: 'In the flow', emoji: '🎧' };
  return { label: 'New Listener', sub: 'Still figuring it out', emoji: '🌊' };
}

interface AggregatedArtist {
  artistId: string;
  name: string;
  imageUrl: string | null;
  count: number;
}

function aggregateTopArtists(songs: Song[]): AggregatedArtist[] {
  const byId = new Map<string, AggregatedArtist>();
  for (const s of songs) {
    if (!s.artist_id || !s.artist_name) continue;
    const existing = byId.get(s.artist_id);
    if (existing) existing.count++;
    else byId.set(s.artist_id, { artistId: s.artist_id, name: s.artist_name, imageUrl: s.artist_image_url ?? null, count: 1 });
  }
  return [...byId.values()].sort((a, b) => b.count - a.count).slice(0, 5);
}

// Vibe labels for top artists. Pure UX flavor — no data behind them yet,
// but they give the list real personality the moment it has 3+ artists.
const RELATIONSHIPS = [
  'obsessed lately',
  'on repeat',
  'in your rotation',
  'background staple',
  'fading out',
];

// ===== Styles =========================================================

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.lg },

  // ---- Hero (YOUR SOUND) ----
  hero: {
    marginTop: spacing.md,
    padding: spacing.lg + 4,
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
    overflow: 'hidden',
    minHeight: 220,
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    gap: spacing.sm,
  },
  eyebrow: {
    color: metals.goldSolid,
    fontSize: 11,
    fontWeight: fonts.weight.bold,
    letterSpacing: 2.6,
  },
  userTypeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  userTypeEmoji: { fontSize: 12 },
  userTypeLabel: { color: colors.text, fontSize: 11, fontWeight: fonts.weight.bold, letterSpacing: 0.2 },
  // Prominent gold upgrade button — sits directly under the hero. The
  // gradient is the same gold tone as the rest of Boulevard's gold accents
  // so it reads as on-brand, not loud.
  goldUpgrade: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md + 2,
    borderRadius: radii.lg,
    marginTop: spacing.md,
  },
  goldUpgradeText: { color: '#1a1408', fontSize: fonts.size.md, fontWeight: fonts.weight.bold, letterSpacing: -0.1 },
  goldUpgradeSub: { color: 'rgba(26,20,8,0.72)', fontSize: 11, fontWeight: fonts.weight.semibold, marginTop: 2, letterSpacing: 0.1 },
  goldUpgradeArrow: { color: '#1a1408', fontSize: 22, fontWeight: fonts.weight.bold },
  signInRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.lg,
    marginTop: spacing.sm,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  signInIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(138,123,255,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  signInTitle: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.semibold },
  signInSub: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
  signInArrow: { color: colors.textMuted, fontSize: 22, fontWeight: fonts.weight.bold },
  heroName: {
    color: colors.text,
    fontSize: 30,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.6,
    lineHeight: 34,
  },
  heroDescriptors: {
    color: colors.textMuted,
    fontSize: fonts.size.sm,
    marginTop: 8,
    letterSpacing: 0.2,
  },
  heroProgressTrack: {
    marginTop: spacing.lg,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.10)',
    overflow: 'hidden',
  },
  heroProgressFill: { height: '100%', backgroundColor: metals.goldSolidHi },
  heroProgressLabel: {
    color: colors.textMuted,
    fontSize: fonts.size.xs,
    marginTop: 6,
    letterSpacing: 0.4,
  },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: spacing.md },
  tag: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  tagText: { color: colors.text, fontSize: fonts.size.xs, fontWeight: fonts.weight.medium },

  // ---- Current phase ----
  phaseCard: {
    marginTop: spacing.lg,
    padding: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  cardEyebrow: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: fonts.weight.bold,
    letterSpacing: 2.2,
    marginBottom: 8,
  },
  phaseName: {
    color: colors.text,
    fontSize: fonts.size.xl,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.3,
  },
  phaseHint: { color: colors.textMuted, fontSize: fonts.size.sm, marginTop: 4 },
  phaseTagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  phaseTagText: {
    color: metals.goldSolidHi,
    fontSize: fonts.size.sm,
    fontWeight: fonts.weight.semibold,
  },

  // ---- Artists ----
  sectionH: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: fonts.weight.bold,
    letterSpacing: 2.4,
    marginTop: spacing.xl,
    marginBottom: spacing.sm + 2,
  },
  emptyHint: { color: colors.textDim, fontSize: fonts.size.sm, paddingVertical: spacing.md },
  artistList: { gap: spacing.sm },
  artistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  artistAvatar: { width: 52, height: 52, borderRadius: 26 },
  artistName: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.bold, letterSpacing: -0.1 },
  artistRelationship: {
    color: metals.goldSolidHi,
    fontSize: fonts.size.xs,
    marginTop: 2,
    fontStyle: 'italic',
    letterSpacing: 0.2,
  },
  artistMinutes: { color: colors.textDim, fontSize: fonts.size.xs },

  // ---- Settings/admin/dev (deprioritized) ----
  upgrade: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.text,
    marginTop: spacing.xl,
  },
  upgradeText: { color: colors.bg, fontWeight: fonts.weight.bold, fontSize: fonts.size.md },

  reviewEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: 'rgba(40,32,18,0.45)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
  },
  reviewEntryIcon: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(200,174,122,0.10)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: metals.gold,
  },
  reviewEntryTitle: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.bold, letterSpacing: -0.2 },
  reviewEntrySub: { color: colors.textMuted, fontSize: fonts.size.sm, marginTop: 2 },
  reviewBadge: {
    minWidth: 26, height: 26, paddingHorizontal: 8, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#c8ae7a',
  },
  reviewBadgeText: { color: colors.bg, fontWeight: fonts.weight.bold, fontSize: fonts.size.sm, fontVariant: ['tabular-nums'] },

  devCard: {
    marginTop: spacing.xl,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  devCardLabel: { color: colors.textMuted, fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase' },
  devIdRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 6 },
  devIdText: { color: colors.text, fontSize: fonts.size.sm, fontFamily: 'Menlo', flex: 1 },
  devCopyHint: { color: colors.textDim, fontSize: fonts.size.xs, marginLeft: spacing.sm },

  // ---- Legal ----
  legalCard: {
    marginTop: spacing.sm + 2,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  legalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  legalDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: spacing.md,
  },
  legalLabel: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.semibold },
  legalSub: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  legalArrow: { color: colors.textMuted, fontSize: 20, fontWeight: fonts.weight.bold },
});
