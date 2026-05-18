import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  Alert,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, metals, radii, spacing } from '@/theme';
import { CloseIcon, ChevronLeftIcon, CheckIcon, SparkleIcon } from '@/components/Icon';
import { useExperimentContext } from '@/contexts/ExperimentContext';
import {
  SURFACES,
  SURFACE_BY_KEY,
  EXPERIMENT_CATEGORIES,
  METRICS,
  METRIC_BY_KEY,
  METRICS_BY_CATEGORY,
  VARIANT_CONFIG_EXAMPLES,
} from '@/lib/experiments/catalog';
import {
  listExperiments,
  createExperiment,
  updateExperimentFull,
  setStatus,
  duplicateExperiment,
  computeLiveReport,
  submitReport,
  fetchReports,
  fetchApprovals,
  approveExperiment,
  autopilotSweep,
  type ExperimentInput,
  type VariantInput,
} from '@/lib/experiments/adminExperiments';
import {
  syncAndFetchSuggestions,
  acceptSuggestion,
  dismissSuggestion,
} from '@/lib/experiments/suggestions';
import type {
  Experiment,
  ExperimentReport,
  ExperimentApproval,
  ExperimentStatus,
  ExperimentSuggestion,
  SurfaceKey,
  ExperimentCategory,
} from '@/lib/experiments/types';

interface Props {
  visible: boolean;
  onClose: () => void;
}

// Admin "Experiments" dashboard. A self-contained modal with three views:
// the experiment list (+ AI suggestions), the create/edit form, and the
// experiment detail (live results, reports, the human approval gate).

type DashView =
  | { name: 'list' }
  | { name: 'form'; editing: Experiment | null }
  | { name: 'detail'; id: string };

const STATUS_LABEL: Record<ExperimentStatus, string> = {
  draft: 'Draft',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  awaiting_approval: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
  archived: 'Archived',
};

const STATUS_COLOR: Record<ExperimentStatus, string> = {
  draft: colors.textMuted,
  running: colors.success,
  paused: '#e0b341',
  completed: metals.goldSolidHi,
  awaiting_approval: '#e0b341',
  approved: colors.success,
  rejected: '#ef6868',
  archived: colors.textDim,
};

export function ExperimentsScreen({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const expCtx = useExperimentContext();
  const [view, setView] = useState<DashView>({ name: 'list' });
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [suggestions, setSuggestions] = useState<ExperimentSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [autopilotNote, setAutopilotNote] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listExperiments();
      // Autopilot sweep — monitor running tests and auto-complete finished
      // ones into awaiting_approval. Never pushes a winner live.
      const outcomes = await autopilotSweep(list);
      const completed = outcomes.filter((o) => o.completed);
      const fresh = completed.length > 0 ? await listExperiments() : list;
      setExperiments(fresh);
      setSuggestions(await syncAndFetchSuggestions(fresh));
      setAutopilotNote(
        completed.length > 0
          ? `Autopilot moved ${completed.length} test(s) to awaiting approval.`
          : null,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      setView({ name: 'list' });
      void reload();
    }
  }, [visible, reload]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: insets.top + spacing.md }]}>
        {view.name === 'list' && (
          <ListView
            insets={insets}
            loading={loading}
            experiments={experiments}
            suggestions={suggestions}
            autopilotNote={autopilotNote}
            onClose={onClose}
            onCreate={() => setView({ name: 'form', editing: null })}
            onOpen={(id) => setView({ name: 'detail', id })}
            onReload={reload}
          />
        )}
        {view.name === 'form' && (
          <FormView
            insets={insets}
            editing={view.editing}
            onBack={() => setView({ name: 'list' })}
            onSaved={async () => {
              await reload();
              setView({ name: 'list' });
            }}
          />
        )}
        {view.name === 'detail' && (
          <DetailView
            insets={insets}
            experiment={experiments.find((e) => e.id === view.id) ?? null}
            onBack={() => setView({ name: 'list' })}
            onEdit={(exp) => setView({ name: 'form', editing: exp })}
            onChanged={reload}
            onApprovedWinner={() => {
              // A winner went live — refresh the runtime experiment cache so
              // the new default applies app-wide without a reload.
              void expCtx.refresh();
            }}
          />
        )}
      </View>
    </Modal>
  );
}

// ====================================================================
// List view
// ====================================================================

function ListView(props: {
  insets: { top: number; bottom: number };
  loading: boolean;
  experiments: Experiment[];
  suggestions: ExperimentSuggestion[];
  autopilotNote: string | null;
  onClose: () => void;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onReload: () => Promise<void>;
}) {
  const { experiments, suggestions } = props;
  const active = experiments.filter((e) =>
    ['running', 'paused', 'awaiting_approval'].includes(e.status),
  );
  const drafts = experiments.filter((e) => e.status === 'draft');
  const done = experiments.filter((e) =>
    ['approved', 'rejected', 'completed', 'archived'].includes(e.status),
  );

  return (
    <>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>ADMIN</Text>
          <Text style={styles.title}>Split Tests</Text>
        </View>
        <Pressable onPress={props.onClose} hitSlop={10} style={styles.closeBtn}>
          <CloseIcon size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      {props.loading && experiments.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.text} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: props.insets.bottom + spacing.xxl }}
          showsVerticalScrollIndicator={false}
        >
          <Pressable onPress={props.onCreate} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>+ New Split Test</Text>
          </Pressable>

          {props.autopilotNote && (
            <View style={styles.noteBox}>
              <SparkleIcon size={14} color={metals.goldSolidHi} />
              <Text style={styles.noteText}>{props.autopilotNote}</Text>
            </View>
          )}

          {suggestions.length > 0 && (
            <Section title="AI-RECOMMENDED TESTS">
              {suggestions.map((s) => (
                <SuggestionCard key={s.suggestion_key} suggestion={s} onReload={props.onReload} />
              ))}
            </Section>
          )}

          <Section title={`ACTIVE (${active.length})`}>
            {active.length === 0 ? (
              <Text style={styles.emptyLine}>No running tests.</Text>
            ) : (
              active.map((e) => (
                <ExperimentRow key={e.id} experiment={e} onPress={() => props.onOpen(e.id)} />
              ))
            )}
          </Section>

          {drafts.length > 0 && (
            <Section title={`DRAFTS (${drafts.length})`}>
              {drafts.map((e) => (
                <ExperimentRow key={e.id} experiment={e} onPress={() => props.onOpen(e.id)} />
              ))}
            </Section>
          )}

          {done.length > 0 && (
            <Section title={`COMPLETED & ARCHIVED (${done.length})`}>
              {done.map((e) => (
                <ExperimentRow key={e.id} experiment={e} onPress={() => props.onOpen(e.id)} />
              ))}
            </Section>
          )}
        </ScrollView>
      )}
    </>
  );
}

function SuggestionCard({
  suggestion,
  onReload,
}: {
  suggestion: ExperimentSuggestion;
  onReload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    setBusy(true);
    try {
      await acceptSuggestion(suggestion);
      await onReload();
    } catch (e) {
      Alert.alert('Could not create draft', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const dismiss = async () => {
    setBusy(true);
    try {
      await dismissSuggestion(suggestion.suggestion_key);
      await onReload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.suggestionCard}>
      <Text style={styles.suggestionTitle}>{suggestion.title}</Text>
      <Text style={styles.suggestionMeta}>
        {SURFACE_BY_KEY[suggestion.surface_key]?.label} ·{' '}
        {METRIC_BY_KEY[suggestion.goal_metric]?.label ?? suggestion.goal_metric}
      </Text>
      <Text style={styles.suggestionBody} numberOfLines={3}>
        {suggestion.hypothesis}
      </Text>
      <Text style={styles.suggestionRationale} numberOfLines={2}>
        {suggestion.rationale}
      </Text>
      <View style={styles.suggestionActions}>
        <Pressable onPress={dismiss} disabled={busy} style={[styles.smallBtn, styles.ghostBtn]}>
          <Text style={styles.ghostBtnText}>Dismiss</Text>
        </Pressable>
        <Pressable onPress={accept} disabled={busy} style={[styles.smallBtn, styles.goldBtn]}>
          <Text style={styles.goldBtnText}>{busy ? '…' : 'Approve → Draft'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ExperimentRow({
  experiment,
  onPress,
}: {
  experiment: Experiment;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.row}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {experiment.name}
        </Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {SURFACE_BY_KEY[experiment.surface_key]?.label ?? experiment.surface_key} ·{' '}
          {(experiment.variants ?? []).length} variants
        </Text>
      </View>
      <StatusBadge status={experiment.status} />
    </Pressable>
  );
}

function StatusBadge({ status }: { status: ExperimentStatus }) {
  return (
    <View style={[styles.badge, { borderColor: STATUS_COLOR[status] }]}>
      <Text style={[styles.badgeText, { color: STATUS_COLOR[status] }]}>
        {STATUS_LABEL[status]}
      </Text>
    </View>
  );
}

// ====================================================================
// Create / edit form
// ====================================================================

interface VariantForm {
  key: string;
  name: string;
  is_control: boolean;
  traffic_weight: string;
  configText: string;
}

function FormView(props: {
  insets: { top: number; bottom: number };
  editing: Experiment | null;
  onBack: () => void;
  onSaved: () => Promise<void>;
}) {
  const { editing } = props;
  const [name, setName] = useState(editing?.name ?? '');
  const [hypothesis, setHypothesis] = useState(editing?.hypothesis ?? '');
  const [surface, setSurface] = useState<SurfaceKey>(editing?.surface_key ?? 'premium_popup');
  const [category, setCategory] = useState<ExperimentCategory>(
    editing?.category ?? SURFACE_BY_KEY['premium_popup'].category,
  );
  const [goalMetric, setGoalMetric] = useState(editing?.goal_metric ?? 'premium_conversion_rate');
  const [secondary, setSecondary] = useState<string[]>(editing?.secondary_metrics ?? []);
  const [criteria, setCriteria] = useState(editing?.success_criteria ?? '');
  const [minSample, setMinSample] = useState(String(editing?.min_sample_size ?? 1000));
  const [minRuntime, setMinRuntime] = useState(String(editing?.min_runtime_hours ?? 168));
  const [confidence, setConfidence] = useState(
    String(Math.round((editing?.confidence_threshold ?? 0.95) * 100)),
  );
  const [audiencePlatform, setAudiencePlatform] = useState<'all' | 'web' | 'ios' | 'android'>(
    editing?.audience.platform ?? 'all',
  );
  const [anonOnly, setAnonOnly] = useState(Boolean(editing?.audience.anonymous_only));
  const [minSongs, setMinSongs] = useState(String(editing?.audience.min_songs_heard ?? 0));
  const [variants, setVariants] = useState<VariantForm[]>(() => {
    if (editing?.variants?.length) {
      return editing.variants.map((v) => ({
        key: v.key,
        name: v.name,
        is_control: v.is_control,
        traffic_weight: String(v.traffic_weight),
        configText: JSON.stringify(v.config, null, 2),
      }));
    }
    const example = JSON.stringify(VARIANT_CONFIG_EXAMPLES['premium_popup'], null, 2);
    return [
      { key: 'A', name: 'Control', is_control: true, traffic_weight: '1', configText: example },
      { key: 'B', name: 'Variant B', is_control: false, traffic_weight: '1', configText: example },
    ];
  });
  const [saving, setSaving] = useState(false);

  const onPickSurface = (s: SurfaceKey) => {
    setSurface(s);
    setCategory(SURFACE_BY_KEY[s].category);
    const metricsForCat = METRICS_BY_CATEGORY[SURFACE_BY_KEY[s].category];
    if (metricsForCat?.length) setGoalMetric(metricsForCat[0]);
  };

  const updateVariant = (i: number, patch: Partial<VariantForm>) => {
    setVariants((vs) => vs.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));
  };
  const setControl = (i: number) => {
    setVariants((vs) => vs.map((v, idx) => ({ ...v, is_control: idx === i })));
  };
  const addVariant = () => {
    const nextKey = String.fromCharCode(65 + variants.length);
    setVariants((vs) => [
      ...vs,
      {
        key: nextKey,
        name: `Variant ${nextKey}`,
        is_control: false,
        traffic_weight: '1',
        configText: JSON.stringify(VARIANT_CONFIG_EXAMPLES[surface], null, 2),
      },
    ]);
  };
  const removeVariant = (i: number) => {
    if (variants.length <= 2) return;
    setVariants((vs) => vs.filter((_, idx) => idx !== i));
  };

  const buildInput = (): ExperimentInput => {
    const parsedVariants: VariantInput[] = variants.map((v, i) => {
      let config: Record<string, unknown> = {};
      const text = v.configText.trim();
      if (text) {
        config = JSON.parse(text);
        if (typeof config !== 'object' || Array.isArray(config)) {
          throw new Error(`Variant ${v.key}: config must be a JSON object`);
        }
      }
      return {
        key: v.key.trim() || String.fromCharCode(65 + i),
        name: v.name.trim() || `Variant ${i + 1}`,
        is_control: v.is_control,
        config,
        traffic_weight: Math.max(0, parseInt(v.traffic_weight, 10) || 0),
        sort_order: i,
      };
    });
    return {
      name: name.trim(),
      hypothesis: hypothesis.trim(),
      surface_key: surface,
      category,
      goal_metric: goalMetric,
      secondary_metrics: secondary,
      success_criteria: criteria.trim(),
      audience: {
        ...(audiencePlatform !== 'all' ? { platform: audiencePlatform } : {}),
        ...(anonOnly ? { anonymous_only: true } : {}),
        ...((parseInt(minSongs, 10) || 0) > 0
          ? { min_songs_heard: parseInt(minSongs, 10) }
          : {}),
      },
      min_sample_size: Math.max(0, parseInt(minSample, 10) || 0),
      min_runtime_hours: Math.max(0, parseInt(minRuntime, 10) || 0),
      confidence_threshold: Math.min(
        0.999,
        Math.max(0.5, (parseInt(confidence, 10) || 95) / 100),
      ),
      variants: parsedVariants,
    };
  };

  const clientValidate = (input: ExperimentInput): string | null => {
    if (!input.name) return 'Name is required.';
    if (!input.hypothesis) return 'A hypothesis is required.';
    if (!input.goal_metric) return 'A primary metric is required.';
    if (!input.success_criteria) return 'Success criteria are required.';
    if (input.variants.length < 2) return 'At least 2 variants are required.';
    if (!input.variants.some((v) => v.is_control)) return 'Mark one variant as the control.';
    if (input.min_sample_size <= 0 && input.min_runtime_hours <= 0) {
      return 'Set a minimum sample size or minimum runtime.';
    }
    return null;
  };

  const save = async (launch: boolean) => {
    let input: ExperimentInput;
    try {
      input = buildInput();
    } catch (e) {
      Alert.alert('Invalid config', (e as Error).message);
      return;
    }
    const err = clientValidate(input);
    if (err) {
      Alert.alert('Missing required fields', err);
      return;
    }
    setSaving(true);
    try {
      let id: string;
      if (editing) {
        await updateExperimentFull(editing.id, input);
        id = editing.id;
      } else {
        id = await createExperiment(input);
      }
      if (launch) {
        // The DB activation trigger does the authoritative pre-launch check.
        await setStatus(id, 'running');
      }
      await props.onSaved();
    } catch (e) {
      Alert.alert('Could not save', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const metricChoices = METRICS_BY_CATEGORY[category] ?? METRICS.map((m) => m.key);

  return (
    <>
      <FormHeader title={editing ? 'Edit Test' : 'New Split Test'} onBack={props.onBack} />
      <ScrollView
        contentContainerStyle={{
          paddingBottom: props.insets.bottom + spacing.xxl,
          paddingHorizontal: spacing.lg,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Field label="Name">
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Premium Popup Artwork Test"
            placeholderTextColor={colors.textDim}
            style={styles.input}
          />
        </Field>

        <Field label="Hypothesis (required)">
          <TextInput
            value={hypothesis}
            onChangeText={setHypothesis}
            placeholder="Changing X will increase Y because…"
            placeholderTextColor={colors.textDim}
            style={[styles.input, styles.inputMultiline]}
            multiline
          />
        </Field>

        <Field label="Surface (one running test per surface)">
          <PillRow
            options={SURFACES.map((s) => ({ value: s.key, label: s.label }))}
            value={surface}
            onChange={(v) => onPickSurface(v as SurfaceKey)}
          />
          <Text style={styles.hint}>{SURFACE_BY_KEY[surface].description}</Text>
        </Field>

        <Field label="Category">
          <PillRow
            options={EXPERIMENT_CATEGORIES.map((c) => ({ value: c.key, label: c.label }))}
            value={category}
            onChange={(v) => setCategory(v as ExperimentCategory)}
          />
        </Field>

        <Field label="Primary metric (the winner is judged on this)">
          <PillRow
            options={metricChoices.map((k) => ({
              value: k,
              label: METRIC_BY_KEY[k]?.label ?? k,
            }))}
            value={goalMetric}
            onChange={setGoalMetric}
          />
        </Field>

        <Field label="Secondary metrics (tracked, not decisive)">
          <PillRow
            multi
            options={METRICS.filter((m) => m.key !== goalMetric).map((m) => ({
              value: m.key,
              label: m.label,
            }))}
            values={secondary}
            onToggle={(v) =>
              setSecondary((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]))
            }
          />
        </Field>

        <Field label="Success criteria (required)">
          <TextInput
            value={criteria}
            onChangeText={setCriteria}
            placeholder="Variant beats control by >=10% at 95% confidence."
            placeholderTextColor={colors.textDim}
            style={[styles.input, styles.inputMultiline]}
            multiline
          />
        </Field>

        <View style={styles.dualRow}>
          <Field label="Min sample size" style={{ flex: 1 }}>
            <TextInput
              value={minSample}
              onChangeText={setMinSample}
              keyboardType="number-pad"
              style={styles.input}
            />
          </Field>
          <Field label="Min runtime (hours)" style={{ flex: 1 }}>
            <TextInput
              value={minRuntime}
              onChangeText={setMinRuntime}
              keyboardType="number-pad"
              style={styles.input}
            />
          </Field>
          <Field label="Confidence %" style={{ flex: 1 }}>
            <TextInput
              value={confidence}
              onChangeText={setConfidence}
              keyboardType="number-pad"
              style={styles.input}
            />
          </Field>
        </View>

        <Field label="Audience">
          <PillRow
            options={[
              { value: 'all', label: 'All platforms' },
              { value: 'web', label: 'Web' },
              { value: 'ios', label: 'iOS' },
              { value: 'android', label: 'Android' },
            ]}
            value={audiencePlatform}
            onChange={(v) => setAudiencePlatform(v as typeof audiencePlatform)}
          />
          <View style={styles.audienceRow}>
            <Pressable
              onPress={() => setAnonOnly((a) => !a)}
              style={[styles.checkPill, anonOnly && styles.checkPillOn]}
            >
              <Text style={[styles.checkPillText, anonOnly && styles.checkPillTextOn]}>
                {anonOnly ? '✓ ' : ''}Anonymous users only
              </Text>
            </Pressable>
            <View style={{ flex: 1 }}>
              <Text style={styles.miniLabel}>Min songs heard</Text>
              <TextInput
                value={minSongs}
                onChangeText={setMinSongs}
                keyboardType="number-pad"
                style={[styles.input, styles.inputSmall]}
              />
            </View>
          </View>
        </Field>

        <Text style={styles.sectionLabel}>VARIANTS</Text>
        {variants.map((v, i) => (
          <View key={i} style={styles.variantCard}>
            <View style={styles.variantHead}>
              <TextInput
                value={v.key}
                onChangeText={(t) => updateVariant(i, { key: t })}
                style={[styles.input, styles.keyInput]}
                placeholder="A"
                placeholderTextColor={colors.textDim}
              />
              <TextInput
                value={v.name}
                onChangeText={(t) => updateVariant(i, { name: t })}
                style={[styles.input, { flex: 1 }]}
                placeholder="Variant name"
                placeholderTextColor={colors.textDim}
              />
              {variants.length > 2 && (
                <Pressable onPress={() => removeVariant(i)} hitSlop={8} style={styles.removeBtn}>
                  <Text style={styles.removeBtnText}>✕</Text>
                </Pressable>
              )}
            </View>
            <View style={styles.variantControlsRow}>
              <Pressable
                onPress={() => setControl(i)}
                style={[styles.checkPill, v.is_control && styles.checkPillOn]}
              >
                <Text style={[styles.checkPillText, v.is_control && styles.checkPillTextOn]}>
                  {v.is_control ? '✓ Control' : 'Set as control'}
                </Text>
              </Pressable>
              <View>
                <Text style={styles.miniLabel}>Traffic weight</Text>
                <TextInput
                  value={v.traffic_weight}
                  onChangeText={(t) => updateVariant(i, { traffic_weight: t })}
                  keyboardType="number-pad"
                  style={[styles.input, styles.inputSmall, { width: 70 }]}
                />
              </View>
            </View>
            <Text style={styles.miniLabel}>Variant config (JSON)</Text>
            <TextInput
              value={v.configText}
              onChangeText={(t) => updateVariant(i, { configText: t })}
              style={[styles.input, styles.codeInput]}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        ))}
        <Pressable onPress={addVariant} style={[styles.smallBtn, styles.ghostBtn, { alignSelf: 'flex-start' }]}>
          <Text style={styles.ghostBtnText}>+ Add variant</Text>
        </Pressable>

        <View style={{ height: spacing.lg }} />
        <Pressable
          onPress={() => save(false)}
          disabled={saving}
          style={[styles.primaryBtn, styles.ghostBtn]}
        >
          <Text style={styles.ghostBtnText}>{saving ? 'Saving…' : 'Save as draft'}</Text>
        </Pressable>
        <Pressable onPress={() => save(true)} disabled={saving} style={styles.primaryBtn}>
          <Text style={styles.primaryBtnText}>{saving ? 'Saving…' : 'Save & launch'}</Text>
        </Pressable>
      </ScrollView>
    </>
  );
}

// ====================================================================
// Detail view
// ====================================================================

function DetailView(props: {
  insets: { top: number; bottom: number };
  experiment: Experiment | null;
  onBack: () => void;
  onEdit: (exp: Experiment) => void;
  onChanged: () => Promise<void>;
  onApprovedWinner: () => void;
}) {
  const { experiment } = props;
  const [liveReport, setLiveReport] = useState<ExperimentReport | null>(null);
  const [reports, setReports] = useState<{ id: string; generated_at: string; body: ExperimentReport }[]>([]);
  const [approvals, setApprovals] = useState<ExperimentApproval[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingData, setLoadingData] = useState(false);

  const loadData = useCallback(async () => {
    if (!experiment) return;
    setLoadingData(true);
    try {
      const [reps, apps] = await Promise.all([
        fetchReports(experiment.id),
        fetchApprovals(experiment.id),
      ]);
      setReports(reps);
      setApprovals(apps);
      if (['running', 'paused'].includes(experiment.status)) {
        setLiveReport(await computeLiveReport(experiment));
      } else {
        setLiveReport(null);
      }
    } finally {
      setLoadingData(false);
    }
  }, [experiment]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  if (!experiment) {
    return (
      <>
        <FormHeader title="Experiment" onBack={props.onBack} />
        <View style={styles.center}>
          <Text style={styles.emptyLine}>This experiment is no longer available.</Text>
        </View>
      </>
    );
  }

  const act = async (fn: () => Promise<void>, confirm?: string) => {
    const run = async () => {
      setBusy(true);
      try {
        await fn();
        await props.onChanged();
        await loadData();
      } catch (e) {
        Alert.alert('Action failed', (e as Error).message);
      } finally {
        setBusy(false);
      }
    };
    if (confirm) {
      Alert.alert('Confirm', confirm, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Continue', onPress: () => void run() },
      ]);
    } else {
      void run();
    }
  };

  const launch = () => act(() => setStatus(experiment.id, 'running'));
  const pause = () => act(() => setStatus(experiment.id, 'paused'));
  const resume = () => act(() => setStatus(experiment.id, 'running'));
  const archive = () => act(() => setStatus(experiment.id, 'archived'), 'Archive this experiment?');
  const duplicate = () => act(async () => {
    await duplicateExperiment(experiment.id);
  });
  const endNow = () =>
    act(async () => {
      const rep = await computeLiveReport(experiment);
      if (!rep) throw new Error('Could not compute a report');
      await submitReport(experiment.id, rep);
    }, 'End this test now and generate a report for approval?');

  const latestReport = reports[0]?.body ?? null;
  const latestReportId = reports[0]?.id ?? null;

  return (
    <>
      <FormHeader title="Experiment" onBack={props.onBack} />
      <ScrollView
        contentContainerStyle={{
          paddingBottom: props.insets.bottom + spacing.xxl,
          paddingHorizontal: spacing.lg,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.detailHead}>
          <Text style={styles.detailTitle}>{experiment.name}</Text>
          <StatusBadge status={experiment.status} />
        </View>

        <Text style={styles.detailLabel}>HYPOTHESIS</Text>
        <Text style={styles.detailBody}>{experiment.hypothesis ?? '—'}</Text>

        <View style={styles.metaGrid}>
          <Meta label="Surface" value={SURFACE_BY_KEY[experiment.surface_key]?.label ?? experiment.surface_key} />
          <Meta label="Primary metric" value={METRIC_BY_KEY[experiment.goal_metric ?? '']?.label ?? '—'} />
          <Meta label="Min sample" value={String(experiment.min_sample_size)} />
          <Meta label="Min runtime" value={`${experiment.min_runtime_hours}h`} />
          <Meta label="Confidence bar" value={`${Math.round(experiment.confidence_threshold * 100)}%`} />
          <Meta label="Variants" value={String((experiment.variants ?? []).length)} />
        </View>

        <Text style={styles.detailLabel}>SUCCESS CRITERIA</Text>
        <Text style={styles.detailBody}>{experiment.success_criteria ?? '—'}</Text>

        <Text style={styles.detailLabel}>VARIANTS</Text>
        {(experiment.variants ?? []).map((v) => (
          <View key={v.id} style={styles.variantViewCard}>
            <Text style={styles.variantViewTitle}>
              {v.key} · {v.name} {v.is_control ? '· control' : ''}
              {experiment.winner_variant_id === v.id ? '  🏆 winner' : ''}
            </Text>
            <Text style={styles.codeText}>{JSON.stringify(v.config, null, 2)}</Text>
          </View>
        ))}

        {/* Live results for a running/paused test. */}
        {liveReport && (
          <>
            <Text style={styles.detailLabel}>LIVE RESULTS</Text>
            <ResultsTable report={liveReport} />
          </>
        )}

        {/* Awaiting-approval gate. */}
        {experiment.status === 'awaiting_approval' && latestReport && (
          <ApprovalPanel
            report={latestReport}
            reportId={latestReportId}
            experiment={experiment}
            busy={busy}
            onDecision={async (decision, chosen, notes) => {
              await act(async () => {
                await approveExperiment({
                  experimentId: experiment.id,
                  reportId: latestReportId,
                  decision,
                  chosenVariantId: chosen,
                  notes,
                });
                if (decision === 'approved' || decision === 'manual') {
                  props.onApprovedWinner();
                }
              });
            }}
          />
        )}

        {/* Stored reports (history). */}
        {reports.length > 0 && (
          <>
            <Text style={styles.detailLabel}>REPORTS</Text>
            {reports.map((r) => (
              <ReportView key={r.id} report={r.body} />
            ))}
          </>
        )}

        {/* Approval history. */}
        {approvals.length > 0 && (
          <>
            <Text style={styles.detailLabel}>DECISION HISTORY</Text>
            {approvals.map((a) => (
              <Text key={a.id} style={styles.historyLine}>
                {new Date(a.decided_at).toLocaleString()} — {a.decision}
                {a.notes ? ` · ${a.notes}` : ''}
              </Text>
            ))}
          </>
        )}

        {loadingData && <ActivityIndicator color={colors.textMuted} style={{ marginTop: spacing.md }} />}

        {/* Action bar. */}
        <View style={styles.actionBar}>
          {experiment.status === 'draft' && (
            <>
              <ActionBtn label="Launch test" primary onPress={launch} disabled={busy} />
              <ActionBtn label="Edit" onPress={() => props.onEdit(experiment)} disabled={busy} />
            </>
          )}
          {experiment.status === 'running' && (
            <>
              <ActionBtn label="Pause" onPress={pause} disabled={busy} />
              <ActionBtn label="End test now" primary onPress={endNow} disabled={busy} />
            </>
          )}
          {experiment.status === 'paused' && (
            <>
              <ActionBtn label="Resume" primary onPress={resume} disabled={busy} />
              <ActionBtn label="End test now" onPress={endNow} disabled={busy} />
            </>
          )}
          <ActionBtn label="Duplicate" onPress={duplicate} disabled={busy} />
          {experiment.status !== 'archived' && (
            <ActionBtn label="Archive" onPress={archive} disabled={busy} />
          )}
        </View>
      </ScrollView>
    </>
  );
}

function ApprovalPanel(props: {
  report: ExperimentReport;
  reportId: string | null;
  experiment: Experiment;
  busy: boolean;
  onDecision: (
    decision: 'approved' | 'rejected' | 'continued' | 'manual',
    chosenVariantId: string | null,
    notes: string,
  ) => Promise<void>;
}) {
  const { report, experiment } = props;
  const [notes, setNotes] = useState('');
  const [manualPick, setManualPick] = useState<string | null>(null);

  return (
    <View style={styles.approvalPanel}>
      <Text style={styles.approvalTitle}>HUMAN APPROVAL REQUIRED</Text>
      <ReportView report={report} />

      <Text style={styles.miniLabel}>Decision notes (optional)</Text>
      <TextInput
        value={notes}
        onChangeText={setNotes}
        placeholder="Why you approved / rejected…"
        placeholderTextColor={colors.textDim}
        style={[styles.input, styles.inputMultiline]}
        multiline
      />

      <Text style={styles.miniLabel}>Or manually choose a variant to ship</Text>
      <PillRow
        options={(experiment.variants ?? []).map((v) => ({
          value: v.id,
          label: `${v.key} · ${v.name}`,
        }))}
        value={manualPick ?? ''}
        onChange={(v) => setManualPick(v)}
      />

      <View style={styles.approvalActions}>
        <Pressable
          onPress={() => props.onDecision('approved', null, notes)}
          disabled={props.busy || !report.winner}
          style={[styles.actionBtn, styles.approveBtn, (!report.winner || props.busy) && styles.disabledBtn]}
        >
          <CheckIcon size={15} color={colors.bg} />
          <Text style={styles.approveBtnText}>
            {report.winner ? `Approve winner (${report.winner.key})` : 'No clear winner'}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => props.onDecision('rejected', null, notes)}
          disabled={props.busy}
          style={[styles.actionBtn, styles.rejectBtn]}
        >
          <Text style={styles.rejectBtnText}>Reject result</Text>
        </Pressable>
      </View>
      <View style={styles.approvalActions}>
        <Pressable
          onPress={() => props.onDecision('continued', null, notes)}
          disabled={props.busy}
          style={[styles.actionBtn, styles.ghostBtn]}
        >
          <Text style={styles.ghostBtnText}>Continue test</Text>
        </Pressable>
        <Pressable
          onPress={() => manualPick && props.onDecision('manual', manualPick, notes)}
          disabled={props.busy || !manualPick}
          style={[styles.actionBtn, styles.goldBtn, !manualPick && styles.disabledBtn]}
        >
          <Text style={styles.goldBtnText}>Ship chosen variant</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---- Results table + report rendering -------------------------------

function ResultsTable({ report }: { report: ExperimentReport }) {
  return (
    <View style={styles.resultsCard}>
      <View style={styles.resultsHeadRow}>
        <Text style={[styles.resCol, styles.resColName]}>Variant</Text>
        <Text style={[styles.resCol, styles.resColNum]}>Subjects</Text>
        <Text style={[styles.resCol, styles.resColNum]}>{report.primary_metric.unit === '%' ? 'Rate' : 'Value'}</Text>
        <Text style={[styles.resCol, styles.resColNum]}>Lift</Text>
      </View>
      {report.variants.map((v) => {
        const isWinner = report.winner?.variant_id === v.variant_id;
        return (
          <View key={v.variant_id} style={styles.resultsRow}>
            <Text style={[styles.resCol, styles.resColName, isWinner && styles.winnerText]} numberOfLines={1}>
              {v.key} · {v.name}
              {v.is_control ? ' (control)' : ''}
            </Text>
            <Text style={[styles.resCol, styles.resColNum]}>{v.subjects}</Text>
            <Text style={[styles.resCol, styles.resColNum, isWinner && styles.winnerText]}>
              {v.primaryDisplay}
            </Text>
            <Text style={[styles.resCol, styles.resColNum]}>
              {v.liftVsControl == null
                ? '—'
                : `${v.liftVsControl >= 0 ? '+' : ''}${(v.liftVsControl * 100).toFixed(1)}%`}
            </Text>
          </View>
        );
      })}
      <Text style={styles.resultsFoot}>
        Sample {report.sample_size} · confidence {(report.confidence * 100).toFixed(1)}% ·{' '}
        {report.duration_hours.toFixed(0)}h elapsed
      </Text>
    </View>
  );
}

function ReportView({ report }: { report: ExperimentReport }) {
  return (
    <View style={styles.reportCard}>
      <Text style={styles.reportTitle}>{report.experiment_name}</Text>
      <Text style={styles.reportMeta}>
        Generated {new Date(report.generated_at).toLocaleString()}
      </Text>

      <ReportLine label="Primary metric" value={report.primary_metric.label} />
      <ResultsTable report={report} />

      {report.secondary_metrics.length > 0 && (
        <>
          <Text style={styles.reportSub}>Secondary metrics</Text>
          {report.variants.map((v) => (
            <Text key={v.variant_id} style={styles.reportSecondaryLine}>
              {v.key}:{' '}
              {report.secondary_metrics
                .map((m) => `${METRIC_BY_KEY[m]?.label ?? m} ${v.secondary[m]?.display ?? '—'}`)
                .join('  ·  ')}
            </Text>
          ))}
        </>
      )}

      <ReportLine
        label="Winner"
        value={report.winner ? `${report.winner.key} · ${report.winner.name}` : 'No clear winner'}
        highlight={Boolean(report.winner)}
      />
      <ReportLine label="Confidence" value={`${(report.confidence * 100).toFixed(1)}%`} />
      <ReportLine label="Sample size" value={String(report.sample_size)} />
      <ReportLine label="Duration" value={`${report.duration_hours.toFixed(0)} hours`} />
      {report.revenue_impact && <ReportLine label="Revenue impact" value={report.revenue_impact} />}
      {report.retention_impact && (
        <ReportLine label="Retention impact" value={report.retention_impact} />
      )}

      <Text style={styles.reportSub}>Recommendation</Text>
      <Text style={styles.reportBody}>{report.recommendation}</Text>
      <Text style={styles.reportSub}>Risks / caveats</Text>
      <Text style={styles.reportBody}>{report.risks}</Text>
      <Text style={styles.reportSub}>Implementation notes</Text>
      <Text style={styles.reportBody}>{report.implementation_notes}</Text>
    </View>
  );
}

function ReportLine({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <View style={styles.reportLine}>
      <Text style={styles.reportLineLabel}>{label}</Text>
      <Text style={[styles.reportLineValue, highlight && styles.winnerText]}>{value}</Text>
    </View>
  );
}

// ---- Shared small components ----------------------------------------

function FormHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={styles.formHeader}>
      <Pressable onPress={onBack} hitSlop={10} style={styles.backBtn}>
        <ChevronLeftIcon size={22} color={colors.text} />
      </Pressable>
      <Text style={styles.formHeaderTitle}>{title}</Text>
      <View style={{ width: 36 }} />
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: spacing.lg }}>
      <Text style={styles.sectionLabel}>{title}</Text>
      {children}
    </View>
  );
}

function Field({
  label,
  children,
  style,
}: {
  label: string;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ marginTop: spacing.md }, style]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaCell}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function ActionBtn({
  label,
  onPress,
  primary,
  disabled,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.detailActionBtn,
        primary ? styles.detailActionPrimary : styles.detailActionGhost,
        disabled && styles.disabledBtn,
      ]}
    >
      <Text style={primary ? styles.detailActionPrimaryText : styles.detailActionGhostText}>
        {label}
      </Text>
    </Pressable>
  );
}

interface PillOption {
  value: string;
  label: string;
}

function PillRow(props: {
  options: PillOption[];
  value?: string;
  onChange?: (v: string) => void;
  multi?: boolean;
  values?: string[];
  onToggle?: (v: string) => void;
}) {
  return (
    <View style={styles.pillWrap}>
      {props.options.map((o) => {
        const selected = props.multi
          ? (props.values ?? []).includes(o.value)
          : props.value === o.value;
        return (
          <Pressable
            key={o.value}
            onPress={() => (props.multi ? props.onToggle?.(o.value) : props.onChange?.(o.value))}
            style={[styles.pill, selected && styles.pillOn]}
          >
            <Text style={[styles.pillText, selected && styles.pillTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
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

  formHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  formHeaderTitle: { color: colors.text, fontSize: fonts.size.lg, fontWeight: fonts.weight.bold },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: colors.surface,
  },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  emptyLine: { color: colors.textMuted, fontSize: fonts.size.sm },

  primaryBtn: {
    backgroundColor: metals.goldSolid,
    borderRadius: radii.pill,
    paddingVertical: 14,
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
  },
  primaryBtnText: { color: colors.bg, fontWeight: fonts.weight.bold, fontSize: fonts.size.md },

  noteBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: 'rgba(200,174,122,0.10)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
  },
  noteText: { color: metals.goldSolidHi, fontSize: fonts.size.sm, flex: 1 },

  sectionLabel: {
    color: colors.textMuted,
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: fonts.weight.semibold,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.lg,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  rowTitle: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.semibold },
  rowSub: { color: colors.textMuted, fontSize: fonts.size.xs, marginTop: 2 },

  badge: {
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: { fontSize: 10, fontWeight: fonts.weight.bold, letterSpacing: 0.5 },

  suggestionCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
  },
  suggestionTitle: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.bold },
  suggestionMeta: { color: metals.goldSolidHi, fontSize: fonts.size.xs, marginTop: 3 },
  suggestionBody: { color: colors.textMuted, fontSize: fonts.size.sm, marginTop: 6, lineHeight: 18 },
  suggestionRationale: {
    color: colors.textDim,
    fontSize: fonts.size.xs,
    marginTop: 6,
    fontStyle: 'italic',
    lineHeight: 16,
  },
  suggestionActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },

  smallBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    borderRadius: radii.pill,
    alignItems: 'center',
  },
  ghostBtn: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  ghostBtnText: { color: colors.text, fontWeight: fonts.weight.semibold, fontSize: fonts.size.sm },
  goldBtn: { backgroundColor: metals.goldSolid },
  goldBtnText: { color: colors.bg, fontWeight: fonts.weight.bold, fontSize: fonts.size.sm },

  // form
  fieldLabel: {
    color: colors.textMuted,
    fontSize: fonts.size.xs,
    fontWeight: fonts.weight.semibold,
    marginBottom: 6,
    letterSpacing: 0.3,
  },
  miniLabel: { color: colors.textDim, fontSize: 10, letterSpacing: 0.5, marginBottom: 4, marginTop: 6 },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: fonts.size.sm,
  },
  inputMultiline: { minHeight: 70, textAlignVertical: 'top' },
  inputSmall: { paddingVertical: 7 },
  codeInput: {
    minHeight: 120,
    textAlignVertical: 'top',
    fontFamily: 'Courier',
    fontSize: 12,
  },
  hint: { color: colors.textDim, fontSize: fonts.size.xs, marginTop: 5, lineHeight: 16 },
  dualRow: { flexDirection: 'row', gap: spacing.sm },
  audienceRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-end', marginTop: spacing.sm },

  pillWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  pillOn: { backgroundColor: metals.goldSolid, borderColor: metals.goldSolid },
  pillText: { color: colors.textMuted, fontSize: fonts.size.xs, fontWeight: fonts.weight.medium },
  pillTextOn: { color: colors.bg, fontWeight: fonts.weight.bold },

  checkPill: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  checkPillOn: { borderColor: colors.success },
  checkPillText: { color: colors.textMuted, fontSize: fonts.size.xs, fontWeight: fonts.weight.semibold },
  checkPillTextOn: { color: colors.success },

  variantCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  variantHead: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  keyInput: { width: 56, textAlign: 'center' },
  variantControlsRow: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'flex-end',
    marginTop: spacing.sm,
  },
  removeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(239,68,68,0.12)',
  },
  removeBtnText: { color: '#ef6868', fontWeight: fonts.weight.bold },

  // detail
  detailHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.sm,
    gap: spacing.md,
  },
  detailTitle: {
    color: colors.text,
    fontSize: fonts.size.xl,
    fontWeight: fonts.weight.bold,
    flex: 1,
  },
  detailLabel: {
    color: colors.textMuted,
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: fonts.weight.semibold,
    marginTop: spacing.lg,
    marginBottom: spacing.xs,
  },
  detailBody: { color: colors.text, fontSize: fonts.size.sm, lineHeight: 20 },
  metaGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: spacing.md },
  metaCell: { width: '33%', marginBottom: spacing.md, paddingRight: spacing.sm },
  metaLabel: { color: colors.textDim, fontSize: 10, letterSpacing: 0.5 },
  metaValue: { color: colors.text, fontSize: fonts.size.sm, fontWeight: fonts.weight.semibold, marginTop: 2 },

  variantViewCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  variantViewTitle: { color: colors.text, fontSize: fonts.size.sm, fontWeight: fonts.weight.bold },
  codeText: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: 'Courier',
    marginTop: 6,
  },

  resultsCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
    marginTop: spacing.xs,
  },
  resultsHeadRow: {
    flexDirection: 'row',
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: metals.platinum,
  },
  resultsRow: {
    flexDirection: 'row',
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  resCol: { color: colors.text, fontSize: fonts.size.xs },
  resColName: { flex: 1, color: colors.textMuted },
  resColNum: { width: 64, textAlign: 'right', fontVariant: ['tabular-nums'] },
  resultsFoot: { color: colors.textDim, fontSize: 10, marginTop: 8 },
  winnerText: { color: metals.goldSolidHi, fontWeight: fonts.weight.bold },

  reportCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.md,
    padding: spacing.md,
    marginTop: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.gold,
  },
  reportTitle: { color: colors.text, fontSize: fonts.size.md, fontWeight: fonts.weight.bold },
  reportMeta: { color: colors.textDim, fontSize: 10, marginTop: 2, marginBottom: spacing.sm },
  reportSub: {
    color: metals.goldSolidHi,
    fontSize: fonts.size.xs,
    fontWeight: fonts.weight.bold,
    marginTop: spacing.md,
    letterSpacing: 0.5,
  },
  reportBody: { color: colors.text, fontSize: fonts.size.sm, lineHeight: 19, marginTop: 4 },
  reportSecondaryLine: { color: colors.textMuted, fontSize: fonts.size.xs, marginTop: 3 },
  reportLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
    gap: spacing.md,
  },
  reportLineLabel: { color: colors.textMuted, fontSize: fonts.size.xs },
  reportLineValue: {
    color: colors.text,
    fontSize: fonts.size.xs,
    fontWeight: fonts.weight.semibold,
    flex: 1,
    textAlign: 'right',
  },

  approvalPanel: {
    backgroundColor: 'rgba(224,179,65,0.07)',
    borderRadius: radii.md,
    padding: spacing.md,
    marginTop: spacing.lg,
    borderWidth: 1,
    borderColor: '#e0b341',
  },
  approvalTitle: {
    color: '#e0b341',
    fontSize: fonts.size.xs,
    fontWeight: fonts.weight.bold,
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  approvalActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },

  actionBar: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xl },
  detailActionBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 11,
    borderRadius: radii.pill,
    alignItems: 'center',
    flexGrow: 1,
  },
  detailActionPrimary: { backgroundColor: metals.goldSolid },
  detailActionPrimaryText: { color: colors.bg, fontWeight: fonts.weight.bold, fontSize: fonts.size.sm },
  detailActionGhost: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: metals.platinum,
  },
  detailActionGhostText: { color: colors.text, fontWeight: fonts.weight.semibold, fontSize: fonts.size.sm },

  actionBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  approveBtn: { backgroundColor: colors.success },
  approveBtnText: { color: colors.bg, fontWeight: fonts.weight.bold, fontSize: fonts.size.sm },
  rejectBtn: {
    backgroundColor: 'rgba(239,68,68,0.10)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(239,68,68,0.45)',
  },
  rejectBtnText: { color: '#ef6868', fontWeight: fonts.weight.bold, fontSize: fonts.size.sm },
  disabledBtn: { opacity: 0.4 },

  historyLine: { color: colors.textMuted, fontSize: fonts.size.xs, marginTop: 4 },
});
