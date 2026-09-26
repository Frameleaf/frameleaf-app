<script lang="ts">
  /**
   * Enrol or edit a render worker (FL-95). One component covers both: the fields are the same,
   * only the destination is fixed after enrolment and only enrolment ends with a secret.
   *
   * The enrolment secret is the one moment it is ever visible. The server stores a hash, so the
   * dialog switches to a "give this to the worker now" step and stays open until the
   * administrator says they are done; closing clears it from component state. Nothing here logs
   * or persists it, and the toast on success names the worker, not the secret.
   *
   * Validation mirrors, and never replaces, the server's DTO rules: `parseWorkerForm` refuses
   * the values the server would refuse so the administrator sees which field, but a server
   * rejection still surfaces as an error toast.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    RENDER_LIMIT_MAX_CONCURRENCY,
    RENDER_WORKER_KINDS,
    destinationKey,
    operationKindKey,
    parseWorkerForm,
    workerFormFrom,
    type RenderWorkerField,
  } from '$lib/frameleaf/render-workers';
  import { handleCreateRenderWorker, handleUpdateRenderWorker } from '$lib/services/render-worker.service';
  import { copyToClipboard } from '$lib/utils';
  import { MediaOperationDestination, MediaOperationKind, type RenderWorkerDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  let {
    worker,
    onClose,
  }: {
    /** Omitted to enrol a new worker. */
    worker?: RenderWorkerDto;
    onClose: (saved?: RenderWorkerDto) => void;
  } = $props();

  let open = $state(true);
  let working = $state(false);
  let saved = $state<RenderWorkerDto | undefined>();
  let secret = $state('');
  let form = $state(workerFormFrom(worker));
  let error = $state<RenderWorkerField | null>(null);

  const editing = $derived(!!worker);
  const kinds = RENDER_WORKER_KINDS;
  const destinations = Object.values(MediaOperationDestination);

  const idPrefix = $props.id();
  const nameId = `${idPrefix}-name`;
  const destinationId = `${idPrefix}-destination`;
  const kindsId = `${idPrefix}-kinds`;
  const digestId = `${idPrefix}-digest`;
  const conformanceId = `${idPrefix}-conformance`;
  const gpuId = `${idPrefix}-gpu`;
  const concurrencyId = `${idPrefix}-concurrency`;
  const wallClockId = `${idPrefix}-wall-clock`;
  const outputId = `${idPrefix}-output`;
  const errorId = `${idPrefix}-error`;

  const toggleKind = (kind: MediaOperationKind) => {
    form.kinds = form.kinds.includes(kind) ? form.kinds.filter((item) => item !== kind) : [...form.kinds, kind];
  };

  const errorMessage = $derived.by(() => {
    switch (error) {
      case null: {
        return '';
      }
      case 'name': {
        return $t('frameleaf_render_workers_error_name');
      }
      case 'destination': {
        return $t('frameleaf_render_workers_error_destination');
      }
      case 'kinds': {
        return $t('frameleaf_render_workers_error_kinds');
      }
      case 'engineDigest': {
        return $t('frameleaf_render_workers_error_engine_digest');
      }
      case 'conformanceMaxAgeHours': {
        return $t('frameleaf_render_workers_error_conformance');
      }
      case 'gpuMemoryGiB': {
        return $t('frameleaf_render_workers_error_gpu');
      }
      case 'concurrency': {
        return $t('frameleaf_render_workers_error_concurrency', {
          values: { min: 1, max: RENDER_LIMIT_MAX_CONCURRENCY },
        });
      }
      case 'wallClockMinutes': {
        return $t('frameleaf_render_workers_error_wall_clock');
      }
      case 'outputGiB': {
        return $t('frameleaf_render_workers_error_output');
      }
    }
  });

  const title = $derived.by(() => {
    if (secret) {
      return $t('frameleaf_render_workers_secret_title');
    }
    if (editing) {
      return $t('frameleaf_render_workers_form_edit_title', { values: { name: worker?.name ?? '' } });
    }
    return $t('frameleaf_render_workers_form_enrol_title');
  });

  $effect(() => {
    if (open) {
      return;
    }

    // The secret never outlives the dialog.
    secret = '';
    onClose(saved);
  });

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (working) {
      return;
    }

    const parsed = parseWorkerForm(form);
    if (!parsed.ok) {
      error = parsed.field;
      return;
    }
    error = null;

    working = true;
    try {
      const { destination, ...rest } = parsed.value;
      if (worker) {
        const updated = await handleUpdateRenderWorker(worker.id, rest);
        if (updated) {
          saved = updated;
          open = false;
        }
        return;
      }

      const response = await handleCreateRenderWorker({ destination, ...rest });
      if (response) {
        saved = response.worker;
        secret = response.enrolmentSecret;
      }
    } finally {
      working = false;
    }
  };
</script>

<Dialog {title} closeLabel={$t('frameleaf_render_workers_form_close')} bind:open>
  {#if secret && saved}
    <div class="secret">
      <p>{$t('frameleaf_render_workers_secret_body')}</p>
      <dl>
        <dt>{$t('frameleaf_render_workers_secret_worker_id')}</dt>
        <dd>
          <code>{saved.id}</code>
          <Button variant="quiet" onclick={() => void copyToClipboard(saved?.id)}>
            {$t('frameleaf_render_workers_secret_copy_id')}
          </Button>
        </dd>
        <dt>{$t('frameleaf_render_workers_secret_label')}</dt>
        <dd>
          <code>{secret}</code>
          <Button variant="quiet" onclick={() => void copyToClipboard(secret)}>
            {$t('frameleaf_render_workers_secret_copy')}
          </Button>
        </dd>
      </dl>
      <footer>
        <Button variant="primary" onclick={() => (open = false)}>{$t('frameleaf_render_workers_secret_done')}</Button>
      </footer>
    </div>
  {:else}
    <form onsubmit={submit} aria-describedby={error ? errorId : undefined}>
      <label for={nameId}>
        <span>{$t('frameleaf_render_workers_form_name')}</span>
        <input
          id={nameId}
          type="text"
          maxlength="120"
          required
          bind:value={form.name}
          aria-invalid={error === 'name'}
        />
      </label>

      <label for={destinationId}>
        <span>{$t('frameleaf_render_workers_form_destination')}</span>
        <select id={destinationId} bind:value={form.destination} disabled={editing}>
          {#each destinations as value (value)}
            <option {value}>{$t(destinationKey[value])}</option>
          {/each}
        </select>
        <small>{$t('frameleaf_render_workers_form_destination_hint')}</small>
      </label>

      <fieldset class:invalid={error === 'kinds'}>
        <legend id={kindsId}>{$t('frameleaf_render_workers_form_kinds')}</legend>
        {#each kinds as kind (kind)}
          <label class="check">
            <input
              type="checkbox"
              checked={form.kinds.includes(kind)}
              aria-invalid={error === 'kinds'}
              onchange={() => toggleKind(kind)}
            />
            <span>{$t(operationKindKey[kind])}</span>
          </label>
        {/each}
      </fieldset>

      <label for={digestId}>
        <span>{$t('frameleaf_render_workers_form_engine_digest')}</span>
        <input
          id={digestId}
          type="text"
          maxlength="200"
          class="mono"
          bind:value={form.engineDigest}
          aria-invalid={error === 'engineDigest'}
        />
        <small>{$t('frameleaf_render_workers_form_engine_digest_hint')}</small>
      </label>

      <div class="row">
        <label for={conformanceId}>
          <span>{$t('frameleaf_render_workers_form_conformance_hours')}</span>
          <input
            id={conformanceId}
            type="number"
            min="0.02"
            step="any"
            required
            bind:value={form.conformanceMaxAgeHours}
            aria-invalid={error === 'conformanceMaxAgeHours'}
          />
        </label>
        <label for={gpuId}>
          <span>{$t('frameleaf_render_workers_form_gpu_memory')}</span>
          <input
            id={gpuId}
            type="number"
            min="0"
            step="any"
            bind:value={form.gpuMemoryGiB}
            aria-invalid={error === 'gpuMemoryGiB'}
          />
          <small>{$t('frameleaf_render_workers_form_gpu_memory_hint')}</small>
        </label>
      </div>

      <div class="row">
        <label for={concurrencyId}>
          <span>{$t('frameleaf_render_workers_form_concurrency')}</span>
          <input
            id={concurrencyId}
            type="number"
            min="1"
            max={RENDER_LIMIT_MAX_CONCURRENCY}
            step="1"
            required
            bind:value={form.concurrency}
            aria-invalid={error === 'concurrency'}
          />
        </label>
        <label for={wallClockId}>
          <span>{$t('frameleaf_render_workers_form_wall_clock')}</span>
          <input
            id={wallClockId}
            type="number"
            min="0"
            step="any"
            bind:value={form.wallClockMinutes}
            aria-invalid={error === 'wallClockMinutes'}
          />
        </label>
        <label for={outputId}>
          <span>{$t('frameleaf_render_workers_form_output')}</span>
          <input
            id={outputId}
            type="number"
            min="0"
            step="any"
            bind:value={form.outputGiB}
            aria-invalid={error === 'outputGiB'}
          />
        </label>
      </div>
      <small class="hint">{$t('frameleaf_render_workers_form_ceiling_hint')}</small>

      {#if error}
        <p id={errorId} class="error" role="alert">{errorMessage}</p>
      {/if}

      <footer>
        <Button variant="quiet" onclick={() => (open = false)}>{$t('frameleaf_render_workers_form_cancel')}</Button>
        <Button variant="primary" type="submit" disabled={working}>
          {editing ? $t('frameleaf_render_workers_form_submit_save') : $t('frameleaf_render_workers_form_submit_enrol')}
        </Button>
      </footer>
    </form>
  {/if}
</Dialog>

<style>
  form,
  .secret {
    display: grid;
    gap: 0.875rem;
    min-width: min(36rem, 100%);
  }
  label:not(.check) {
    display: grid;
    gap: 0.25rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  input:not([type='checkbox']),
  select {
    padding: 0.4375rem 0.6875rem;
    font: inherit;
    font-size: var(--fl-font-size);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  [aria-invalid='true'],
  fieldset.invalid {
    border-color: var(--fl-danger);
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  small,
  .hint {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  fieldset {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    margin: 0;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  legend {
    padding-inline: 0.25rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--fl-text);
  }
  .row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: 0.75rem;
  }
  .error {
    margin: 0;
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
  }
  footer {
    display: flex;
    justify-content: end;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
  .secret p {
    margin: 0;
    max-width: 60ch;
  }
  dl {
    display: grid;
    gap: 0.25rem 1rem;
    margin: 0;
  }
  dt {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  dd {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0 0.5rem;
  }
  code {
    padding: 0.25rem 0.5rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: var(--fl-font-small);
    overflow-wrap: anywhere;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
</style>
