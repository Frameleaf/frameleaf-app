<script lang="ts">
  import {
    cameraCandidateLabel,
    cameraCandidateConflicts,
    parseCameraIdentification,
    type CameraIdentification,
  } from '$lib/frameleaf/camera-identification';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAssetMetadata, type AssetResponseDto } from '@frameleaf/sdk';
  import { Text } from '@frameleaf/ui';
  import { t } from 'svelte-i18n';

  let { asset, isOwner }: { asset: AssetResponseDto; isOwner: boolean } = $props();
  const canRead = $derived(isOwner && !authManager.isSharedLink);
  let evidence = $state<CameraIdentification | null>(null);
  let failed = $state(false);
  let attempt = $state(0);

  $effect(() => {
    const id = asset.id;
    const allowed = canRead;
    const requestAttempt = attempt;
    evidence = null;
    failed = false;
    if (!allowed) {
      return;
    }
    const controller = new AbortController();
    getAssetMetadata({ id }, { signal: controller.signal })
      .then((items) => {
        if (!controller.signal.aborted && asset.id === id && canRead && attempt === requestAttempt) {
          evidence = parseCameraIdentification(items.find((item) => item.key === 'camera-identification')?.value);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && asset.id === id && canRead && attempt === requestAttempt) {
          failed = true;
        }
      });
    return () => controller.abort();
  });
</script>

{#if canRead && (failed || (evidence && (evidence.recorded || evidence.alternatives.length > 0 || evidence.suggestion)))}
  <section class="px-4 pt-4 text-sm" data-testid="camera-identification">
    {#if failed}
      <p role="status">{$t('frameleaf_camera_evidence_failed')}</p>
      <button type="button" class="mt-1 underline hover:text-primary" onclick={() => attempt++}>{$t('retry')}</button>
    {:else if evidence}
      {#if evidence.recorded || evidence.alternatives.length > 0}
        <details>
          <summary class="cursor-pointer text-xs text-gray-500 dark:text-gray-400"
            >{$t('frameleaf_camera_evidence')}</summary
          >
          <div class="mt-3 flex flex-col gap-3 wrap-break-word">
            {#if evidence.recorded}
              <div>
                <Text color="muted" size="small">{$t('frameleaf_camera_recorded')}</Text>
                <p>{cameraCandidateLabel(evidence.recorded)}</p>
                <p class="text-xs text-gray-500 dark:text-gray-400">
                  {$t(
                    evidence.recorded.source === 'original' ? 'frameleaf_camera_original' : 'frameleaf_camera_sidecar',
                  )}
                  · {[evidence.recorded.makeTag, evidence.recorded.modelTag].filter(Boolean).join(', ')}
                </p>
              </div>
            {/if}
            {#each evidence.alternatives as alternative, index (JSON.stringify( [alternative.source, alternative.makeTag, alternative.modelTag, alternative.make, alternative.model, index] ))}
              <div>
                <Text color="muted" size="small"
                  >{$t(
                    cameraCandidateConflicts(evidence.recorded, alternative)
                      ? 'frameleaf_camera_conflict'
                      : 'frameleaf_camera_alternative',
                  )}</Text
                >
                <p>{cameraCandidateLabel(alternative)}</p>
                <p class="text-xs text-gray-500 dark:text-gray-400">
                  {$t(alternative.source === 'original' ? 'frameleaf_camera_original' : 'frameleaf_camera_sidecar')}
                  · {[alternative.makeTag, alternative.modelTag].filter(Boolean).join(', ')}
                </p>
              </div>
            {/each}
          </div>
        </details>
      {/if}
      {#if evidence.suggestion}
        <div class="mt-3">
          <Text color="muted" size="small">{$t('frameleaf_info_enrichment')}</Text>
          <details class="mt-2">
            <summary class="cursor-pointer">{$t('frameleaf_camera_encoding_matches')}</summary>
            <p class="mt-2 wrap-break-word">{evidence.suggestion.matches ?? $t('frameleaf_camera_encoding_unknown')}</p>
            <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">{$t('frameleaf_camera_encoding_caveat')}</p>
            <code class="mt-2 block text-xs break-all">{evidence.suggestion.signature}</code>
          </details>
        </div>
      {/if}
    {/if}
  </section>
{/if}
