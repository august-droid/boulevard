import React, { createContext, useContext, useMemo } from 'react';

// Light-touch navigation hooks shared between RootNavigator and the screens
// it renders. RootNavigator owns the tab state; screens consume callbacks
// here so we don't prop-drill through Section / Tile / Hero / Mini-Player.

/** The gated action that triggered the SignupSheet — drives the contextual
 *  "you need an account to …" line. `null` for a generic / nudge open. */
export type SignupReason = 'like' | 'save' | 'comment' | 'share' | 'playlist' | 'follow';

interface NavValue {
  /** Switch to the full-screen player (the "home" tab). Used by Explore
   *  and Library after the user taps a song so playback opens in
   *  listening-mode instead of starting silently in the background. */
  openPlayer: () => void;
  /**
   * Open the SignupSheet from anywhere in the tree. Gated surfaces like
   * the comments composer call this when an anonymous user taps a
   * social action (compose / react / reply / like). Pass the `reason` so
   * the sheet can name the exact thing they tried to do. The host
   * (RootNavigator) provides the real implementation; outside the
   * navigator it no-ops so storybook / unit tests don't crash.
   */
  openSignup: (reason?: SignupReason) => void;
  /**
   * Push an Artist Profile onto the navigation stack. Stacks correctly:
   * tapping a similar artist from inside an artist page opens that artist
   * on top, and the back button pops to the previous one. RootNavigator
   * owns the actual stack state.
   */
  openArtistProfile: (artistId: string) => void;
  /** Pop the top of the artist stack. No-op when the stack is empty. */
  closeArtistProfile: () => void;
}

const Ctx = createContext<NavValue | null>(null);

export function NavigationProvider({
  openPlayer,
  openSignup,
  openArtistProfile,
  closeArtistProfile,
  children,
}: {
  openPlayer: () => void;
  openSignup: (reason?: SignupReason) => void;
  openArtistProfile: (artistId: string) => void;
  closeArtistProfile: () => void;
  children: React.ReactNode;
}) {
  const value = useMemo<NavValue>(
    () => ({ openPlayer, openSignup, openArtistProfile, closeArtistProfile }),
    [openPlayer, openSignup, openArtistProfile, closeArtistProfile],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppNav(): NavValue {
  const ctx = useContext(Ctx);
  // Permissive fallback: if a screen is rendered outside the navigator
  // (storybook, unit test) the calls become no-ops rather than a runtime
  // crash.
  return (
    ctx ?? {
      openPlayer: () => {},
      openSignup: () => {},
      openArtistProfile: () => {},
      closeArtistProfile: () => {},
    }
  );
}
