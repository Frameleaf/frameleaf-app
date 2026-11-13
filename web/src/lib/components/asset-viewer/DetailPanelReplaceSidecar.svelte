<script lang="ts">
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getBaseUrl, type AssetResponseDto } from '@frameleaf/sdk';
  import { Button } from '@frameleaf/ui';
  import { t } from 'svelte-i18n';

  let { asset }: { asset: AssetResponseDto } = $props();
  let open = $state(false);
  let files = $state<FileList>();
  let useFileValues = $state(false);
  let busy = $state(false);
  let status = $state<'failed' | 'invalid' | 'saved'>();
  const maxBytes = 1024 * 1024;

  const begin = () => {
    files = undefined;
    useFileValues = false;
    status = undefined;
    open = true;
  };

  const replace = async () => {
    const file = files?.[0];
    if (!file || busy) return;
    if (file.size === 0 || file.size > maxBytes || !/\.xmp$/i.test(file.name)) {
      status = 'invalid';
      return;
    }
    const current = authManager.captureSession();
    busy = true;
    status = undefined;
    try {
      const body = new FormData();
      body.set('sidecarData', file);
      body.set('useFileValues', String(useFileValues));
      const response = await fetch(`${getBaseUrl()}/assets/${asset.id}/sidecar`, { method: 'PUT', body });
      if (!current()) return;
      if (!response.ok) {
        status = response.status === 400 || response.status === 413 ? 'invalid' : 'failed';
        return;
      }
      status = 'saved';
      open = false;
    } catch {
      if (current()) status = 'failed';
    } finally {
      busy = false;
    }
  };
</script>

<Button variant="tertiary" onclick={begin}>{$t('frameleaf_xmp_replace')}</Button>
{#if status === 'saved'}<p role="status">{$t('frameleaf_xmp_saved')}</p>{/if}

<Dialog
  bind:open
  title={$t('frameleaf_xmp_replace')}
  closeLabel={$t('close')}
  onRequestClose={() => !busy && (open = false)}
>
  <div class="fields">
    <label>
      <span>{$t('frameleaf_xmp_file')}</span>
      <input type="file" accept=".xmp" bind:files disabled={busy} data-initial-focus />
    </label>
    <label class="check">
      <input type="checkbox" bind:checked={useFileValues} disabled={busy} />
      {$t('frameleaf_xmp_use_file')}
    </label>
    {#if status === 'invalid' || status === 'failed'}
      <p role="alert">{$t(status === 'invalid' ? 'frameleaf_xmp_invalid' : 'frameleaf_xmp_failed')}</p>
    {/if}
  </div>
  {#snippet actions()}
    <Button variant="secondary" disabled={busy} onclick={() => (open = false)}>{$t('cancel')}</Button>
    <Button disabled={busy || !files?.length} onclick={replace}>{$t('frameleaf_xmp_replace')}</Button>
  {/snippet}
</Dialog>

<style>
  .fields,
  label {
    display: grid;
    gap: 0.65rem;
  }
  .fields {
    gap: 1.25rem;
  }
  .check {
    display: flex;
    align-items: center;
  }
</style>
