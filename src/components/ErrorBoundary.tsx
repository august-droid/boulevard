import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts, metals, radii, spacing } from '@/theme';

// Catches render-time errors anywhere in the React tree so a bad render
// doesn't leave the user staring at a blank black screen. Lets them tap
// to retry, which resets the boundary's state.

interface Props { children: React.ReactNode; }
interface State { error: Error | null; }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Log to console in dev. In prod this would forward to Sentry/Bugsnag.
    // eslint-disable-next-line no-console
    console.error('Boulevard caught render error:', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <View style={styles.root}>
          <View style={styles.card}>
            <Text style={styles.title}>Something went sideways</Text>
            <Text style={styles.body}>
              Boulevard hit an unexpected error and didn't render this screen.
              Tap below to try again — your saved songs and listening history
              are safe.
            </Text>
            <Pressable onPress={this.reset} style={styles.btn}>
              <Text style={styles.btnText}>Try again</Text>
            </Pressable>
            {__DEV__ && (
              <Text style={styles.dev} numberOfLines={6}>
                {this.state.error.message}
              </Text>
            )}
          </View>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  card: {
    width: '100%',
    maxWidth: 380,
    padding: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  title: { color: colors.text, fontSize: fonts.size.xl, fontWeight: fonts.weight.bold, letterSpacing: -0.4 },
  body: { color: colors.textMuted, fontSize: fonts.size.sm, marginTop: spacing.sm, lineHeight: 20 },
  btn: {
    marginTop: spacing.lg, paddingVertical: 14, alignItems: 'center', borderRadius: radii.pill,
    backgroundColor: colors.text,
  },
  btnText: { color: colors.bg, fontWeight: fonts.weight.bold, fontSize: fonts.size.md },
  dev: { color: colors.textDim, fontSize: 11, marginTop: spacing.md, fontFamily: 'Menlo' },
});
