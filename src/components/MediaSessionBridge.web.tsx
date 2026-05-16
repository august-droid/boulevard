import { useEffect, useRef } from 'react';
import { usePlayer, usePlayerProgress } from '@/contexts/PlayerContext';
import { songArtworkUri } from '@/lib/artwork';

// Web build of the media-session bridge.
//
// Wires Boulevard playback into the browser Media Session API so that
// hardware media keys (the keyboard's play/pause/next/prev keys), headset
// remote buttons, and the OS / browser "now playing" UI all control the app.
// Renders nothing — it is pure effects. Metro picks the native no-op
// (MediaSessionBridge.tsx) on iOS/Android.

function getMediaSession(): MediaSession | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return navigator.mediaSession;
}

export function MediaSessionBridge(): null {
  const player = usePlayer();
  const { position, duration } = usePlayerProgress();
  const song = player.current;

  // The action handlers are registered once. They read the player through a
  // live ref so they always invoke the current methods without the handlers
  // having to be re-registered on every render.
  const playerRef = useRef(player);
  useEffect(() => { playerRef.current = player; }, [player]);

  // Register the action handlers. Re-runs per song so the handlers are
  // re-asserted against each track's now-playing session.
  //
  // The important part for mobile: we register previoustrack / nexttrack AND
  // explicitly DISABLE seekbackward / seekforward. iOS (and Android) default
  // a bare <audio> element's lock-screen transport to the ±10-second skip
  // buttons; the OS only swaps those for prev/next TRACK buttons when the
  // track-skip actions are present and the seek-skip actions are not. So
  // leaving seekbackward/seekforward unset is not enough — some OS versions
  // still fall back to ±10s — we null them explicitly every (re)registration.
  useEffect(() => {
    const ms = getMediaSession();
    if (!ms) return;
    const set = (action: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
      try { ms.setActionHandler(action, fn); } catch { /* unsupported action */ }
    };
    set('play', () => { void playerRef.current.togglePlay(); });
    set('pause', () => { void playerRef.current.togglePlay(); });
    set('previoustrack', () => { void playerRef.current.previous(); });
    set('nexttrack', () => { void playerRef.current.skip(); });
    // Kill the ±N-second skip buttons so the lock screen shows prev/next song.
    set('seekbackward', null);
    set('seekforward', null);
    // `seekto` only powers the draggable scrubber — it does NOT add skip
    // buttons, so we keep it for tap-to-seek on the OS progress bar.
    set('seekto', (details) => {
      if (typeof details.seekTime === 'number') {
        void playerRef.current.seek(details.seekTime * 1000);
      }
    });
    return () => {
      (['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto'] as MediaSessionAction[])
        .forEach((a) => set(a, null));
    };
  }, [song?.id]);

  // Metadata — title / artist / artwork for the OS now-playing UI.
  useEffect(() => {
    const ms = getMediaSession();
    if (!ms || typeof MediaMetadata === 'undefined') return;
    if (!song) { ms.metadata = null; return; }
    const art = songArtworkUri(song);
    ms.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist_name ?? 'Boulevard',
      album: 'Boulevard',
      artwork: art ? [{ src: art, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
  }, [song?.id, song?.title, song?.artist_name]);

  // Playback state — drives the OS play/pause indicator.
  useEffect(() => {
    const ms = getMediaSession();
    if (ms) ms.playbackState = player.isPlaying ? 'playing' : 'paused';
  }, [player.isPlaying]);

  // Position — feeds the OS scrubber.
  useEffect(() => {
    const ms = getMediaSession();
    if (!ms || typeof ms.setPositionState !== 'function' || duration <= 0) return;
    try {
      ms.setPositionState({
        duration: duration / 1000,
        position: Math.min(position, duration) / 1000,
        playbackRate: 1,
      });
    } catch { /* invalid state mid-song-swap — safe to ignore */ }
  }, [position, duration]);

  return null;
}
