// Web build of the paywall screen.
//
// The web app has no paywall by design — anonymous users get five free plays
// and are then asked to sign in (free), never to pay. Metro resolves this
// stub instead of PaywallScreen.tsx for `Platform.OS === 'web'`, which also
// keeps the native-only `react-native-purchases` import out of the web bundle.
// RootNavigator still renders <PaywallScreen /> unconditionally; on web it is
// simply this inert component.

interface Props {
  visible: boolean;
  onClose: () => void;
  onOpenSignIn?: () => void;
}

export function PaywallScreen(_props: Props): null {
  return null;
}
