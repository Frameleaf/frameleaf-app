<script lang="ts">
  /**
   * Computers & background work → Graphics card check (FL-364; before it Hardware & GPU, FL-159),
   * after the approved prototype (`settings-v2/computers/Hardware.jsx`). The answer is the first
   * line: no graphics card, working, not being used, or AI features not running. Then what this
   * server can do on its own, as outcomes. The fact grids, the model names and the set-up fixes are
   * kept, closed until someone needs them.
   *
   * Detection runs inside each container (server probe, ML `/hardware` probe); nothing here is a
   * sample. AI features that do not answer count as needing attention, and nothing is promised
   * about what they can run until they do.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Coverage, { type CoverageRow } from '$lib/components/frameleaf/settings/kit/Coverage.svelte';
  import Facts, { type Fact } from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Pill, { type KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { hardwareConsequences, workerFromHardware } from '$lib/frameleaf/cloud-ml';
  import { applyDescriptionHardwarePreset } from '$lib/frameleaf/enrichment-tasks';
  import {
    composeFixes,
    fixStepKey,
    fixYaml,
    gpuProblems,
    problemById,
    problemExplainKey,
    type ComposeFixId,
    type FixValues,
  } from '$lib/frameleaf/gpu-model-catalog';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import {
    cloudOnlyChoices,
    isAiWork,
    isLightWork,
    runsHere,
    WORK_KINDS,
    workKindNameKey,
    type HereAnswer,
  } from '$lib/frameleaf/work-places';
  import { locale } from '$lib/stores/preferences.store';
  import { copyToClipboard } from '$lib/utils';
  import {
    getHardwareCheck,
    getMachineLearningHardware,
    getRenderWorkerCompatibility,
    MachineLearningHardwareAcceleration,
    runHardwareBenchmark,
    runHardwareCheck,
    type HardwareCheckResponseDto,
    type HardwareContainerCheckDto,
    type HardwareWorkloadBenchmarkDto,
    type RenderWorkerCompatibilityResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiChip,
    mdiContentCopy,
    mdiCreation,
    mdiDesktopTowerMonitor,
    mdiExpansionCard,
    mdiMovieOpenOutline,
    mdiPlus,
    mdiRefresh,
    mdiSpeedometer,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  let check = $state<HardwareCheckResponseDto | null>(null);
  let compatibility = $state<RenderWorkerCompatibilityResponseDto | null>();
  let loadError = $state(false);
  let busy = $state<'check' | 'benchmark' | 'recommend' | null>(null);
  let said = $state('');
  const draft = getSystemConfigDraft();

  /** What Studio can run now. Unreadable is not "no": the Studio row then says it can't tell. */
  const readCompatibility = async () => {
    try {
      return (await getRenderWorkerCompatibility()) ?? null;
    } catch {
      return null;
    }
  };
  const load = async () => {
    loadError = false;
    try {
      [check, compatibility] = await Promise.all([getHardwareCheck(), readCompatibility()]);
    } catch {
      loadError = true;
    }
  };
  onMount(() => void load());

  const worker = $derived(workerFromHardware(check));
  const found = $derived((check?.issues ?? []).map((id) => problemById(id)).filter((problem) => !!problem));
  /** Set-up problems to fix; a limit of the card (`note`) is shown as a note instead. */
  const issues = $derived(found.filter((problem) => !problem.note));
  const notes = $derived(found.filter((problem) => problem.note));
  /** One fix per snippet: the values the check found (a group number, a PCI path) make it copy-ready. */
  const fixes = $derived.by(() => {
    const entries = new Map<string, { id: ComposeFixId; values: FixValues; symptoms: string[] }>();
    for (const problem of issues) {
      if (!problem.fix) {
        continue;
      }
      const values = check?.findings?.find((finding) => finding.id === problem.id) ?? {};
      const key = `${problem.fix}:${fixYaml(problem.fix, values) ?? ''}`;
      const entry = entries.get(key) ?? { id: problem.fix, values, symptoms: [] as string[] };
      entry.symptoms.push(problem.symptom);
      entries.set(key, entry);
    }
    return [...entries.values()];
  });

  /** AI features do not answer: this counts as needing attention, and nothing about them is claimed. */
  const aiDown = $derived(!!check && !check.ml.reachable);
  type Kind = 'ai-down' | 'setup' | 'working' | 'none';
  const kind = $derived<Kind>(
    aiDown ? 'ai-down' : issues.length > 0 ? 'setup' : worker.gpu || worker.serverGpu ? 'working' : 'none',
  );

  const when = (value: string) =>
    new Date(value).toLocaleString($locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const number = (value: number) => value.toLocaleString($locale, { maximumFractionDigits: 1 });

  const hero = $derived.by(() => {
    if (!check) {
      return;
    }
    const checked = when(check.checkedAt);
    switch (kind) {
      case 'ai-down': {
        return {
          tone: 'warn' as const,
          icon: mdiAlertCircleOutline,
          title: $t('frameleaf_gpucheck_ai_down'),
          body: $t('frameleaf_gpucheck_ai_down_body', {
            values: { video: check.server.reachable && check.server.test?.ok ? 'yes' : 'no', when: checked },
          }),
        };
      }
      case 'setup': {
        return {
          tone: 'warn' as const,
          icon: mdiAlertCircleOutline,
          title: $t('frameleaf_gpucheck_setup'),
          body: $t('frameleaf_gpucheck_setup_body', { values: { when: checked } }),
        };
      }
      case 'working': {
        return {
          tone: 'good' as const,
          icon: mdiExpansionCard,
          title: $t('frameleaf_gpucheck_working'),
          body: $t('frameleaf_gpucheck_working_body', {
            values: {
              card: (worker.gpu ?? worker.serverGpu)?.name ?? '',
              what: worker.gpu && worker.serverGpu ? 'both' : worker.serverGpu ? 'video' : 'ai',
              when: checked,
            },
          }),
        };
      }
      default: {
        return {
          tone: 'good' as const,
          icon: mdiChip,
          title: $t('frameleaf_gpucheck_none'),
          body: $t('frameleaf_gpucheck_none_body', { values: { when: checked } }),
        };
      }
    }
  });

  /** A container's own problems, so one side can be fine while the other is not reached. */
  const hasIssue = (container: 'server' | 'ml') =>
    (check?.findings ?? []).some((finding) => finding.container === container && !problemById(finding.id)?.note);
  const descriptionsPerHour = $derived(
    check?.benchmark?.workloads?.find((row) => row.workload === 'descriptions' && row.perHour !== null)?.perHour,
  );
  const coverage = $derived.by((): CoverageRow[] => {
    if (!check) {
      return [];
    }
    const speed = check.benchmark?.transcodeSpeed ?? check.server.test?.value ?? null;
    const video: CoverageRow = {
      icon: mdiMovieOpenOutline,
      name: $t('frameleaf_gpucheck_video'),
      detail: $t('frameleaf_gpucheck_video_detail'),
      ...(check.server.reachable
        ? hasIssue('server')
          ? {
              tone: 'warn',
              value: $t('frameleaf_gpucheck_on_processor_for_now'),
              note: $t('frameleaf_gpucheck_not_reached'),
            }
          : {
              tone: worker.serverGpu ? 'good' : 'off',
              value: worker.serverGpu ? $t('frameleaf_gpucheck_on_card') : $t('frameleaf_gpucheck_on_processor'),
              note:
                speed === null
                  ? $t('frameleaf_gpucheck_not_measured')
                  : $t('frameleaf_gpucheck_video_speed', { values: { speed: number(speed) } }),
            }
        : {
            tone: 'warn',
            value: $t('frameleaf_gpucheck_not_answering'),
            note: $t('frameleaf_gpucheck_nothing_checked'),
          }),
    };
    const ai: CoverageRow = {
      icon: mdiCreation,
      name: $t('frameleaf_gpucheck_ai'),
      detail: $t('frameleaf_gpucheck_ai_detail'),
      ...(aiDown
        ? {
            tone: 'warn',
            value: $t('frameleaf_gpucheck_not_answering'),
            note: $t('frameleaf_gpucheck_nothing_checked'),
          }
        : hasIssue('ml')
          ? {
              tone: 'warn',
              value: $t('frameleaf_gpucheck_on_processor_for_now'),
              note: $t('frameleaf_gpucheck_not_reached'),
            }
          : {
              tone: worker.gpu ? 'good' : 'off',
              value: worker.gpu ? $t('frameleaf_gpucheck_on_card') : $t('frameleaf_gpucheck_on_processor'),
              note:
                descriptionsPerHour === undefined || descriptionsPerHour === null
                  ? $t('frameleaf_gpucheck_not_measured')
                  : $t('frameleaf_gpucheck_ai_speed', { values: { count: Math.round(descriptionsPerHour) } }),
            }),
    };
    return [video, ai];
  });

  const run = async (action: 'check' | 'benchmark') => {
    busy = action;
    said = '';
    const before = kind;
    try {
      check = action === 'check' ? await runHardwareCheck() : await runHardwareBenchmark();
      compatibility = (await readCompatibility()) ?? compatibility;
      said =
        action === 'benchmark'
          ? $t('frameleaf_gpucheck_said_measured')
          : kind === 'ai-down' && before === 'ai-down'
            ? $t('frameleaf_gpucheck_said_ai_same')
            : kind === 'setup' && before === 'setup'
              ? $t('frameleaf_gpucheck_said_same')
              : $t('frameleaf_gpucheck_said_done');
    } catch {
      said = $t('frameleaf_gpucheck_run_failed');
    } finally {
      busy = null;
    }
  };

  // ---- what this server can do ---------------------------------------------------------------------

  const ANSWER_KEYS: Record<HereAnswer, Translations> = {
    works: 'frameleaf_gpucheck_works',
    slow: 'frameleaf_gpucheck_slow',
    no: 'frameleaf_gpucheck_no',
    unknown: 'frameleaf_gpucheck_unknown',
  };
  const ANSWER_TONES: Record<HereAnswer, KitTone> = { works: 'good', slow: 'good', no: 'warn', unknown: 'off' };
  const can = $derived(
    WORK_KINDS.map((work) => {
      const answer = runsHere(work, { check, compatibility });
      const measured = check?.benchmark?.workloads?.find((row) => row.workload === work && row.perHour !== null);
      const parts: string[] = [];
      if (answer === 'unknown') {
        parts.push(
          isAiWork(work) && aiDown ? $t('frameleaf_gpucheck_help_unknown_ai') : $t('frameleaf_gpucheck_help_unknown'),
        );
      } else if (work === 'render') {
        parts.push($t(answer === 'works' ? 'frameleaf_gpucheck_help_export_yes' : 'frameleaf_gpucheck_help_export_no'));
      } else if (answer === 'no') {
        parts.push($t('frameleaf_gpucheck_help_needs_card'));
      } else {
        if (measured?.perHour) {
          parts.push(
            $t(
              measured.unit === 'frame'
                ? 'frameleaf_gpucheck_help_per_hour_frame'
                : 'frameleaf_gpucheck_help_per_hour_photo',
              { values: { count: Math.round(measured.perHour) } },
            ),
          );
        } else if (isLightWork(work) && !worker.gpu) {
          parts.push($t('frameleaf_gpucheck_help_quick'));
        } else {
          parts.push($t(answer === 'works' ? 'frameleaf_gpucheck_help_card' : 'frameleaf_gpucheck_help_processor'));
        }
        if (answer === 'slow' && hasIssue('ml')) {
          parts.push($t('frameleaf_gpucheck_help_after_fix'));
        }
        if (cloudOnlyChoices(work, check) > 0) {
          parts.push($t('frameleaf_gpucheck_help_better_cloud'));
        }
      }
      return { work, answer, help: parts.join(' ') };
    }),
  );
  const needsHelp = $derived(can.some(({ answer }) => answer === 'no'));

  // ---- tune and measure ----------------------------------------------------------------------------

  /**
   * "Use the recommended settings": the description settings that suit what the AI service reports
   * it can use. They go into the settings draft, so every change is reviewed before it is saved.
   */
  const recommend = async () => {
    if (!draft) {
      return;
    }
    busy = 'recommend';
    said = '';
    try {
      const { preferredAcceleration } = await getMachineLearningHardware({});
      const added = applyDescriptionHardwarePreset(
        draft.draft.machineLearning,
        MachineLearningHardwareAcceleration.Auto,
        preferredAcceleration,
      );
      said = $t(added ? 'frameleaf_gpucheck_recommended_added' : 'frameleaf_gpucheck_recommended_unavailable');
    } catch {
      said = $t('frameleaf_gpucheck_recommended_unavailable');
    } finally {
      busy = null;
    }
  };

  // ---- set-up help ---------------------------------------------------------------------------------

  const BACKEND_KEY: Record<string, Translations> = {
    CUDA: 'frameleaf_hardware_backend_cuda',
    ROCm: 'frameleaf_hardware_backend_rocm',
    OpenVINO: 'frameleaf_hardware_backend_openvino',
    NVENC: 'frameleaf_hardware_backend_nvenc',
    'VA-API': 'frameleaf_hardware_backend_vaapi',
    QSV: 'frameleaf_hardware_backend_qsv',
    CPU: 'frameleaf_hardware_backend_cpu',
  };
  const yesNo = (value: boolean | null | undefined) =>
    value === true
      ? $t('frameleaf_hardware_fact_yes')
      : value === false
        ? $t('frameleaf_hardware_fact_no')
        : $t('frameleaf_hardware_fact_unknown');
  const testText = (result: HardwareContainerCheckDto) => {
    const test = result.test;
    if (!result.reachable) {
      return $t('frameleaf_hardware_test_unreachable');
    }
    if (!test) {
      return $t('frameleaf_hardware_test_none');
    }
    const where = test.gpu ? $t(BACKEND_KEY[result.backend]) : $t('frameleaf_hardware_test_processor');
    if (test.kind === 'transcode') {
      if (test.value === null) {
        return $t('frameleaf_hardware_test_transcode_failed', { values: { error: test.error ?? '' } });
      }
      return test.error
        ? $t('frameleaf_hardware_test_transcode_fallback', { values: { error: test.error, speed: test.value } })
        : $t('frameleaf_hardware_test_transcode', { values: { where, speed: test.value } });
    }
    return test.value === null
      ? $t('frameleaf_hardware_test_embedding_failed', { values: { error: test.error ?? '' } })
      : $t('frameleaf_hardware_test_embedding', { values: { where, ms: test.value } });
  };
  const grid = (result: HardwareContainerCheckDto): Fact[] => [
    { label: $t('frameleaf_gpucheck_fact_maker'), value: result.vendor ?? $t('frameleaf_gpucheck_fact_none') },
    { label: $t('frameleaf_gpucheck_fact_model'), value: result.model ?? '—' },
    {
      label: $t('frameleaf_gpucheck_fact_memory'),
      value: result.vramGb ? $t('frameleaf_hardware_memory_value', { values: { gb: result.vramGb } }) : '—',
      detail: $t('frameleaf_gpucheck_fact_memory_detail'),
    },
    { label: $t('frameleaf_gpucheck_fact_driver'), value: result.driver ?? '—' },
    {
      label: $t('frameleaf_gpucheck_fact_through'),
      value: $t(BACKEND_KEY[result.backend]),
      detail: $t('frameleaf_gpucheck_fact_through_detail'),
    },
    { label: $t('frameleaf_gpucheck_fact_present'), value: yesNo(result.gpu?.present) },
    {
      label: $t('frameleaf_gpucheck_fact_visible'),
      value: yesNo(result.gpu?.visible),
      detail: $t('frameleaf_gpucheck_fact_visible_detail'),
    },
    { label: $t('frameleaf_gpucheck_fact_usable'), value: yesNo(result.gpu?.usable) },
    { label: $t('frameleaf_gpucheck_fact_test'), value: testText(result) },
  ];
  /** The model each kind of work can run here: an answer for whoever looks after the server. */
  const models = $derived(
    aiDown
      ? []
      : hardwareConsequences(worker, null)
          .filter((row) => row.heaviest)
          .map((row) => ({
            label: $t(workKindNameKey(row.workload)),
            value: row.heaviest!.item.name,
          })),
  );
  const measured = $derived.by((): Fact[] => {
    const benchmark = check?.benchmark;
    if (!benchmark) {
      return [];
    }
    return [
      ...(benchmark.embeddingMs === null
        ? []
        : [
            {
              label: $t('frameleaf_hardware_benchmark_embedding'),
              value: $t('frameleaf_hardware_benchmark_ms', { values: { ms: benchmark.embeddingMs } }),
            },
          ]),
      ...(benchmark.transcodeSpeed === null
        ? []
        : [
            {
              label: $t('frameleaf_hardware_benchmark_transcode'),
              value: $t('frameleaf_hardware_benchmark_speed', { values: { speed: benchmark.transcodeSpeed } }),
            },
          ]),
      // Each kind of work as it was measured, or why there is no figure for it.
      ...(benchmark.workloads ?? []).map((row) => ({
        label: $t(workKindNameKey(row.workload)),
        value: throughputText(row),
      })),
    ];
  });
  const throughputText = (row: HardwareWorkloadBenchmarkDto) => {
    if (row.unavailable) {
      if (row.unavailable === 'failed') {
        return row.error
          ? $t('frameleaf_hardware_throughput_failed', { values: { error: row.error } })
          : $t('frameleaf_hardware_throughput_failed_unknown');
      }
      return $t(`frameleaf_hardware_throughput_${row.unavailable.replaceAll('-', '_')}` as Translations);
    }
    const where =
      row.runsOn === 'cpu'
        ? $t('frameleaf_hardware_throughput_where_cpu')
        : $t('frameleaf_hardware_throughput_where_gpu');
    const amount =
      row.unit === 'photo'
        ? $t('frameleaf_hardware_throughput_photo', {
            values: { perHour: row.perHour ?? 0, seconds: row.secondsPerUnit ?? 0, where },
          })
        : $t('frameleaf_hardware_throughput_frame', { values: { perHour: row.perHour ?? 0, where } });
    const source = $t(
      row.source === 'qualification'
        ? 'frameleaf_hardware_throughput_source_qualification'
        : 'frameleaf_hardware_throughput_source_benchmark',
      { values: { worker: row.worker ?? '' } },
    );
    return `${amount}. ${source}`;
  };

  let copied = $state('');
  const copy = async (key: string, text: string) => {
    await copyToClipboard(text);
    copied = key;
  };
  /** First sentence as the heading, the rest as the explanation. */
  const splitFirst = (text: string) => {
    const index = text.indexOf('. ');
    return index === -1 ? [text.replace(/\.$/, ''), ''] : [text.slice(0, index), text.slice(index + 2)];
  };
</script>

{#snippet fix(fixId: ComposeFixId, values: FixValues = {})}
  {@const entry = composeFixes[fixId]}
  {@const yaml = fixYaml(fixId, values)}
  <ol class="steps">
    {#each Array.from({ length: entry.steps }, (_, index) => index + 1) as step (step)}
      <li>{$t(fixStepKey(fixId, step) as Translations)}</li>
    {/each}
  </ol>
  {#if yaml}
    <div class="code">
      <pre aria-label={$t('frameleaf_gpucheck_fix_lines')}><code>{yaml}</code></pre>
      <Button
        label={$t('frameleaf_gpucheck_copy_fix', { values: { maker: entry.title } })}
        onclick={() => void copy(fixId, yaml)}
      >
        <Icon icon={mdiContentCopy} size="16" aria-hidden />
        {$t('frameleaf_gpucheck_copy')}
      </Button>
    </div>
  {/if}
{/snippet}

<KitPage>
  {#if loadError && !check}
    <InlineError message={$t('frameleaf_gpucheck_load_failed')} onRetry={load} />
  {:else if !check || !hero}
    <div class="loading" role="status" aria-busy="true">
      <span class="sr-only">{$t('frameleaf_gpucheck_loading')}</span>
      <Skeleton variant="block" height="168px" />
      <Skeleton variant="block" height="240px" />
    </div>
  {:else}
    <p class="said" role="status" class:is-empty={!said && !busy && !copied}>
      {#if busy === 'check'}
        {$t('frameleaf_gpucheck_checking')}
      {:else if busy === 'benchmark'}
        {$t('frameleaf_gpucheck_measuring')}
      {:else if said}
        {said}
      {:else if copied}
        {$t('frameleaf_gpucheck_copied')}
      {/if}
    </p>

    <Hero
      tone={hero.tone}
      icon={hero.icon}
      title={hero.title}
      body={hero.body}
      label={$t('frameleaf_gpucheck_status_label')}
    >
      {#snippet actions()}
        <Button
          variant={kind === 'ai-down' || kind === 'setup' ? 'primary' : 'default'}
          disabled={!!busy}
          onclick={() => void run('check')}
        >
          <Icon icon={mdiRefresh} size="16" aria-hidden />
          {$t(kind === 'ai-down' ? 'frameleaf_gpucheck_try_again' : 'frameleaf_gpucheck_check_again')}
        </Button>
        {#if kind === 'ai-down'}
          <a class="button" href={commandCenterUrl('intelligence', 'machine-learning')}>
            {$t('frameleaf_gpucheck_turn_on_ai')}
          </a>
        {/if}
      {/snippet}
      <Coverage rows={coverage} />
    </Hero>

    {#if issues.length > 0}
      <Section title={$t('frameleaf_gpucheck_fix')} description={$t('frameleaf_gpucheck_fix_description')}>
        {#each issues as issue (issue.id)}
          {@const [heading, rest] = splitFirst($t(problemExplainKey(issue.id) as Translations))}
          <div class="problem">
            <strong>{heading}.</strong>
            {#if rest}<span>{rest}</span>{/if}
          </div>
        {/each}
        {#each fixes as entry, index (index)}
          <Advanced summary={$t('frameleaf_gpucheck_fix_show', { values: { maker: composeFixes[entry.id].title } })}>
            {@render fix(entry.id, entry.values)}
            {#each entry.symptoms as symptom (symptom)}
              <p class="hint">{$t('frameleaf_gpucheck_fix_log', { values: { symptom } })}</p>
            {/each}
          </Advanced>
        {/each}
        <p class="hint">{$t('frameleaf_gpucheck_after_fix')}</p>
      </Section>
    {/if}

    <Section title={$t('frameleaf_gpucheck_can')} description={$t('frameleaf_gpucheck_can_description')}>
      {#snippet action()}
        <a class="button" href={commandCenterUrl('processing', 'routing')}>
          {$t('frameleaf_computers_page_routing')}
        </a>
      {/snippet}
      {#each can as row (row.work)}
        <Row label={$t(workKindNameKey(row.work))} help={row.help}>
          <Pill tone={ANSWER_TONES[row.answer]}>{$t(ANSWER_KEYS[row.answer])}</Pill>
        </Row>
      {/each}
      {#each notes as note (note.id)}
        <p class="hint">{$t(problemExplainKey(note.id) as Translations)}</p>
      {/each}
      {#if worker.gpu && worker.gpu.vramGb <= 4}
        <p class="hint">{$t('frameleaf_hardware_small_gpu_note')}</p>
      {/if}
      {#if needsHelp}
        <div class="actions">
          <a class="button" href={commandCenterUrl('processing', 'computers', { add: 'name' })}>
            <Icon icon={mdiPlus} size="16" aria-hidden />{$t('frameleaf_gpucheck_add_computer')}
          </a>
          <a class="button" href={commandCenterUrl('cloud')}>{$t('frameleaf_gpucheck_use_cloud')}</a>
        </div>
      {/if}
    </Section>

    <Section title={$t('frameleaf_gpucheck_tune')}>
      {#if draft && !aiDown}
        <Row label={$t('frameleaf_gpucheck_recommended')} help={$t('frameleaf_gpucheck_recommended_help')}>
          <Button disabled={!!busy} onclick={() => void recommend()}>
            {$t('frameleaf_gpucheck_recommended_button')}
          </Button>
        </Row>
      {/if}
      <Row
        label={$t('frameleaf_gpucheck_measure')}
        help={check.benchmark
          ? `${$t('frameleaf_gpucheck_measure_help')} ${$t('frameleaf_gpucheck_measure_last', {
              values: { when: when(check.benchmark.ranAt) },
            })}`
          : $t('frameleaf_gpucheck_measure_help')}
      >
        <Button disabled={!!busy} onclick={() => void run('benchmark')}>
          <Icon icon={mdiSpeedometer} size="16" aria-hidden />
          {$t('frameleaf_gpucheck_measure_button')}
        </Button>
      </Row>
    </Section>

    {#if check.workers?.length}
      <Section title={$t('frameleaf_gpucheck_others')} description={$t('frameleaf_gpucheck_others_description')}>
        <ItemList>
          {#each check.workers as entry (entry.id)}
            <Item
              icon={mdiDesktopTowerMonitor}
              name={entry.name}
              detail={$t(
                entry.kind === 'render' ? 'frameleaf_gpucheck_other_studio' : 'frameleaf_gpucheck_other_restoration',
              )}
              tone={entry.reachable ? 'good' : 'warn'}
              status={$t(entry.reachable ? 'frameleaf_gpucheck_other_ready' : 'frameleaf_gpucheck_other_silent')}
              note={[
                entry.model,
                entry.vramGb ? $t('frameleaf_hardware_memory_value', { values: { gb: entry.vramGb } }) : undefined,
              ]
                .filter(Boolean)
                .join(' · ') || undefined}
            >
              {#snippet action()}
                <a class="button" href={commandCenterUrl('processing', 'computers')}>
                  {$t('frameleaf_computers_page_computers')}
                </a>
              {/snippet}
            </Item>
          {/each}
        </ItemList>
      </Section>
    {/if}

    <Section title={$t('frameleaf_gpucheck_help_title')} description={$t('frameleaf_gpucheck_help_description')}>
      <Advanced summary={$t('frameleaf_gpucheck_technical')}>
        <p class="hint">{$t('frameleaf_gpucheck_technical_intro')}</p>
        <h3 class="subhead">{$t('frameleaf_gpucheck_technical_video')}</h3>
        <Facts rows={grid(check.server)} />
        <h3 class="subhead">{$t('frameleaf_gpucheck_technical_ai')}</h3>
        {#if aiDown}
          <p class="hint">{$t('frameleaf_gpucheck_technical_ai_silent')}</p>
        {:else}
          <Facts rows={grid(check.ml)} />
        {/if}
        {#if models.length > 0}
          <h3 class="subhead">{$t('frameleaf_gpucheck_technical_models')}</h3>
          <Facts rows={models} />
        {/if}
        {#if measured.length > 0}
          <h3 class="subhead">{$t('frameleaf_gpucheck_technical_measured')}</h3>
          <Facts rows={measured} />
        {/if}
      </Advanced>
      <Advanced summary={$t('frameleaf_gpucheck_problems')}>
        <ul class="problems">
          {#each gpuProblems as problem (problem.id)}
            {@const [heading] = splitFirst($t(problemExplainKey(problem.id) as Translations))}
            {@const yaml = problem.fix ? fixYaml(problem.fix) : null}
            <li>
              <div>
                <strong>{problem.vendor}: {heading}.</strong>
                <span>{$t('frameleaf_gpucheck_problem_log', { values: { symptom: problem.symptom } })}</span>
              </div>
              {#if yaml}
                <Button
                  label={$t('frameleaf_gpucheck_copy_fix', { values: { maker: `${problem.vendor}: ${heading}` } })}
                  onclick={() => void copy(problem.id, yaml)}
                >
                  <Icon icon={mdiContentCopy} size="16" aria-hidden />
                  {$t('frameleaf_gpucheck_copy')}
                </Button>
              {/if}
            </li>
          {/each}
        </ul>
        <p class="hint">{$t('frameleaf_gpucheck_after_fix')}</p>
      </Advanced>
    </Section>
  {/if}
</KitPage>

<style>
  .loading {
    display: grid;
    gap: var(--fl-space-6);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  a.button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-1);
    text-decoration: none;
    white-space: nowrap;
  }
  a.button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  /* What just happened, said where a screen reader hears it. It takes no room while it is empty. */
  .said {
    margin: 0;
    padding: var(--fl-space-3) var(--fl-space-4);
    font-size: var(--fl-font-callout);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .said.is-empty {
    display: none;
  }
  .hint {
    margin: 0;
    padding: var(--fl-space-2) 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .hint:last-child {
    padding-bottom: var(--fl-space-4);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    padding: var(--fl-space-4) 0 var(--fl-space-6);
    border-top: 1px solid var(--fl-border);
  }
  .problem {
    display: grid;
    gap: var(--fl-space-1);
    padding: var(--fl-space-3) 0;
    font-size: var(--fl-font-callout);
    border-top: 1px solid var(--fl-border);
  }
  .problem span {
    color: var(--fl-muted);
  }
  .subhead {
    margin: var(--fl-space-4) 0 var(--fl-space-2);
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  .steps {
    display: grid;
    gap: var(--fl-space-2);
    margin: 0;
    padding: var(--fl-space-2) 0 var(--fl-space-3) var(--fl-space-5);
    font-size: var(--fl-font-callout);
  }
  .code {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: var(--fl-space-3);
    padding: var(--fl-space-3);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .code pre {
    margin: 0;
    overflow-x: auto;
    font-size: var(--fl-font-micro);
    line-height: 1.5;
  }
  .problems {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .problems li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-4);
    padding: var(--fl-space-3) 0;
    border-top: 1px solid var(--fl-border);
  }
  .problems li > div {
    display: grid;
    gap: var(--fl-space-1);
    min-width: 0;
    font-size: var(--fl-font-callout);
  }
  .problems li span {
    color: var(--fl-muted);
    overflow-wrap: anywhere;
  }
  @container kit (max-width: 620px) {
    .code,
    .problems li {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
