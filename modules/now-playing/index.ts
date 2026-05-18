import { requireOptionalNativeModule } from 'expo-modules-core';

// JS surface for the `NowPlaying` native module.
//
// The module owns the OS lock-screen / now-playing layer that expo-av does
// NOT provide on its own: MPNowPlayingInfoCenter + MPRemoteCommandCenter on
// iOS, and a MediaSession + media notification on Android. It publishes the
// song's title / artist / artwork and exposes prev/next-TRACK transport
// (the ±N-second skip/seek buttons are deliberately left disabled).
//
// expo-av still owns actual audio playback — this module is purely the
// metadata + remote-control bridge. MediaSessionBridge.tsx keeps it in sync
// with the JS PlayerContext.

export type RemoteCommand = 'play' | 'pause' | 'next' | 'previous';

export interface NowPlayingMetadata {
  title: string;
  artist: string;
  /** Absolute URL of the song cover. Null falls back to no artwork. */
  artworkUrl?: string | null;
}

export interface RemoteCommandEvent {
  command: RemoteCommand;
}

interface Subscription {
  remove: () => void;
}

interface NowPlayingNativeModule {
  /** Publish title / artist / artwork for the current song. */
  setMetadata(metadata: NowPlayingMetadata): void;
  /** Publish play/pause state + scrubber position. Times are in SECONDS. */
  setPlaybackState(isPlaying: boolean, position: number, duration: number): void;
  /** Tear down the now-playing session (no song). */
  clear(): void;
  addListener(
    eventName: 'onRemoteCommand',
    listener: (event: RemoteCommandEvent) => void,
  ): Subscription;
}

// `null` when the native module isn't in the running binary — e.g. an app
// build made before this module existed. Callers no-op in that case so a
// stale binary never crashes on the JS bridge.
const NowPlaying = requireOptionalNativeModule<NowPlayingNativeModule>('NowPlaying');

export default NowPlaying;
