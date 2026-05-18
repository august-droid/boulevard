// TikTok Pixel conversion events.
//
// The TikTok pixel is a web-only browser script (injected in
// public/index.html). On native there is no pixel, so this module is an
// inert no-op — shared callers (e.g. SignupSheet) import it with no
// Platform check. Metro resolves TikTokPixel.web.ts for the web build.

export type SignUpMethod = 'email' | 'google' | 'apple';

export function trackSignUp(_method: SignUpMethod): void {
  // no-op on native
}
