<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Button from './Button.svelte';
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
        error = error_ instanceof Error ? error_.message : 'Could not load studio presets.';
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
      name: proof ? 'Repeated proof' : 'Web signature',
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
      message = 'Studio presets saved';
    } catch (error_) {
      if (!disposed) {
        error = error_ instanceof Error ? error_.message : 'Could not save studio presets.';
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
      <span class="phd-eyebrow">Studio branding</span>
      <h2>Watermarks</h2>
      <p>Reusable text and logo compositions, with independent defaults for proofs, web previews and exports.</p>
    </div>
    <div class="phd-actions">
      <Button disabled={busy} onclick={reload}>Reload</Button><Button
        variant="primary"
        disabled={busy || !draft || missingLogos.length > 0}
        onclick={save}>Save studio presets</Button
      >
    </div>
  </div>
  {#if error}<div class="phw-notice" role="alert">{error}</div>{/if}{#if message}<p role="status">{message}</p>{/if}
  {#if missingLogos.length}<p class="phw-notice" role="alert">
      Choose a replacement logo or remove the logo from these presets before saving: {missingLogos
        .map((item) => item.name)
        .join(', ')}.
    </p>{/if}
  {#if draft}<section class="phd-card">
      <div class="phd-row">
        <label
          >Preset<select bind:value={active}
            ><option value="">Choose a preset</option
            >{#each draft.brand.watermarkPresets ?? [] as item (item.id)}<option value={item.id}
                >{item.name} · v{item.version}</option
              >{/each}</select
          ></label
        >
        <div class="phd-actions">
          <Button disabled={busy || (draft.brand.watermarkPresets?.length ?? 0) >= 30} onclick={() => add()}
            >New signature</Button
          ><Button disabled={busy || (draft.brand.watermarkPresets?.length ?? 0) >= 30} onclick={() => add(true)}
            >New repeated proof</Button
          ><Button disabled={busy || !preset} onclick={remove}>Remove preset</Button>
        </div>
      </div>
      {#if preset}<label>Preset name<input maxlength="100" required bind:value={preset.name} /></label
        >{#key preset.id}<PhotographyWatermarkEditor bind:value={preset.watermark} disabled={busy} />{/key}{:else}<p>
          Create a preset to design your studio’s signature or proof pattern.
        </p>{/if}
    </section>
    <section class="phd-card">
      <h3>Defaults for new collections</h3>
      <div class="phd-fields">
        {#each [['webWatermarkPresetId', 'Edited web previews'], ['proofWatermarkPresetId', 'Selection proofs'], ['exportWatermarkPresetId', 'Final exports']] as [key, label] (key)}<label
            >{label}<select
              value={draft.brand[key as 'webWatermarkPresetId']}
              onchange={(event) => (draft!.brand[key as 'webWatermarkPresetId'] = event.currentTarget.value || null)}
              ><option value=""
                >{key === 'exportWatermarkPresetId' ? 'Clean edited photograph' : 'Collection default'}</option
              >{#each draft.brand.watermarkPresets ?? [] as item (item.id)}<option value={item.id}
                  >{item.name} · v{item.version}</option
                >{/each}</select
            ></label
          >{/each}
      </div>
      <p>
        Existing collections retain their saved watermark. Apply the new preset and republish a collection to change its
        web images.
      </p>
    </section>
  {:else}<p role="status">{busy ? 'Loading studio presets…' : 'Reload to try again.'}</p>{/if}
</div>
