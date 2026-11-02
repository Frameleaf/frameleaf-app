<script lang="ts">
  /**
   * "Show in Photos too" (approved prototype `Inspector` `.pro-scope`, README point 6): the only
   * place the Boards-only / Photos-too choice appears. On writes `libraryScope: both`, off writes
   * `design`, through the asset update API. The helper text under the label says what each state
   * means. A failed change puts the switch back and shows an error with Retry. Owner only: the
   * parent renders it just for the item's owner.
   */
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Toggle from '$lib/components/frameleaf/Toggle.svelte';
  import { LibraryScope, updateAsset } from '@frameleaf/sdk';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    assetId,
    scope,
    onChange,
  }: {
    assetId: string;
    /** The item's stored scope. */
    scope: LibraryScope | undefined;
    onChange?: (scope: LibraryScope) => void;
  } = $props();

  const labelId = $props.id();
  let shown = $state(false);
  let busy = $state(false);
  let failed = $state<LibraryScope | null>(null);

  $effect.pre(() => {
    void assetId;
    shown = untrack(() => scope) === LibraryScope.Both;
    busy = false;
    failed = null;
  });

  const save = async (next: LibraryScope) => {
    const id = assetId;
    const previous = shown;
    shown = next === LibraryScope.Both;
    busy = true;
    failed = null;
    try {
      await updateAsset({ id, updateAssetDto: { libraryScope: next } });
      if (assetId === id) {
        onChange?.(next);
      }
    } catch {
      if (assetId === id) {
        shown = previous;
        failed = next;
      }
    } finally {
      if (assetId === id) {
        busy = false;
      }
    }
  };
</script>

<section class="fl-boards-scope" aria-labelledby={labelId}>
  <div class="row">
    <span class="copy">
      <strong id={labelId}>{$t('frameleaf_boards_scope')}</strong>
      <small id="{labelId}-help">{shown ? $t('frameleaf_boards_scope_on') : $t('frameleaf_boards_scope_off')}</small>
    </span>
    <Toggle
      label={$t('frameleaf_boards_scope')}
      checked={shown}
      onLabel={$t('frameleaf_boards_on')}
      offLabel={$t('frameleaf_boards_off')}
      disabled={busy}
      describedBy="{labelId}-help"
      onChange={(checked) => void save(checked ? LibraryScope.Both : LibraryScope.Design)}
    />
  </div>
  {#if failed}
    {@const retry = failed}
    <InlineError compact message={$t('frameleaf_boards_scope_failed')} retrying={busy} onRetry={() => save(retry)} />
  {/if}
</section>

<style>
  .fl-boards-scope {
    display: grid;
    gap: var(--fl-space-2);
  }
  .row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--fl-space-3);
  }
  .copy {
    display: grid;
    gap: var(--fl-space-1);
  }
  strong {
    font-weight: 600;
  }
  small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
</style>
