<script lang="ts">
  /**
   * The workflow designer (FL-82), ported from the design template's `WorkflowDesigner.jsx`: Steps,
   * Validation, History and JSON over one draft of the complete definition.
   *
   * Methods, triggers and templates are the ones the server's installed, enabled plugins provide;
   * nothing is invented. A step whose method is not installed, an unavailable trigger, unknown
   * parameters and additional fields all stay in the draft and are saved and exported unchanged. The
   * server refuses to enable or run what cannot run, and the draft stays open when a save fails.
   * History is the server's real run log: attempts, failures and manual retry.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import WorkflowParameter, { type ReferenceOption } from '$lib/components/frameleaf/WorkflowParameter.svelte';
  import '$lib/frameleaf/workflow-designer.css';
  import {
    cloneJson,
    draftFromDocument,
    draftToCreateDto,
    draftToDocument,
    draftToUpdateDto,
    exportDraft,
    exportFileName,
    findMethod,
    isFilterMethod,
    methodSchema,
    parseWorkflowDefinition,
    schemaDefaults,
    WORKFLOW_LIMITS,
    previewWorkflow,
    workflowProblems,
    type WorkflowDraft,
    type WorkflowDraftStep,
  } from '$lib/frameleaf/workflows';
  import { Route } from '$lib/route';
  import { downloadJson } from '$lib/utils';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    createWorkflow,
    deleteWorkflow,
    getWorkflowLogs,
    retryWorkflowRun,
    updateWorkflow,
    WorkflowResult,
    WorkflowRunErrorCode,
    type PluginMethodResponseDto,
    type PluginTemplateResponseDto,
    type WorkflowLogEntryDto,
    type WorkflowResponseDto,
    type WorkflowTriggerResponseDto,
  } from '@immich/sdk';
  import { DateTime } from 'luxon';
  import { t, type Translations } from 'svelte-i18n';

  type Tab = 'steps' | 'validation' | 'history' | 'json';

  let {
    open = $bindable(false),
    workflow,
    initial,
    methods,
    triggers,
    templates,
    references = {},
    onSaved,
    onDeleted,
  }: {
    open?: boolean;
    /** The stored workflow, or none for a new or imported one. */
    workflow?: WorkflowResponseDto;
    initial: WorkflowDraft;
    methods: PluginMethodResponseDto[];
    triggers: WorkflowTriggerResponseDto[];
    templates: PluginTemplateResponseDto[];
    references?: Record<string, ReferenceOption[]>;
    onSaved: (workflow: WorkflowResponseDto) => void;
    onDeleted: (id: string) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let draft = $state<WorkflowDraft>(cloneJson(initial));
  // svelte-ignore state_referenced_locally
  const saved = JSON.stringify(initial);
  let tab = $state<Tab>('steps');
  let active = $state(0);
  // svelte-ignore state_referenced_locally
  let method = $state(methods[0]?.key ?? '');
  let template = $state('');
  let error = $state('');
  let raw = $state('');
  let parameterJson = $state<string | null>(null);
  let validation = $state<ReturnType<typeof previewWorkflow> | null>(null);
  let deleting = $state(false);
  let saving = $state(false);

  const document = $derived(JSON.stringify(draftToDocument(draft), null, 2));
  const problems = $derived(workflowProblems(draft, methods, triggers));
  const persistError = $derived(
    draft.enabled && problems.length > 0
      ? $t('frameleaf_workflows.pause_before_saving', { values: { problem: problems[0].message } })
      : '',
  );
  const dirty = $derived(JSON.stringify(draft) !== saved);
  const selected = $derived<WorkflowDraftStep | undefined>(draft.steps[active]);
  const parametersPending = $derived(
    parameterJson !== null && parameterJson !== JSON.stringify(selected?.config ?? null, null, 2),
  );
  const definition = $derived(selected ? findMethod(methods, selected.method) : undefined);
  const jsonPending = $derived(tab === 'json' && raw !== document);
  const knownTrigger = $derived(triggers.some((item) => item.trigger === draft.trigger));
  const triggerLabel = (trigger: string) => {
    const key = `frameleaf_workflows.trigger_${trigger}`;
    const label = $t(key as Translations);
    return label === key ? trigger : label;
  };

  const update = (next: WorkflowDraft) => {
    draft = next;
    error = '';
    validation = null;
  };

  const updateStep = (next: WorkflowDraftStep) =>
    update({ ...draft, steps: draft.steps.map((step, index) => (index === active ? next : step)) });

  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= draft.steps.length) {
      return;
    }
    const steps = [...draft.steps];
    const [moved] = steps.splice(index, 1);
    steps.splice(target, 0, moved);
    update({ ...draft, steps });
    active = target;
  };

  const removeStep = (index: number) => {
    update({ ...draft, steps: draft.steps.filter((_, i) => i !== index) });
    active = Math.max(0, Math.min(active, draft.steps.length - 1));
    parameterJson = null;
  };

  const addStep = () => {
    const chosen = methods.find((item) => item.key === method);
    if (!chosen || draft.steps.length >= WORKFLOW_LIMITS.steps) {
      return;
    }
    const config = schemaDefaults(methodSchema(chosen)) as Record<string, unknown>;
    update({
      ...draft,
      steps: [...draft.steps, { method: chosen.key, config, enabled: true, extra: {}, storedSecrets: [] }],
    });
    active = draft.steps.length - 1;
  };

  const applyTemplate = () => {
    const chosen = templates.find((item) => item.key === template);
    if (!chosen) {
      return;
    }
    update({
      ...draft,
      trigger: chosen.trigger,
      name: draft.name || chosen.title,
      description: draft.description || chosen.description,
      enabled: false,
      steps: chosen.steps.map((step) => ({
        method: step.method,
        config: cloneJson(step.config),
        enabled: step.enabled !== false,
        extra: {},
        storedSecrets: [],
      })),
    });
    active = 0;
    template = '';
  };

  const chooseTab = (next: Tab) => {
    error = '';
    if (next === 'json') {
      raw = document;
    } else if (next === 'history') {
      void loadLogs(true);
    }
    parameterJson = null;
    tab = next;
  };

  const applyJson = () => {
    try {
      update(draftFromDocument(raw, draft));
      raw = document;
    } catch (error_) {
      error = (error_ as Error).message;
    }
  };

  const applyParameters = () => {
    if (!selected || parameterJson === null) {
      return;
    }
    try {
      const config = JSON.parse(parameterJson) as Record<string, unknown> | null;
      const next = { ...selected, config };
      parseWorkflowDefinition({
        ...draftToDocument({ ...draft, steps: draft.steps.map((step, i) => (i === active ? next : step)) }),
      });
      updateStep(next);
      parameterJson = null;
    } catch (error_) {
      error = (error_ as Error).message;
    }
  };

  const save = async () => {
    if (persistError || saving) {
      error = persistError;
      return;
    }
    saving = true;
    try {
      const response = workflow
        ? await updateWorkflow({ id: workflow.id, workflowUpdateDto: draftToUpdateDto(draft) })
        : await createWorkflow({ workflowCreateDto: draftToCreateDto(draft) });
      onSaved(response);
      open = false;
    } catch (error_) {
      // the draft stays open with everything in it
      error = getServerErrorMessage(error_) ?? $t('errors.unable_to_update_workflow');
    } finally {
      saving = false;
    }
  };

  const remove = async () => {
    if (!workflow) {
      open = false;
      return;
    }
    try {
      await deleteWorkflow({ id: workflow.id });
      onDeleted(workflow.id);
      open = false;
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('errors.unable_to_delete_workflow');
    }
  };

  const cancel = () => {
    if ((!dirty && !jsonPending && !parametersPending) || confirm($t('frameleaf_workflows.discard_prompt'))) {
      open = false;
    }
  };

  // -------------------------------------------------------------------------------------------------
  // History

  let logs = $state<WorkflowLogEntryDto[]>([]);
  let logFilter = $state<WorkflowResult | ''>('');
  let logsLoading = $state(false);
  let logsMore = $state(false);
  let notice = $state('');
  const LOG_PAGE = 50;

  const loadLogs = async (reset: boolean) => {
    if (!workflow || logsLoading) {
      return;
    }
    logsLoading = true;
    try {
      const before = reset ? undefined : logs.at(-1)?.at;
      const page = await getWorkflowLogs({ id: workflow.id, limit: LOG_PAGE, before, result: logFilter || undefined });
      logs = reset ? page : [...logs, ...page];
      logsMore = page.length === LOG_PAGE;
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('errors.something_went_wrong');
    } finally {
      logsLoading = false;
    }
  };

  const retry = async (entry: WorkflowLogEntryDto) => {
    if (!workflow) {
      return;
    }
    try {
      await retryWorkflowRun({ id: workflow.id, runId: entry.runId });
      notice = $t('frameleaf_workflows.retry_queued');
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('errors.something_went_wrong');
    }
  };

  const attemptLabel = (attempt: number) =>
    attempt === 0
      ? $t('frameleaf_workflows.attempt_first')
      : attempt === 1
        ? $t('frameleaf_workflows.attempt_retry')
        : $t('frameleaf_workflows.attempt_manual', { values: { number: attempt } });

  const resultLabel = (entry: WorkflowLogEntryDto) => {
    if (entry.errorCode === WorkflowRunErrorCode.Unsupported) {
      return $t('frameleaf_workflows.not_run');
    }
    const label = {
      [WorkflowResult.Completed]: $t('frameleaf_workflows.result_completed'),
      [WorkflowResult.Halted]: $t('frameleaf_workflows.result_halted'),
      [WorkflowResult.Error]: $t('frameleaf_workflows.result_error'),
    }[entry.result];
    return entry.lastStep
      ? `${label} ${$t('frameleaf_workflows.stopped_at_step', { values: { step: entry.lastStep.index + 1 } })}`
      : label;
  };
</script>

<Dialog
  title={draft.name || $t('frameleaf_workflows.new_workflow')}
  closeLabel={$t('close')}
  onRequestClose={cancel}
  wide
  bind:open
>
  <div class="workflow-designer">
    <div class="wd-tabs" role="group" aria-label={$t('frameleaf_workflows.tabs_label')}>
      {#each [['steps', 'tab_steps'], ['validation', 'tab_validation'], ['history', 'tab_history'], ['json', 'tab_json']] as const as [id, key] (id)}
        <Button pressed={tab === id} onclick={() => chooseTab(id)}>{$t(`frameleaf_workflows.${key}`)}</Button>
      {/each}
    </div>

    {#if error}<p role="alert" class="wd-error">{error}</p>{/if}
    {#if persistError}<p class="wd-message">{persistError}</p>{/if}

    {#if tab === 'steps'}
      <div class="wd-meta">
        <label class="wd-field">
          {$t('frameleaf_workflows.name')}
          <input
            value={draft.name ?? ''}
            maxlength={300}
            oninput={(event) => update({ ...draft, name: event.currentTarget.value || null })}
          />
        </label>
        <label class="wd-field">
          {$t('frameleaf_workflows.trigger')}
          <select value={draft.trigger} onchange={(event) => update({ ...draft, trigger: event.currentTarget.value })}>
            {#if !knownTrigger}
              <option value={draft.trigger}>
                {$t('frameleaf_workflows.trigger_unavailable', { values: { trigger: draft.trigger } })}
              </option>
            {/if}
            {#each triggers as item (item.trigger)}
              <option value={item.trigger}>{triggerLabel(item.trigger)}</option>
            {/each}
          </select>
        </label>
        <label class="wd-field wd-description">
          {$t('frameleaf_workflows.description')}
          <textarea
            rows={2}
            value={draft.description ?? ''}
            oninput={(event) => update({ ...draft, description: event.currentTarget.value || null })}></textarea>
        </label>
      </div>

      <div class="wd-switches">
        <label>
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={!draft.enabled && problems.length > 0}
            onchange={(event) => update({ ...draft, enabled: event.currentTarget.checked })}
          />
          {$t('frameleaf_workflows.enable_workflow')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.logging}
            onchange={(event) => update({ ...draft, logging: event.currentTarget.checked })}
          />
          {$t('frameleaf_workflows.keep_history')}
        </label>
      </div>

      {#if templates.length > 0}
        <div class="wd-template">
          <label>
            {$t('frameleaf_workflows.template')}
            <select bind:value={template}>
              <option value="">{$t('frameleaf_workflows.choose_template')}</option>
              {#each templates as item (item.key)}
                <option value={item.key}>{item.title}</option>
              {/each}
            </select>
          </label>
          {#if template}
            <p>{templates.find((item) => item.key === template)?.description}</p>
            <Button onclick={applyTemplate}>{$t('frameleaf_workflows.replace_with_template')}</Button>
          {/if}
        </div>
      {/if}

      <div class="wd-workspace">
        <div class="wd-steps">
          <h3>{$t('frameleaf_workflows.ordered_steps')}</h3>
          <ol>
            {#each draft.steps as step, index (index)}
              {@const stepMethod = findMethod(methods, step.method)}
              <li class:selected={index === active} class:problem={problems.some((problem) => problem.step === index)}>
                <button
                  type="button"
                  class="wd-step-select"
                  aria-current={index === active ? 'step' : undefined}
                  onclick={() => {
                    active = index;
                    parameterJson = null;
                  }}
                >
                  <strong>
                    {$t('frameleaf_workflows.step_title', {
                      values: {
                        index: index + 1,
                        title: stepMethod?.title ?? $t('frameleaf_workflows.unavailable_method'),
                      },
                    })}
                  </strong>
                  <small>
                    {step.enabled
                      ? isFilterMethod(stepMethod)
                        ? $t('frameleaf_workflows.step_filter')
                        : $t('frameleaf_workflows.step_action')
                      : $t('frameleaf_workflows.step_disabled')}
                  </small>
                </button>
                <div class="wd-step-actions">
                  <Button
                    disabled={index === 0}
                    label={$t('frameleaf_workflows.move_earlier', { values: { index: index + 1 } })}
                    onclick={() => move(index, -1)}>↑</Button
                  >
                  <Button
                    disabled={index === draft.steps.length - 1}
                    label={$t('frameleaf_workflows.move_later', { values: { index: index + 1 } })}
                    onclick={() => move(index, 1)}>↓</Button
                  >
                  <Button
                    label={$t('frameleaf_workflows.remove_step', { values: { index: index + 1 } })}
                    onclick={() => removeStep(index)}>{$t('frameleaf_workflows.remove')}</Button
                  >
                </div>
              </li>
            {/each}
          </ol>
          {#if draft.steps.length === 0}<p>{$t('frameleaf_workflows.no_steps')}</p>{/if}
          <label class="wd-field">
            {$t('frameleaf_workflows.available_method')}
            <select bind:value={method}>
              {#each methods as item (item.key)}
                <option value={item.key}>{item.title}</option>
              {/each}
            </select>
          </label>
          <Button disabled={!method || draft.steps.length >= WORKFLOW_LIMITS.steps} onclick={addStep}>
            {$t('frameleaf_workflows.add_step')}
          </Button>
        </div>

        <section class="wd-parameters" aria-label={$t('frameleaf_workflows.step_details')}>
          <h3>
            {definition?.title ??
              (selected ? $t('frameleaf_workflows.unavailable_method') : $t('frameleaf_workflows.step_details'))}
          </h3>
          {#if definition?.description}<p>{definition.description}</p>{/if}
          {#if definition && definition.allowedHosts.length > 0}
            <p>{$t('frameleaf_workflows.contacts_hosts', { values: { hosts: definition.allowedHosts.join(', ') } })}</p>
          {/if}
          {#if selected}
            <label class="wd-check">
              <input
                type="checkbox"
                checked={selected.enabled}
                onchange={(event) => updateStep({ ...selected, enabled: event.currentTarget.checked })}
              />
              {$t('frameleaf_workflows.enable_step')}
            </label>
            {#if definition}
              <WorkflowParameter
                schema={methodSchema(definition)}
                value={selected.config ?? {}}
                label={$t('frameleaf_workflows.parameters')}
                storedSecrets={selected.storedSecrets}
                {references}
                onChange={(config) => updateStep({ ...selected, config: config as Record<string, unknown> })}
              />
              {#if selected.storedSecrets.length > 0}<small>{$t('frameleaf_workflows.credentials_note')}</small>{/if}
            {:else}
              <p>{$t('frameleaf_workflows.method_not_installed')}</p>
            {/if}
            <details>
              <summary>{$t('frameleaf_workflows.method_json')}</summary>
              <code>{selected.method}</code>
              <p>{$t('frameleaf_workflows.method_json_help')}</p>
              {#if parameterJson === null}
                <pre>{JSON.stringify(selected.config ?? null, null, 2)}</pre>
                <Button onclick={() => (parameterJson = JSON.stringify(selected.config ?? null, null, 2))}>
                  {$t('frameleaf_workflows.edit_parameter_json')}
                </Button>
              {:else}
                <textarea aria-label={$t('frameleaf_workflows.parameter_json')} rows={12} bind:value={parameterJson}
                ></textarea>
                <div class="wd-row">
                  <Button onclick={() => (parameterJson = null)}
                    >{$t('frameleaf_workflows.cancel_parameter_edits')}</Button
                  >
                  <Button onclick={applyParameters}>{$t('frameleaf_workflows.apply_parameters')}</Button>
                </div>
              {/if}
            </details>
          {/if}
        </section>
      </div>

      <div class="wd-danger">
        <Button onclick={() => (deleting = !deleting)}>{$t('frameleaf_workflows.delete_workflow')}</Button>
        {#if deleting}
          <p>{$t('frameleaf_workflows.delete_prompt')}</p>
          <Button onclick={() => void remove()}>{$t('frameleaf_workflows.confirm_delete')}</Button>
        {/if}
      </div>
    {:else if tab === 'validation'}
      <h3>{$t('frameleaf_workflows.validation_title')}</h3>
      <p>{$t('frameleaf_workflows.validation_help')}</p>
      <div>
        <Button onclick={() => (validation = previewWorkflow(draft, methods, triggers))}>
          {$t('frameleaf_workflows.validate')}
        </Button>
      </div>
      {#if validation}
        <div role="status">
          {#if validation.problems.length > 0}
            <ul>
              {#each validation.problems as problem, index (index)}<li>{problem.message}</li>{/each}
            </ul>
          {:else}
            <!-- WorkflowDesigner.jsx "Check and preview": a step-by-step dry run; nothing executes. -->
            <p>{$t('frameleaf_workflows.validation_ok')}</p>
            <ol class="wd-preview">
              {#each validation.steps as step (step.index)}
                <li>
                  <strong>{step.title ?? step.method}</strong>
                  <span>
                    {step.result === 'disabled'
                      ? $t('frameleaf_workflows.preview_step_disabled')
                      : $t('frameleaf_workflows.preview_step_validated')}
                  </span>
                </li>
              {/each}
            </ol>
            <p>{$t('frameleaf_workflows.preview_run_needs')}</p>
          {/if}
        </div>
      {/if}
    {:else if tab === 'history'}
      <h3>{$t('frameleaf_workflows.history_title')}</h3>
      <p>{$t('frameleaf_workflows.history_help')}</p>
      {#if notice}<p role="status">{notice}</p>{/if}
      {#if !workflow}
        <p>{$t('frameleaf_workflows.history_new')}</p>
      {:else if !workflow.logging}
        <p>{$t('frameleaf_workflows.history_off_help')}</p>
      {:else}
        <label class="wd-field">
          {$t('frameleaf_workflows.filter_all')}
          <select
            bind:value={logFilter}
            onchange={() => void loadLogs(true)}
            aria-label={$t('frameleaf_workflows.filter_all')}
          >
            <option value="">{$t('frameleaf_workflows.filter_all')}</option>
            <option value={WorkflowResult.Completed}>{$t('frameleaf_workflows.result_completed')}</option>
            <option value={WorkflowResult.Halted}>{$t('frameleaf_workflows.result_halted')}</option>
            <option value={WorkflowResult.Error}>{$t('frameleaf_workflows.result_error')}</option>
          </select>
        </label>
        {#if logs.length === 0 && !logsLoading}
          <p>{$t('frameleaf_workflows.history_empty')}</p>
        {:else}
          <table class="wd-history">
            <tbody>
              {#each logs as entry (entry.id)}
                <tr>
                  <td>
                    {DateTime.fromISO(entry.at).toLocaleString(DateTime.DATETIME_MED)}
                    <small>{attemptLabel(entry.attempt)}</small>
                  </td>
                  <td>
                    <strong>{resultLabel(entry)}</strong>
                    {#if entry.error}<small class="wd-error">{entry.error}</small>{/if}
                  </td>
                  <td>
                    {#if entry.triggerDataId}
                      <a href={Route.viewAsset({ id: entry.triggerDataId })}>{$t('frameleaf_workflows.open_photo')}</a>
                    {/if}
                    {#if entry.errorCode === WorkflowRunErrorCode.StepFailed && entry.triggerDataId && workflow.enabled}
                      <Button onclick={() => void retry(entry)}>{$t('frameleaf_workflows.retry')}</Button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if logsMore}
            <Button disabled={logsLoading} onclick={() => void loadLogs(false)}
              >{$t('frameleaf_workflows.load_more')}</Button
            >
          {/if}
        {/if}
      {/if}
    {:else}
      <h3>{$t('frameleaf_workflows.json_title')}</h3>
      <p>{$t('frameleaf_workflows.json_help')}</p>
      <textarea
        class="wd-json"
        aria-label={$t('frameleaf_workflows.json_label')}
        spellcheck={false}
        rows={20}
        bind:value={raw}></textarea>
      <div class="wd-switches">
        <Button onclick={applyJson}>{$t('frameleaf_workflows.apply_json')}</Button>
        <Button disabled={jsonPending} onclick={() => downloadJson(exportDraft(draft), exportFileName(draft.name))}>
          {$t('frameleaf_workflows.export_definition')}
        </Button>
      </div>
    {/if}

    <div class="wd-actions">
      <Button onclick={cancel}>{$t('frameleaf_workflows.cancel')}</Button>
      <Button
        variant="primary"
        disabled={!!persistError || saving || parameterJson !== null || jsonPending}
        onclick={() => void save()}
      >
        {$t('frameleaf_workflows.save')}
      </Button>
    </div>
  </div>
</Dialog>
