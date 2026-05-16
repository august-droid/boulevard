// Native build of the media-session bridge.
//
// On iOS/Android, hardware media keys, headset buttons and the lock-screen
// transport are handled by the OS audio session that `expo-av` configures
// (see AudioPlayer.configureSession) — no JS bridge is needed. Metro picks
// this no-op on native; the real implementation lives in
// MediaSessionBridge.web.tsx.

export function MediaSessionBridge(): null {
  return null;
}
