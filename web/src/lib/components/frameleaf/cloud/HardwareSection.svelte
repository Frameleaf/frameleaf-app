<script lang="ts">
  /**
   * Settings → Compute & jobs → Hardware & GPU (FL-159, handoff §3.2; prototype HardwareCheck.jsx).
   * Checks the GPU each container can use — the server container (video playback and export) and the
   * ML container (AI features) — and explains set-up problems in plain words with a copy-ready docker
   * compose fix per vendor. Detection runs inside each container (server probe, ML `/hardware`
   * probe); nothing here is a sample. "Run a short benchmark" measures this hardware and the model
   * sliders then show adjusted times.
   */
  import './frameleaf-cloud.css';
  import './gpu-models.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import {
    benchmarkFor,
    formatDateTime,
    hardwareConsequences,
    localCapability,
    workerFromHardware,
    workloadNameKey,
    type WorkloadRowId,
  } from '$lib/frameleaf/cloud-ml';
  import {
    composeFixes,
    fixStepKey,
    gpuProblems,
    problemById,
    problemExplainKey,
    type ComposeFixId,
  } from '$lib/frameleaf/gpu-model-catalog';
  import { Route } from '$lib/route';
  import { copyToClipboard } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getHardwareCheck,
    runHardwareBenchmark,
    runHardwareCheck,
    type HardwareCheckResponseDto,
    type HardwareContainerCheckDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiAlertOutline,
    mdiCheckCircleOutline,
    mdiContentCopy,
    mdiExpansionCard,
    mdiLifebuoy,
    mdiProgressClock,
    mdiRefresh,
    mdiSourceBranch,
    mdiSpeedometer,
    mdiWrenchOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { locale, t, type Translations } from 'svelte-i18n';

  let check = $state<HardwareCheckResponseDto | null>(null);
  let loadError = $state(false);
  let busy = $state<'check' | 'benchmark' | null>(null);
  let notice = $state('');

  onMount(async () => {
    try {
      check = await getHardwareCheck();
    } catch (error) {
      loadError = true;
      handleError(error, $t('frameleaf_hardware_error_load'));
    }
  });

  const run = async (kind: 'check' | 'benchmark') => {
    busy = kind;
    notice = '';
    const hadIssues = (check?.issues.length ?? 0) > 0;
    try {
      check = kind === 'check' ? await runHardwareCheck() : await runHardwareBenchmark();
      notice =
        kind === 'benchmark'
          ? $t('frameleaf_hardware_benchmark_done')
          : check.issues.length > 0 && hadIssues
            ? $t('frameleaf_hardware_check_same_problem')
            : $t('frameleaf_hardware_check_done');
    } catch (error) {
      handleError(error, $t('frameleaf_hardware_error_run'));
    } finally {
      busy = null;
    }
  };

  const worker = $derived(workerFromHardware(check));
  const benchmark = $derived(benchmarkFor(check));
  const issues = $derived((check?.issues ?? []).map((id) => problemById(id)).filter((problem) => !!problem));
  const fixes = $derived([
    ...new Set(issues.map((problem) => problem.fix).filter((fix): fix is ComposeFixId => !!fix)),
  ]);
  const status = $derived(
    issues.length > 0
      ? { key: 'frameleaf_hardware_status_attention', tone: 'warning' }
      : worker.gpu
        ? { key: 'frameleaf_hardware_status_gpu', tone: 'ok' }
        : { key: 'frameleaf_hardware_status_processor', tone: 'muted' },
  );

  /** First sentence as the heading, the rest as the explanation. */
  const splitFirst = (text: string) => {
    const index = text.indexOf('. ');
    return index === -1 ? [text.replace(/\.$/, ''), ''] : [text.slice(0, index), text.slice(index + 2)];
  };

  const BACKEND_KEY: Record<string, Translations> = {
    CUDA: 'frameleaf_hardware_backend_cuda',
    ROCm: 'frameleaf_hardware_backend_rocm',
    OpenVINO: 'frameleaf_hardware_backend_openvino',
    NVENC: 'frameleaf_hardware_backend_nvenc',
    'VA-API': 'frameleaf_hardware_backend_vaapi',
    QSV: 'frameleaf_hardware_backend_qsv',
    CPU: 'frameleaf_hardware_backend_cpu',
  };

  const containerStatus = (result: HardwareContainerCheckDto) => {
    const gpu = result.backend !== 'CPU' && (result.vramGb ?? 0) > 0;
    if (!result.reachable) {
      return { key: 'frameleaf_hardware_container_unreachable', tone: 'warning' };
    }
    return gpu
      ? { key: 'frameleaf_hardware_container_gpu', tone: 'ok' }
      : result.test && !result.test.ok
        ? { key: 'frameleaf_hardware_container_not_reached', tone: 'warning' }
        : { key: 'frameleaf_hardware_container_processor', tone: 'muted' };
  };

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

  const workloadName = (workload: string) => $t(workloadNameKey(workload as WorkloadRowId));
</script>

{#snippet container(titleKey: Translations, purposeKey: Translations, result: HardwareContainerCheckDto)}
  {@const state = containerStatus(result)}
  <section class="hw-container" aria-label={$t(titleKey)}>
    <header>
      <div>
        <h3>{$t(titleKey)}</h3>
        <p>{$t(purposeKey)}</p>
      </div>
      <span class="fc-status" class:is-ok={state.tone === 'ok'} class:is-warning={state.tone === 'warning'}
        >{$t(state.key as Translations)}</span
      >
    </header>
    <dl class="fc-facts">
      <dt>{$t('frameleaf_hardware_vendor')}</dt>
      <dd>{result.vendor ?? $t('frameleaf_hardware_none_found')}</dd>
      <dt>{$t('frameleaf_hardware_model')}</dt>
      <dd>{result.model ?? '—'}</dd>
      <dt>{$t('frameleaf_hardware_memory')}</dt>
      <dd>{result.vramGb ? $t('frameleaf_hardware_memory_value', { values: { gb: result.vramGb } }) : '—'}</dd>
      <dt>{$t('frameleaf_hardware_driver')}</dt>
      <dd>{result.driver ?? '—'}</dd>
      <dt>{$t('frameleaf_hardware_backend')}</dt>
      <dd>{$t(BACKEND_KEY[result.backend])}</dd>
    </dl>
    <p class="hw-test" class:is-ok={result.test?.ok} class:is-bad={!result.test?.ok}>
      <Icon icon={result.test?.ok ? mdiCheckCircleOutline : mdiAlertOutline} size="16" aria-hidden={true} />
      <span>{testText(result)}</span>
    </p>
  </section>
{/snippet}

{#snippet fix(fixId: ComposeFixId)}
  {@const entry = composeFixes[fixId]}
  <div class="hw-fix">
    <strong>{$t('frameleaf_hardware_fix_for', { values: { vendor: entry.title } })}</strong>
    <ol>
      {#each Array.from({ length: entry.steps }, (_, index) => index + 1) as step (step)}
        <li>{$t(fixStepKey(fixId, step) as Translations)}</li>
      {/each}
    </ol>
    <div class="hw-code">
      <pre aria-label={$t('frameleaf_hardware_fix_code', { values: { vendor: entry.title } })}><code>{entry.yaml}</code
        ></pre>
      <Button
        label={$t('frameleaf_hardware_copy_fix', { values: { vendor: entry.title } })}
        onclick={() => void copyToClipboard(entry.yaml)}
      >
        <Icon icon={mdiContentCopy} size="16" aria-hidden={true} />
        {$t('frameleaf_hardware_copy')}
      </Button>
    </div>
  </div>
{/snippet}

<div class="hw frameleaf-cloud">
  {#if notice}
    <p class="fc-banner" role="status">{notice}</p>
  {/if}
  <section class="fc-card fl-continuous-corners" aria-labelledby="hw-title">
    <div class="fc-card-title">
      <span class="fc-card-icon"><Icon icon={mdiExpansionCard} size="20" aria-hidden={true} /></span>
      <div>
        <h2 id="hw-title">{$t('frameleaf_hardware_title')}</h2>
        <p>
          {$t('frameleaf_hardware_description')}
          {#if check}
            {$t('frameleaf_hardware_last_checked', { values: { date: formatDateTime(check.checkedAt, $locale) } })}
          {/if}
        </p>
      </div>
      {#if check}
        <span class="fc-status" class:is-ok={status.tone === 'ok'} class:is-warning={status.tone === 'warning'}
          >{$t(status.key as Translations)}</span
        >
      {/if}
    </div>
    {#if loadError && !check}
      <p class="fc-refusal" role="alert">
        <Icon icon={mdiAlertOutline} size="16" aria-hidden={true} />
        {$t('frameleaf_hardware_error_load')}
      </p>
    {:else if !check}
      <p class="hw-running fc-waiting" role="status">
        <Icon icon={mdiProgressClock} size="16" aria-hidden={true} />
        {$t('frameleaf_hardware_checking')}
      </p>
    {:else}
      <div class="hw-containers">
        {@render container('frameleaf_hardware_server_title', 'frameleaf_hardware_server_purpose', check.server)}
        {@render container('frameleaf_hardware_ml_title', 'frameleaf_hardware_ml_purpose', check.ml)}
      </div>
      {#if worker.gpu && worker.gpu.vramGb <= 4}
        <p class="fc-muted">{$t('frameleaf_hardware_small_gpu_note')}</p>
      {/if}
    {/if}
    {#if busy}
      <p class="hw-running fc-waiting" role="status">
        <Icon icon={mdiProgressClock} size="16" aria-hidden={true} />
        {busy === 'check' ? $t('frameleaf_hardware_checking') : $t('frameleaf_hardware_benchmarking')}
      </p>
    {/if}
    <div class="fc-actions">
      <Button disabled={!!busy} onclick={() => void run('check')}>
        <Icon icon={mdiRefresh} size="16" aria-hidden={true} />
        {$t('frameleaf_hardware_run_check')}
      </Button>
      <Button disabled={!!busy} onclick={() => void run('benchmark')}>
        <Icon icon={mdiSpeedometer} size="16" aria-hidden={true} />
        {$t('frameleaf_hardware_run_benchmark')}
      </Button>
    </div>
    {#if check?.benchmark}
      <dl class="fc-facts hw-benchmark">
        <dt>{$t('frameleaf_hardware_benchmark_embedding')}</dt>
        <dd>
          {check.benchmark.embeddingMs === null
            ? '—'
            : $t('frameleaf_hardware_benchmark_ms', { values: { ms: check.benchmark.embeddingMs } })}
        </dd>
        <dt>{$t('frameleaf_hardware_benchmark_transcode')}</dt>
        <dd>
          {check.benchmark.transcodeSpeed === null
            ? '—'
            : $t('frameleaf_hardware_benchmark_speed', { values: { speed: check.benchmark.transcodeSpeed } })}
        </dd>
        <dt>{$t('frameleaf_hardware_benchmark_ran')}</dt>
        <dd>{formatDateTime(check.benchmark.ranAt, $locale)}</dd>
      </dl>
    {/if}
  </section>

  {#if issues.length > 0}
    <section class="fc-card fl-continuous-corners" aria-labelledby="hw-issues-title">
      <div class="fc-card-title">
        <span class="fc-card-icon"><Icon icon={mdiWrenchOutline} size="20" aria-hidden={true} /></span>
        <div>
          <h2 id="hw-issues-title">{$t('frameleaf_hardware_issues_title')}</h2>
          <p>{$t('frameleaf_hardware_issues_description')}</p>
        </div>
      </div>
      {#each issues as issue (issue.id)}
        {@const [heading, rest] = splitFirst($t(problemExplainKey(issue.id) as Translations))}
        <div class="hw-issue">
          <h3><Icon icon={mdiAlertOutline} size="16" aria-hidden={true} /> {heading}.</h3>
          {#if rest}<p>{rest}</p>{/if}
          <p>{$t('frameleaf_hardware_issue_log')} <code>{issue.symptom}</code></p>
        </div>
      {/each}
      {#each fixes as fixId (fixId)}
        {@render fix(fixId)}
      {/each}
      <p class="fc-muted">{$t('frameleaf_hardware_after_fix')}</p>
    </section>
  {/if}

  {#if check}
    <section class="fc-card fl-continuous-corners" aria-labelledby="hw-effect-title">
      <div class="fc-card-title">
        <span class="fc-card-icon"><Icon icon={mdiSourceBranch} size="20" aria-hidden={true} /></span>
        <div>
          <h2 id="hw-effect-title">{$t('frameleaf_hardware_can_run_title')}</h2>
          <p>{$t('frameleaf_hardware_can_run_description')}</p>
        </div>
      </div>
      <dl class="fc-facts">
        {#each hardwareConsequences(worker, benchmark) as row (row.workload)}
          <dt>{workloadName(row.workload)}</dt>
          <dd>
            {#if row.heaviest}
              {$t(row.heaviest.band === 'gpu' ? 'frameleaf_hardware_up_to_gpu' : 'frameleaf_hardware_up_to_cpu', {
                values: { model: row.heaviest.item.name, slow: row.heaviest.speedClass === 'slow' ? 'yes' : 'no' },
              })}
            {:else}
              {@const capability = localCapability(row.workload, worker)}
              {$t(capability.key, { values: capability.values })}
            {/if}
            {#if row.cloudOnly > 0}
              {$t('frameleaf_hardware_cloud_only_count', { values: { count: row.cloudOnly } })}
            {/if}
          </dd>
        {/each}
      </dl>
      <div class="fc-actions">
        <a class="fc-link" href={Route.systemProcessingDestinations()}>{$t('frameleaf_hardware_choose_models')}</a>
      </div>
    </section>
  {/if}

  <details class="fc-disclosure fl-continuous-corners">
    <summary
      ><Icon icon={mdiLifebuoy} size="16" aria-hidden={true} /> {$t('frameleaf_hardware_common_problems')}</summary
    >
    <ul class="hw-problems">
      {#each gpuProblems as problem (problem.id)}
        {@const [heading, rest] = splitFirst($t(problemExplainKey(problem.id) as Translations))}
        <li>
          <strong>{problem.vendor} · {heading}.</strong>
          <code>{problem.symptom}</code>
          {#if rest}<span>{rest}</span>{/if}
        </li>
      {/each}
    </ul>
    {#each Object.keys(composeFixes) as fixId (fixId)}
      {@render fix(fixId as ComposeFixId)}
    {/each}
  </details>
</div>
