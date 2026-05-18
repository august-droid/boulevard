import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { CloseIcon } from '@/components/Icon';
import {
  fetchOverview,
  fetchTimeseries,
  fetchTopContent,
  fetchDistribution,
  pctChange,
  formatRate,
  formatDuration,
  formatCount,
  type AnalyticsPeriod,
  type AnalyticsOverview,
  type TimeseriesBucket,
  type WindowMetrics,
  type TopRow,
  type TopContentKind,
  type DistributionData,
} from '@/lib/admin/analytics';

interface Props {
  visible: boolean;
  onClose: () => void;
}

// Admin analytics dashboard. Deep visibility into retention, conversion
// funnels, session quality, listening behavior, top content, and algorithm
// health — on a day / week / month basis, each compared with the prior
// period. All data comes from the admin-only analytics_* RPCs.

const PERIOD_LABEL: Record<AnalyticsPeriod, string> = {
  day: 'Today',
  week: 'This week',
  month: 'This month',
};
const PREV_LABEL: Record<AnalyticsPeriod, string> = {
  day: 'vs yesterday',
  week: 'vs last week',
  month: 'vs last month',
};
const BUCKETS: Record<AnalyticsPeriod, number> = { day: 14, week: 8, month: 6 };

interface KpiDef {
  key: keyof WindowMetrics;
  label: string;
  kind: 'count' | 'rate' | 'duration' | 'number';
  goodWhenUp: boolean;
}

// The headline KPI grid — conversion funnels, session quality, listening.
const KPIS: KpiDef[] = [
  { key: 'active_users', label: 'Active users', kind: 'count', goodWhenUp: true },
  { key: 'app_opens_per_day', label: 'App opens / day', kind: 'number', goodWhenUp: true },
  { key: 'new_users', label: 'New users', kind: 'count', goodWhenUp: true },
  { key: 'signup_conversion_rate', label: 'Signup conversion', kind: 'rate', goodWhenUp: true },
  { key: 'new_premium', label: 'Premium conversions', kind: 'count', goodWhenUp: true },
  { key: 'premium_active_rate', label: 'Premium share', kind: 'rate', goodWhenUp: true },
  { key: 'avg_session_seconds', label: 'Avg session time', kind: 'duration', goodWhenUp: true },
  { key: 'avg_listen_pct', label: 'Avg listen %', kind: 'rate', goodWhenUp: true },
  { key: 'hook_rate', label: 'Hook rate', kind: 'rate', goodWhenUp: true },
  { key: 'drop_off_rate', label: 'Drop-off rate', kind: 'rate', goodWhenUp: false },
  { key: 'plays', label: 'Songs played', kind: 'count', goodWhenUp: true },
  { key: 'streams', label: 'Qualified streams', kind: 'count', goodWhenUp: true },
];

const TOP_KINDS: { key: TopContentKind; label: string }[] = [
  { key: 'genres', label: 'Genres' },
  { key: 'moods', label: 'Moods' },
  { key: 'artists', label: 'Artists' },
  { key: 'songs', label: 'Songs' },
  { key: 'replay_songs', label: 'Most replayed' },
  { key: 'retention_songs', label: 'Retention drivers' },
  { key: 'worlds', label: 'Explore worlds' },
  { key: 'onboarding_songs', label: 'Onboarding songs' },
  { key: 'onboarding_clusters', label: 'Onboarding clusters' },
  { key: 'clusters', label: 'Cluster performance' },
];

function formatMetric(v: number, kind: KpiDef['kind']): string {
  if (kind === 'rate') return formatRate(v);
  if (kind === 'duration') return formatDuration(v);
  if (kind === 'number') return v.toFixed(1);
  return formatCount(v);
}

function formatTopValue(row: TopRow): string {
  if (['retention', 'hit_rate', 'avg_completion'].includes(row.unit)) {
    return formatRate(row.value);
  }
  return formatCount(row.value);
}

export function AnalyticsScreen({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [period, setPeriod] = useState<AnalyticsPeriod>('week');
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [series, setSeries] = useState<TimeseriesBucket[]>([]);
  const [distribution, setDistribution] = useState<DistributionData | null>(null);
  const [topKind, setTopKind] = useState<TopContentKind>('genres');
  const [topRows, setTopRows] = useState<TopRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [topLoading, setTopLoading] = useState(false);

  const loadCore = useCallback(async (p: AnalyticsPeriod) => {
    setLoading(true);
    try {
      const [ov, ts, dist] = await Promise.all([
        fetchOverview(p),
        fetchTimeseries(p, BUCKETS[p]),
        fetchDistribution(),
      ]);
      setOverview(ov);
      setSeries(ts);
      setDistribution(dist);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTop = useCallback(async (kind: TopContentKind, p: AnalyticsPeriod) => {
    setTopLoading(true);
    try {
      setTopRows(await fetchTopContent(kind, p, 0, 12));
    } finally {
      setTopLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      void loadCore(period);
      void loadTop(topKind, period);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, period]);

  useEffect(() => {
    if (visible) void loadTop(topKind, period);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topKind]);

  const cur = overview?.current ?? null;
  const prev = overview?.previous ?? null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: insets.top + spacing.md }]}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>ADMIN</Text>
            <Text style={styles.title}>Analytics</Text>
          </View>
          <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn}>
            <CloseIcon size={22} color={colors.textMuted} />
          </Pressable>
        </View>

        <View style={styles.periodRow}>
          {(['day', 'week', 'month'] as AnalyticsPeriod[]).map((p) => (
            <Pressable
              key={p}
              onPress={() => setPeriod(p)}
              style={[styles.periodPill, period === p && styles.periodPillOn]}
            >
              <Text style={[styles.periodText, period === p && styles.periodTextOn]}>
                {p === 'day' ? 'Day' : p === 'week' ? 'Week' : 'Month'}
              </Text>
            </Pressable>
          ))}
        </View>

        {loading && !overview ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.text} />
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{
              paddingBottom: insets.bottom + spacing.xxl,
              paddingHorizontal: spacing.lg,
            }}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.periodCaption}>
              {PERIOD_LABEL[period]} {PREV_LABEL[period]} · current period in progress
            </Text>

            {/* KPI grid */}
            <View style={styles.kpiGrid}>
              {KPIS.map((kpi) => (
                <KpiCard
                  key={kpi.key}
                  def={kpi}
                  current={cur ? cur[kpi.key] : 0}
                  previous={prev ? prev[kpi.key] : 0}
                  series={series.map((b) => b.metrics[kpi.key])}
                />
              ))}
            </View>

            {/* Top content */}
            <Text style={styles.sectionLabel}>TOP CONTENT</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.kindRow}
            >
              {TOP_KINDS.map((k) => (
                <Pressable
                  key={k.key}
                  onPress={() => setTopKind(k.key)}
                  style={[styles.kindPill, topKind === k.key && styles.kindPillOn]}
                >
                  <Text style={[styles.kindText, topKind === k.key && styles.kindTextOn]}>
                    {k.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <TopList rows={topRows} loading={topLoading} />

            {/* Distribution / algorithm health */}
            <Text style={styles.sectionLabel}>ALGORITHM & DISTRIBUTION HEALTH</Text>
            <DistributionPanel data={distribution} />
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

// ---- KPI card --------------------------------------------------------

function KpiCard({
  def,
  current,
  previous,
  series,
}: {
  def: KpiDef;
  current: number;
  previous: number;
  series: number[];
}) {
  const change = pctChange(current, previous);
  const up = change != null && change > 0;
  const down = change != null && change < 0;
  // Color the delta by whether the movement is good for this metric.
  const positive = (up && def.goodWhenUp) || (down && !def.goodWhenUp);
  const negative = (down && def.goodWhenUp) || (up && !def.goodWhenUp);
  const deltaColor = positive ? colors.success : negative ? '#ef6868' : colors.textMuted;

  return (
    <View style={styles.kpiCard}>
      <Text style={styles.kpiLabel}>{def.label}</Text>
      <Text style={styles.kpiValue}>{formatMetric(current, def.kind)}</Text>
      <View style={styles.kpiDeltaRow}>
        <Text style={[styles.kpiDelta, { color: deltaColor }]}>
          {change == null
            ? '—'
            : `${up ? '▲' : down ? '▼' : ''} ${Math.abs(change * 100).toFixed(1)}%`}
        </Text>
      </View>
      <Sparkline values={series} color={deltaColor} />
    </View>
  );
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (!values.length) return <View style={styles.sparkRow} />;
  const max = Math.max(...values, 0.0001);
  return (
    <View style={styles.sparkRow}>
      {values.map((v, i) => {
        const h = Math.max(2, (Math.max(0, v) / max) * 26);
        const isLast = i === values.length - 1;
        return (
          <View
            key={i}
            style={[
              styles.sparkBar,
              { height: h, backgroundColor: isLast ? color : 'rgba(255,255,255,0.16)' },
            ]}
          />
        );
      })}
    </View>
  );
}

// ---- Top content list -----------------------------------------------

function TopList({ rows, loading }: { rows: TopRow[]; loading: boolean }) {
  if (loading) {
    return (
      <View style={styles.topLoading}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }
  if (rows.length === 0) {
    return <Text style={styles.emptyLine}>No data for this period yet.</Text>;
  }
  const max = Math.max(...rows.map((r) => r.value), 0.0001);
  return (
    <View style={styles.topCard}>
      {rows.map((r, i) => (
        <View key={`${r.label}-${i}`} style={styles.topRow}>
          <Text style={styles.topRank}>{i + 1}</Text>
          <View style={styles.topMeta}>
            <Text style={styles.topLabel} numberOfLines={1}>
              {r.label}
            </Text>
            {r.sub ? (
              <Text style={styles.topSub} numberOfLines={1}>
                {r.sub}
              </Text>
            ) : null}
            <View style={styles.topBarTrack}>
              <View style={[styles.topBarFill, { width: `${(r.value / max) * 100}%` }]} />
            </View>
          </View>
          <Text style={styles.topValue}>{formatTopValue(r)}</Text>
        </View>
      ))}
    </View>
  );
}

// ---- Distribution panel ---------------------------------------------

const QUALITY_LABELS = ['0-20', '20-40', '40-60', '60-80', '80-100'];

function DistributionPanel({ data }: { data: DistributionData | null }) {
  if (!data) {
    return <Text style={styles.emptyLine}>Distribution data unavailable.</Text>;
  }
  const sc = data.stage_counts;
  const histMax = Math.max(...data.quality_histogram.map((b) => b.count), 1);
  const histByBucket = new Map(data.quality_histogram.map((b) => [b.bucket, b.count]));

  return (
    <View style={styles.distCard}>
      <View style={styles.stageRow}>
        <StageStat label="New test" value={sc.new_test} color={colors.textMuted} />
        <StageStat label="Rising" value={sc.rising} color="#e0b341" />
        <StageStat label="Trending" value={sc.trending} color={colors.success} />
        <StageStat label="Suppressed" value={sc.suppressed} color="#ef6868" />
      </View>

      <View style={styles.distRateRow}>
        <RateStat label="New-test survival" value={data.new_test_survival_rate} good />
        <RateStat label="Rising → trending" value={data.rising_to_trending_rate} good />
        <RateStat label="Suppression rate" value={data.suppression_rate} good={false} />
      </View>

      <Text style={styles.distSub}>Quality-score distribution</Text>
      <View style={styles.histRow}>
        {QUALITY_LABELS.map((lbl, idx) => {
          const count = histByBucket.get(idx + 1) ?? 0;
          return (
            <View key={lbl} style={styles.histCol}>
              <Text style={styles.histCount}>{count}</Text>
              <View
                style={[
                  styles.histBar,
                  { height: Math.max(3, (count / histMax) * 70) },
                ]}
              />
              <Text style={styles.histLabel}>{lbl}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function StageStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={styles.stageStat}>
      <Text style={[styles.stageValue, { color }]}>{formatCount(value)}</Text>
      <Text style={styles.stageLabel}>{label}</Text>
    </View>
  );
}

function RateStat({ label, value, good }: { label: string; value: number; good: boolean }) {
  return (
    <View style={styles.rateStat}>
      <Text style={[styles.rateValue, { color: good ? colors.success : '#e0b341' }]}>
        {formatRate(value)}
      </Text>
      <Text style={styles.rateLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginBottom: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  eyebrow: {
    color: colors.textMuted,
    fontSize: 11,
    letterSpacing: 2.4,
    fontWeight: fonts.weight.semibold,
  },
  title: {
    color: colors.text,
    fontSize: fonts.size.display,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.5,
    marginTop: 4,
  },
  closeBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: colors.surface,
  },

  periodRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  periodPill: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: radii.pill,
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  periodPillOn: { backgroundColor: metals.goldSolid, borderColor: metals.goldSolid },
  periodText: { color: colors.textMuted, fontSize: fonts.size.sm, fontWeight: fonts.weight.semibold },
  periodTextOn: { color: colors.bg, fontWeight: fonts.weight.bold },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  periodCaption: {
    color: colors.textDim,
    fontSize: fonts.size.xs,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  emptyLine: { color: colors.textMuted, fontSize: fonts.size.sm, marginTop: spacing.sm },

  sectionLabel: {
    color: colors.textMuted,
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: fonts.weight.semibold,
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },

  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  kpiCard: {
    width: '48.5%',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  kpiLabel: { color: colors.textMuted, fontSize: fonts.size.xs, fontWeight: fonts.weight.medium },
  kpiValue: {
    color: colors.text,
    fontSize: fonts.size.xl,
    fontWeight: fonts.weight.bold,
    letterSpacing: -0.5,
    marginTop: 4,
    fontVariant: ['tabular-nums'],
  },
  kpiDeltaRow: { marginTop: 2 },
  kpiDelta: { fontSize: fonts.size.xs, fontWeight: fonts.weight.bold },
  sparkRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    height: 28,
    marginTop: spacing.sm,
  },
  sparkBar: { flex: 1, borderRadius: 1.5, minWidth: 2 },

  kindRow: { gap: 6, paddingVertical: 2, paddingRight: spacing.lg },
  kindPill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  kindPillOn: { backgroundColor: metals.goldSolid, borderColor: metals.goldSolid },
  kindText: { color: colors.textMuted, fontSize: fonts.size.xs, fontWeight: fonts.weight.medium },
  kindTextOn: { color: colors.bg, fontWeight: fonts.weight.bold },

  topLoading: { paddingVertical: spacing.xl, alignItems: 'center' },
  topCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.sm,
    marginTop: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 8,
    paddingHorizontal: 6,
  },
  topRank: {
    color: colors.textDim,
    fontSize: fonts.size.sm,
    fontWeight: fonts.weight.bold,
    width: 20,
    textAlign: 'center',
  },
  topMeta: { flex: 1, minWidth: 0 },
  topLabel: { color: colors.text, fontSize: fonts.size.sm, fontWeight: fonts.weight.semibold, textTransform: 'capitalize' },
  topSub: { color: colors.textDim, fontSize: 10, marginTop: 1 },
  topBarTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginTop: 5,
    overflow: 'hidden',
  },
  topBarFill: { height: 4, borderRadius: 2, backgroundColor: metals.goldSolid },
  topValue: {
    color: colors.text,
    fontSize: fonts.size.sm,
    fontWeight: fonts.weight.bold,
    fontVariant: ['tabular-nums'],
  },

  distCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    marginTop: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  stageRow: { flexDirection: 'row', justifyContent: 'space-between' },
  stageStat: { alignItems: 'center', flex: 1 },
  stageValue: { fontSize: fonts.size.lg, fontWeight: fonts.weight.bold, fontVariant: ['tabular-nums'] },
  stageLabel: { color: colors.textDim, fontSize: 10, marginTop: 2, letterSpacing: 0.3 },

  distRateRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.divider,
  },
  rateStat: { alignItems: 'center', flex: 1 },
  rateValue: { fontSize: fonts.size.md, fontWeight: fonts.weight.bold },
  rateLabel: { color: colors.textDim, fontSize: 10, marginTop: 2, textAlign: 'center' },

  distSub: {
    color: colors.textMuted,
    fontSize: fonts.size.xs,
    fontWeight: fonts.weight.semibold,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  histRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: spacing.sm },
  histCol: { flex: 1, alignItems: 'center' },
  histCount: { color: colors.textMuted, fontSize: 10, marginBottom: 4, fontVariant: ['tabular-nums'] },
  histBar: {
    width: '70%',
    borderRadius: 3,
    backgroundColor: metals.goldSolid,
  },
  histLabel: { color: colors.textDim, fontSize: 9, marginTop: 4 },
});
