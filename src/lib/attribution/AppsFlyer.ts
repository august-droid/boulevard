import { NativeModules, Platform } from 'react-native';

// react-native-appsflyer is a NATIVE module. Its index.js touches the native
// side at import time (`new NativeEventEmitter(RNAppsFlyer)`), which throws an
// Invariant Violation in Expo Go, where no native modules are linked. So we
// load it lazily and ONLY when the native module is actually present (i.e. a
// dev/prod build). In Expo Go `appsFlyer` is an inert stub and every export
// in this file cleanly no-ops via the HAS_APPSFLYER guard — the app runs, it
// just collects no attribution (identical to the documented no-key behaviour).
const APPSFLYER_NATIVE = !!NativeModules.RNAppsFlyer;

type AppsFlyerSdk = typeof import('react-native-appsflyer').default;
let appsFlyer: AppsFlyerSdk = {} as unknown as AppsFlyerSdk;
if (APPSFLYER_NATIVE) {
  try {
    appsFlyer = require('react-native-appsflyer').default;
  } catch {
    // native module reported present but require failed — keep the inert stub
  }
}

// Boulevard install attribution — wraps the AppsFlyer SDK.
//
// Purpose: attribute installs to paid ad campaigns (Meta, TikTok) and log a
// few lightweight in-app events. AppsFlyer is best-effort instrumentation —
// it must never block app launch, playback, or any user-facing flow.
//
// The dev key is a *client-side* key (it ships inside every AppsFlyer app),
// so reading it from EXPO_PUBLIC_APPSFLYER_DEV_KEY and bundling it is correct
// and safe. Without a key the SDK is never touched and every export no-ops,
// so the app runs identically whether or not attribution is configured.
//
// Setup OUTSIDE this file:
//   1) Create the Boulevard app in the AppsFlyer dashboard, attach the
//      Android (com.boulevard.app) and iOS apps.
//   2) Drop the dev key into .env as EXPO_PUBLIC_APPSFLYER_DEV_KEY.
//   3) (iOS only) set EXPO_PUBLIC_APPSFLYER_IOS_APP_ID once the App Store
//      listing exists — Android does not need it.

const DEV_KEY = (process.env.EXPO_PUBLIC_APPSFLYER_DEV_KEY ?? '').trim();

// iOS App Store numeric id. Android attribution does not use it; left empty
// until the iOS listing exists.
const IOS_APP_ID = (process.env.EXPO_PUBLIC_APPSFLYER_IOS_APP_ID ?? '').trim();

/** True only when a dev key is present AND the native SDK is linked (a real
 *  dev/prod build, never Expo Go). Callers branch on this. */
export const HAS_APPSFLYER = DEV_KEY.length > 0 && APPSFLYER_NATIVE;

let initialized = false;
let initInFlight: Promise<void> | null = null;

/**
 * Initialize AppsFlyer exactly once. Safe to call on every app launch.
 * Registers the install-attribution / conversion-data listener so installs
 * driven by Meta or TikTok ads are attributed. Any failure is swallowed —
 * attribution is non-essential and must not break launch.
 */
export async function initAppsFlyer(): Promise<void> {
  if (!HAS_APPSFLYER || initialized) return;
  if (initInFlight) return initInFlight;

  initInFlight = (async () => {
    try {
      // Conversion-data listener fires once with the install attribution
      // (af_status Organic/Non-organic, media source, campaign). Registered
      // BEFORE initSdk so the first install payload is never missed.
      appsFlyer.onInstallConversionData((res) => {
        try {
          const status = res?.data?.af_status ?? 'unknown';
          const source = res?.data?.media_source ?? 'organic';
          const firstLaunch = res?.data?.is_first_launch === 'true';
          console.log(
            `[AppsFlyer] attribution: ${status} via ${source}` +
              (firstLaunch ? ' (install)' : ' (open)'),
          );
        } catch {
          // ignore — listener must never throw
        }
      });
      appsFlyer.onAppOpenAttribution((res) => {
        try {
          console.log('[AppsFlyer] app open attribution:', res?.status ?? '');
        } catch {
          // ignore
        }
      });

      const options: { devKey: string; isDebug: boolean; onInstallConversionDataListener: boolean; onDeepLinkListener: boolean; appId?: string } = {
        devKey: DEV_KEY,
        isDebug: false,
        onInstallConversionDataListener: true,
        onDeepLinkListener: false,
      };
      if (Platform.OS === 'ios' && IOS_APP_ID) {
        options.appId = IOS_APP_ID;
      }

      await appsFlyer.initSdk(options);
      initialized = true;
    } catch {
      // SDK init failure is non-fatal. The app keeps running with no
      // attribution; nothing downstream depends on AppsFlyer succeeding.
    } finally {
      initInFlight = null;
    }
  })();

  return initInFlight;
}

/**
 * Log an in-app event to AppsFlyer. No-ops until the SDK is initialized so a
 * call made during cold start can't crash. Best-effort: errors are swallowed.
 */
export async function logAppsFlyerEvent(
  eventName: string,
  eventValues: Record<string, unknown> = {},
): Promise<void> {
  if (!HAS_APPSFLYER || !initialized) return;
  try {
    await appsFlyer.logEvent(eventName, eventValues);
  } catch {
    // best-effort — never surface attribution failures to the user
  }
}

/**
 * Associate the AppsFlyer profile with Boulevard's app user id, so install
 * attribution can be tied back to a known user. Called when auth resolves.
 */
export function setAppsFlyerCustomerUserId(userId: string | null): void {
  if (!HAS_APPSFLYER || !userId) return;
  try {
    appsFlyer.setCustomerUserId(userId);
  } catch {
    // best-effort
  }
}
