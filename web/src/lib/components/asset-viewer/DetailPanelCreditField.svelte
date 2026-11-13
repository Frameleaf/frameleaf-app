<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { updateAsset, type AssetResponseDto } from '@frameleaf/sdk';
  import { Button, Icon } from '@frameleaf/ui';
  import { mdiPencilOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    asset,
    field,
    label,
    isOwner,
    onAssetRefresh,
  }: {
    asset: AssetResponseDto;
    field: 'title' | 'artist' | 'copyright';
    label: string;
    isOwner: boolean;
    onAssetRefresh?: (asset: AssetResponseDto) => void;
  } = $props();
  let value = $derived(asset.exifInfo?.[field] ?? '');
  let editing = $state(false);
  let saving = $state(false);
  let draft = $state('');
  let input = $state<HTMLInputElement>();
  let trigger = $state<HTMLButtonElement>();
  const inputId = $props.id();

  const close = () => {
    editing = false;
    queueMicrotask(() => trigger?.focus());
  };
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (saving || !isOwner) {
      return;
    }
    const id = asset.id;
    const current = authManager.captureSession();
    saving = true;
    try {
      const next = await updateAsset({ id, updateAssetDto: { [field]: draft.trim() || null } });
      if (current() && asset.id === id) {
        onAssetRefresh?.(next);
        close();
      }
    } catch (error) {
      if (current() && asset.id === id) {
        handleError(error, $t('frameleaf_metadata_save_failed'));
      }
    } finally {
      saving = false;
    }
  };
</script>

{#if editing && isOwner}
  <form onsubmit={save}>
    <label class="sr-only" for={inputId}>{label}</label>
    <input
      id={inputId}
      bind:this={input}
      bind:value={draft}
      maxlength="500"
      disabled={saving}
      onkeydown={(event) => {
        if (event.key === 'Escape' && !saving) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    />
    <div class="actions">
      <Button disabled={saving} onclick={close}>{$t('cancel')}</Button>
      <Button type="submit" disabled={saving}>{$t('save')}</Button>
    </div>
  </form>
{:else if isOwner}
  <button
    class="field"
    type="button"
    bind:this={trigger}
    aria-label={label}
    onclick={() => {
      draft = value;
      editing = true;
      queueMicrotask(() => input?.focus());
    }}
  >
    <span>{value || '—'}</span><Icon icon={mdiPencilOutline} size="1rem" aria-hidden={true} />
  </button>
{:else}
  <p class="value">{value || '—'}</p>
{/if}

<style>
  .field,
  .value,
  form {
    width: 100%;
    text-align: start;
    overflow-wrap: anywhere;
  }
  .field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-height: 2.75rem;
  }
  input {
    width: 100%;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-block-start: 0.5rem;
  }
</style>
