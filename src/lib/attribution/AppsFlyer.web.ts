// Web build of the attribution module.
//
// `react-native-appsflyer` is a native-only module and would break the web
// bundle, so Metro picks this file instead of AppsFlyer.ts whenever it builds
// for `Platform.OS === 'web'`. AppsFlyer install attribution is a mobile-store
// concern only — the web app has nothing to attribute. Every export here is an
// inert no-op with the same shape as the native module so shared callers
// (App.tsx, AuthContext) compile and run unchanged.

export const HAS_APPSFLYER = false;

export async function initAppsFlyer(): Promise<void> {
  // no-op
}

export async function logAppsFlyerEvent(
  _eventName: string,
  _eventValues: Record<string, unknown> = {},
): Promise<void> {
  // no-op
}

export function setAppsFlyerCustomerUserId(_userId: string | null): void {
  // no-op
}
