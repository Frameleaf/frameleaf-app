<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import Button from './Button.svelte';
  import { photographyErrorKey } from './PhotographyStatus.svelte';
  import PhotographyWatermarkEditor from './PhotographyWatermarkEditor.svelte';
  import { loadBrand, saveBrand, type Branding } from '$lib/frameleaf/photography/api';
  import { defaultWatermark } from '$lib/frameleaf/photography/workflow-api';
  let draft = $state<Branding | null>(null);
  let active = $state('');
  let busy = $state(false);
  let error = $state('');
  let message = $state('');
  let disposed = false;
  const preset = $derived(draft?.brand.watermarkPresets?.find((item) => item.id === active));
  const missingLogos = $derived(
    draft?.brand.watermarkPresets?.filter((item) => item.watermark.type !== 'text' && !item.watermark.logoAssetId) ??
      [],
  );
  async function reload() {
    busy = true;
    error = '';
    try {
      const result = await loadBrand();
      if (disposed) {
        return;
      }
      draft = { ...result, brand: { ...result.brand, watermarkPresets: result.brand.watermarkPresets ?? [] } };
      active = draft.brand.watermarkPresets?.[0]?.id ?? '';
    } catch (error_) {
      if (!disposed) {
        error = $t(photographyErrorKey(error_));
      }
    } finally {
      if (!disposed) {
        busy = false;
      }
    }
  }
  function add(proof = false) {
    if (!draft || (draft.brand.watermarkPresets?.length ?? 0) >= 30) {
      return;
    }
    const id = crypto.randomUUID();
    draft.brand.watermarkPresets!.push({
      id,
      name: proof ? $t('frameleaf_photography_preset_proof_name') : $t('frameleaf_photography_preset_signature_name'),
      version: 1,
      watermark: defaultWatermark(draft.brand.name, proof),
    });
    active = id;
    message = '';
  }
  async function save() {
    if (!draft || busy) {
      return;
    }
    busy = true;
    error = '';
    message = '';
    try {
      const result = await saveBrand(draft.revision, $state.snapshot(draft.brand));
      if (disposed) {
        return;
      }
      draft = result;
      message = $t('frameleaf_photography_watermark_presets_saved');
    } catch (error_) {
      if (!disposed) {
        error = $t(photographyErrorKey(error_));
      }
    } finally {
      if (!disposed) {
        busy = false;
      }
    }
  }
  function remove() {
    if (!draft || !preset) {
      return;
    }
    for (const role of ['webWatermarkPresetId', 'proofWatermarkPresetId', 'exportWatermarkPresetId'] as const) {
      if (draft.brand[role] === active) {
        draft.brand[role] = null;
      }
    }
    draft.brand.watermarkPresets = draft.brand.watermarkPresets!.filter((item) => item.id !== active);
    active = draft.brand.watermarkPresets[0]?.id ?? '';
  }
  onMount(() => {
    void reload();
  });
  onDestroy(() => {
    disposed = true;
  });
</script>

<div class="phd" aria-busy={busy}>
  <div class="phd-toolbar">
    <div>
      <span class="phd-eyebrow">{$t('frameleaf_photography_studio_branding')}</span>
      <h2>{$t('frameleaf_photography_watermarks')}</h2>
      <p>{$t('frameleaf_photography_watermarks_body')}</p>
    </div>
    <div class="phd-actions">
      <Button disabled={busy} onclick={reload}>{$t('frameleaf_photography_reload')}</Button><Button
        variant="primary"
        disabled={busy || !draft || missingLogos.length > 0}
        onclick={save}>{$t('frameleaf_photography_save_watermark_presets')}</Button
      >
    </div>
  </div>
  {#if error}<div class="phw-notice" role="alert">{error}</div>{/if}{#if message}<p role="status">{message}</p>{/if}
  {#if missingLogos.length}<p class="phw-notice" role="alert">
      {$t('frameleaf_photography_missing_logos', {
        values: { names: missingLogos.map((item) => item.name).join(', ') },
      })}
    </p>{/if}
  {#if draft}<section class="phd-card">
      <div class="phd-row">
        <label
          >{$t('frameleaf_photography_preset')}<select bind:value={active}
            ><option value="">{$t('frameleaf_photography_choose_preset')}</option
            >{#each draft.brand.watermarkPresets ?? [] as item (item.id)}<option value={item.id}
                >{item.name} · v{item.version}</option
              >{/each}</select
          ></label
        >
        <div class="phd-actions">
          <Button disabled={busy || (draft.brand.watermarkPresets?.length ?? 0) >= 30} onclick={() => add()}
            >{$t('frameleaf_photography_new_signature')}</Button
          ><Button disabled={busy || (draft.brand.watermarkPresets?.length ?? 0) >= 30} onclick={() => add(true)}
            >{$t('frameleaf_photography_new_proof')}</Button
          ><Button disabled={busy || !preset} onclick={remove}>{$t('frameleaf_photography_remove_preset')}</Button>
        </div>
      </div>
      {#if preset}<label
          >{$t('frameleaf_photography_preset_name')}<input maxlength="100" required bind:value={preset.name} /></label
        >{#key preset.id}<PhotographyWatermarkEditor bind:value={preset.watermark} disabled={busy} />{/key}{:else}<p>
          {$t('frameleaf_photography_create_preset_hint')}
        </p>{/if}
    </section>
    <section class="phd-card">
      <h3>{$t('frameleaf_photography_defaults_title')}</h3>
      <div class="phd-fields">
        {#each [['webWatermarkPresetId', $t('frameleaf_photography_web_previews')], ['proofWatermarkPresetId', $t('frameleaf_photography_selection_proofs')], ['exportWatermarkPresetId', $t('frameleaf_photography_final_exports')]] as [key, label] (key)}<label
            >{label}<select
              value={draft.brand[key as 'webWatermarkPresetId']}
              onchange={(event) => (draft!.brand[key as 'webWatermarkPresetId'] = event.currentTarget.value || null)}
              ><option value=""
                >{key === 'exportWatermarkPresetId'
                  ? $t('frameleaf_photography_clean_edit_note')
                  : $t('frameleaf_photography_collection_default')}</option
              >{#each draft.brand.watermarkPresets ?? [] as item (item.id)}<option value={item.id}
                  >{item.name} · v{item.version}</option
                >{/each}</select
            ></label
          >{/each}
      </div>
      <p>
        {$t('frameleaf_photography_defaults_note')}
      </p>
    </section>
  {:else}<p role="status">
      {busy ? $t('frameleaf_photography_loading_presets') : $t('frameleaf_photography_reload_to_retry')}
    </p>{/if}
</div>
