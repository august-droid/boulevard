// Web build of the push-token registration module.
//
// Expo push tokens are a native-only concept; the web app does not register
// for push. Metro picks this no-op over registerPushToken.ts for the web
// bundle so AuthContext's unconditional call is harmless on web.

export async function registerPushTokenForUser(_userId: string): Promise<string | null> {
  return null;
}
