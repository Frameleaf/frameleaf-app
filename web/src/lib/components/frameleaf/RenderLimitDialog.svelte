<script lang="ts">
  /**
   * Edit the instance default or one account's render limits (FL-95). A blank wall-clock or
   * output field is "no ceiling"; a concurrency of zero pauses an account's rendering without
   * revoking any worker. `parseLimitForm` refuses what the server would refuse so the right
   * field is pointed at; the server remains the boundary.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    RENDER_LIMIT_MAX_CONCURRENCY,
    limitFormFrom,
    parseLimitForm,
    type RenderLimitField,
  } from '$lib/frameleaf/render-workers';
  import { handleUpdateRenderLimits } from '$lib/services/render-worker.service';
  import type { RenderWorkerLimitDto, UserAdminResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  let {
    limit,
    scope,
    users,
    onClose,
  }: {
    /** The row being edited, or undefined for a new account row. */
    limit?: RenderWorkerLimitDto;
    scope: 'instance' | 'user';
    /** Accounts that may receive a new row; those with a row already are left out by the page. */
    users: UserAdminResponseDto[];
    onClose: (saved?: RenderWorkerLimitDto) => void;
  } = $props();

  let open = $state(true);
  let working = $state(false);
  let saved = $state<RenderWorkerLimitDto | undefined>();
  let form = $state(limitFormFrom(limit));
  let userId = $state(limit?.userId ?? '');
  let error = $state<RenderLimitField | 'account' | null>(null);

  const adding = $derived(scope === 'user' && !limit);
  const subject = $derived(limit?.userId ? users.find((user) => user.id === limit.userId) : undefined);

  const idPrefix = $props.id();
  const accountId = `${idPrefix}-account`;
  const concurrencyId = `${idPrefix}-concurrency`;
  const wallClockId = `${idPrefix}-wall-clock`;
  const outputId = `${idPrefix}-output`;
  const errorId = `${idPrefix}-error`;

  const title = $derived.by(() => {
    if (scope === 'instance') {
      return $t('frameleaf_render_workers_limit_dialog_instance_title');
    }
    if (adding) {
      return $t('frameleaf_render_workers_limit_dialog_new_title');
    }
    return $t('frameleaf_render_workers_limit_dialog_user_title', {
      values: { name: subject?.name ?? limit?.userId ?? '' },
    });
  });

  const errorMessage = $derived.by(() => {
    switch (error) {
      case null: {
        return '';
      }
      case 'account': {
        return $t('frameleaf_render_workers_error_account');
      }
      case 'concurrency': {
        return $t('frameleaf_render_workers_error_concurrency', {
          values: { min: 0, max: RENDER_LIMIT_MAX_CONCURRENCY },
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

  $effect(() => {
    if (!open) {
      onClose(saved);
    }
  });

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (working) {
      return;
    }

    if (scope === 'user' && userId === '') {
      error = 'account';
      return;
    }
    const parsed = parseLimitForm(form, { minConcurrency: 0 });
    if (!parsed.ok) {
      error = parsed.field;
      return;
    }
    error = null;

    working = true;
    try {
      const result = await handleUpdateRenderLimits({
        userId: scope === 'instance' ? null : userId,
        ...parsed.value,
      });
      if (result) {
        saved = result;
        open = false;
      }
    } finally {
      working = false;
    }
  };
</script>

<Dialog {title} closeLabel={$t('frameleaf_render_workers_form_close')} bind:open>
  <form onsubmit={submit} aria-describedby={error ? errorId : undefined}>
    {#if adding}
      <label for={accountId}>
        <span>{$t('frameleaf_render_workers_limit_dialog_account')}</span>
        <select id={accountId} bind:value={userId} required aria-invalid={error === 'account'}>
          <option value="" disabled>{$t('frameleaf_render_workers_limit_dialog_account_placeholder')}</option>
          {#each users as user (user.id)}
            <option value={user.id}>{user.name} · {user.email}</option>
          {/each}
        </select>
      </label>
    {/if}

    <div class="row">
      <label for={concurrencyId}>
        <span>{$t('frameleaf_render_workers_form_concurrency')}</span>
        <input
          id={concurrencyId}
          type="number"
          min="0"
          max={RENDER_LIMIT_MAX_CONCURRENCY}
          step="1"
          required
          bind:value={form.concurrency}
          aria-invalid={error === 'concurrency'}
        />
        {#if scope === 'user'}
          <small>{$t('frameleaf_render_workers_limit_dialog_concurrency_hint')}</small>
        {/if}
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
        {$t('frameleaf_render_workers_form_submit_save')}
      </Button>
    </footer>
  </form>
</Dialog>

<style>
  form {
    display: grid;
    gap: 0.875rem;
    min-width: min(32rem, 100%);
  }
  label {
    display: grid;
    gap: 0.25rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  input,
  select {
    padding: 0.4375rem 0.6875rem;
    font: inherit;
    font-size: var(--fl-font-size);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  [aria-invalid='true'] {
    border-color: var(--fl-danger);
  }
  small,
  .hint {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
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
  }
</style>
