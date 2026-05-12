import { Platform } from 'react-native';
import Purchases, {
  CustomerInfo,
  PurchasesOffering,
  PurchasesPackage,
  LOG_LEVEL,
} from 'react-native-purchases';

// Boulevard billing — wraps RevenueCat. We never talk to Google Play Billing
// directly; RevenueCat handles receipts, restore, entitlement state, and
// (later) the same code path works for iOS via App Store StoreKit.
//
// Setup steps OUTSIDE this file:
//   1) Play Console: create two subscription products under the boulevard
//      app — IDs must match PRODUCT_IDS below.
//   2) RevenueCat dashboard: link the Play Console app, attach those product
//      IDs to a single offering called "default", attach both to a single
//      entitlement called "premium".
//   3) Drop the Android REVENUECAT_API_KEY into .env (or app config). This
//      module reads it from process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY
//      so it ships with the bundle.

export const PRODUCT_IDS = {
  yearly: 'boulevard_yearly',
  monthly: 'boulevard_monthly',
} as const;

export type PlanId = keyof typeof PRODUCT_IDS;

export const ENTITLEMENT_KEY = 'premium';

// We read the API key from env so production / staging can swap without code
// changes. Without a key the SDK runs in a no-op mode (we never touch it).
const ANDROID_KEY = (process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY ?? '').trim();
const IOS_KEY = (process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY ?? '').trim();

export const HAS_BILLING = (Platform.OS === 'android' && ANDROID_KEY.length > 0)
  || (Platform.OS === 'ios' && IOS_KEY.length > 0);

let configured = false;
let listenerRegistered = false;
const customerListeners = new Set<(info: CustomerInfo) => void>();

/**
 * Initialize RevenueCat exactly once. Safe to call on every app launch —
 * the underlying SDK no-ops on repeated calls with the same key.
 */
export async function configureBilling(appUserId: string | null): Promise<void> {
  if (!HAS_BILLING) return;
  if (configured) {
    // Logged-in user changed mid-session — re-identify.
    if (appUserId) {
      try { await Purchases.logIn(appUserId); } catch { /* ignore */ }
    }
    return;
  }
  try {
    const key = Platform.OS === 'android' ? ANDROID_KEY : IOS_KEY;
    Purchases.setLogLevel(LOG_LEVEL.ERROR);
    Purchases.configure({ apiKey: key, appUserID: appUserId ?? undefined });
    configured = true;
    if (!listenerRegistered) {
      Purchases.addCustomerInfoUpdateListener((info) => {
        customerListeners.forEach((l) => l(info));
      });
      listenerRegistered = true;
    }
  } catch {
    // SDK init failure is non-fatal — the app still runs, just without
    // billing. PaywallScreen will fall back to a disabled state.
  }
}

/** Subscribe to customer-info updates from the RevenueCat SDK. */
export function onCustomerInfo(fn: (info: CustomerInfo) => void): () => void {
  customerListeners.add(fn);
  return () => customerListeners.delete(fn);
}

/** True iff the user has the "premium" entitlement active right now. */
export function isPremium(info: CustomerInfo | null): boolean {
  if (!info) return false;
  return Boolean(info.entitlements.active[ENTITLEMENT_KEY]);
}

/** Pull the current entitlement state (cached locally by the SDK). */
export async function getCustomerInfo(): Promise<CustomerInfo | null> {
  if (!HAS_BILLING || !configured) return null;
  try { return await Purchases.getCustomerInfo(); } catch { return null; }
}

/** Fetch the default offering, which contains the yearly + monthly packages. */
export async function getOffering(): Promise<PurchasesOffering | null> {
  if (!HAS_BILLING || !configured) return null;
  try {
    const offerings = await Purchases.getOfferings();
    return offerings.current ?? offerings.all['default'] ?? null;
  } catch {
    return null;
  }
}

/** Map an offering package to our PlanId so the UI can pre-select correctly. */
export function packageToPlan(pkg: PurchasesPackage): PlanId | null {
  const id = pkg.product.identifier;
  if (id === PRODUCT_IDS.yearly) return 'yearly';
  if (id === PRODUCT_IDS.monthly) return 'monthly';
  return null;
}

/**
 * Purchase a package and return the resulting CustomerInfo. Throws on user
 * cancel — caller should swallow it and update UI to "back to paywall".
 */
export async function purchasePackage(pkg: PurchasesPackage): Promise<CustomerInfo> {
  if (!HAS_BILLING || !configured) {
    throw new Error('Billing is not configured');
  }
  const { customerInfo } = await Purchases.purchasePackage(pkg);
  return customerInfo;
}

/**
 * Restore previous purchases. Required by Google Play and the Apple App
 * Store — users who reinstall must be able to recover their entitlement.
 */
export async function restorePurchases(): Promise<CustomerInfo | null> {
  if (!HAS_BILLING || !configured) return null;
  try {
    return await Purchases.restorePurchases();
  } catch {
    return null;
  }
}
