// Native build of the media-session bridge.
//
// expo-av plays the audio and keeps it alive in the background, but it does
// NOT publish anything to the iOS/Android lock screen. This bridge wires
// Boulevard playback into the local `NowPlaying` native module
// (modules/now-playing), which owns MPNowPlayingInfoCenter /
// MPRemoteCommandCenter on iOS and a MediaSession + media notification on
// Android.
//
// Like the web build (MediaSessionBridge.web.tsx) it exposes prev/next-TRACK
// transport and leaves the ±N-second skip/seek buttons disabled, and it
// publishes title/artist/artwork so the lock screen shows the song's cover.
// Renders nothing — pure effects. Metro picks the web file on web.

import { useEffect, useRef } from 'react';
import { usePlayer, usePlayerProgress } from '@/contexts/PlayerContext';
import { songArtworkUri } from '@/lib/artwork';
import NowPlaying from '../../modules/now-playing';

export function MediaSessionBridge(): null {
  const player = usePlayer();
  const { position, duration } = usePlayerProgress();
  const song = player.current;

  // The remote-command listener is registered once and reads the player
  // through a live ref, so a single registration always drives the current
  // player methods without re-subscribing per render.
  const playerRef = useRef(player);
  useEffect(() => { playerRef.current = player; }, [player]);

  // Remote commands from the lock screen / headset — play, pause, prev, next.
  useEffect(() => {
    if (!NowPlaying) return;
    const sub = NowPlaying.addListener('onRemoteCommand', ({ command }) => {
      const p = playerRef.current;
      // play / pause both map to togglePlay — the OS only ever surfaces the
      // contextually-correct one, exactly as the web bridge does.
      if (command === 'play' || command === 'pause') void p.togglePlay();
      else if (command === 'next') void p.skip();
      else if (command === 'previous') void p.previous();
    });
    return () => sub.remove();
  }, []);

  // Metadata — title / artist / artwork for the lock screen + notification.
  useEffect(() => {
    if (!NowPlaying) return;
    if (!song) { NowPlaying.clear(); return; }
    NowPlaying.setMetadata({
      title: song.title,
      artist: song.artist_name ?? 'Boulevard',
      artworkUrl: songArtworkUri(song),
    });
  }, [song?.id, song?.title, song?.artist_name]);

  // Playback state + position — drives the OS play/pause indicator and the
  // now-playing scrubber. The native module takes SECONDS; the player
  // reports milliseconds.
  useEffect(() => {
    if (!NowPlaying || !song) return;
    NowPlaying.setPlaybackState(player.isPlaying, position / 1000, duration / 1000);
  }, [player.isPlaying, position, duration, song?.id]);

  return null;
}
