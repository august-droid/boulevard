// Web build of the billing module.
//
// The web app is intentionally paywall-free: no subscriptions, no RevenueCat.
// `react-native-purchases` is a native-only module and would break the web
// bundle, so Metro picks this file instead of Billing.ts whenever it builds
// for `Platform.OS === 'web'`. Every export here is an inert no-op that keeps
// the same shape as the native module, so shared callers (AuthContext) compile
// and run unchanged.

export const PRODUCT_IDS = {
  yearly: 'boulevard_yearly',
  monthly: 'boulevard_monthly',
} as const;

export type PlanId = keyof typeof PRODUCT_IDS;

export const ENTITLEMENT_KEY = 'premium';

// No billing on web — the listening cap is enforced by the login gate, not
// a paywall. Callers branch on this and skip every billing code path.
export const HAS_BILLING = false;

export async function configureBilling(_appUserId: string | null): Promise<void> {
  // no-op
}

export function onCustomerInfo(_fn: (info: unknown) => void): () => void {
  return () => {};
}

export function isPremium(_info: unknown): boolean {
  return false;
}

export async function getCustomerInfo(): Promise<unknown> {
  return null;
}

export async function getOffering(): Promise<unknown> {
  return null;
}

export function packageToPlan(_pkg: unknown): PlanId | null {
  return null;
}

export async function purchasePackage(_pkg: unknown): Promise<never> {
  throw new Error('Billing is not available on the web app.');
}

export async function restorePurchases(): Promise<unknown> {
  return null;
}

// Spec-named RevenueCat service surface — inert on web, mirrors Billing.ts.

export async function configureRevenueCat(_appUserId: string | null): Promise<void> {
  // no-op
}

export async function getOfferings(): Promise<unknown> {
  return null;
}

export async function hasPremiumEntitlement(): Promise<boolean> {
  return false;
}

export type PurchaseErrorKind =
  | 'cancelled'
  | 'network'
  | 'billing_unavailable'
  | 'unknown';

export function classifyPurchaseError(_e: unknown): PurchaseErrorKind {
  return 'unknown';
}
