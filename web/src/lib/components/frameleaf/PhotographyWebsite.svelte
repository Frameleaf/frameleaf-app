<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import { AssetMediaSize } from '@frameleaf/sdk';
  import Button from './Button.svelte';
  import { photographyErrorKey } from './PhotographyStatus.svelte';
  import {
    siteRequest,
    workflowRequest,
    type StudioSite,
    type Workflow,
  } from '$lib/frameleaf/photography/workflow-api';
  import { type Shoot } from '$lib/frameleaf/photography/api';
  import { getAssetMediaUrl } from '$lib/utils';
  let { shoots }: { shoots: Shoot[] } = $props();
  let stored = $state<StudioSite | null>(null);
  let draft = $state<StudioSite | null>(null);
  let project = $state('');
  let workflow = $state<Workflow | null>(null);
  let chosen = $state<string[]>([]);
  let consent = $state(false);
  let busy = $state(false);
  let error = $state('');
  let message = $state('');
  let siteUrl = $state('');
  let disposed = false;
  let generation = 0;
  const options = $derived(
    workflow?.captures.filter((capture) => capture.eligible && !capture.withheld && capture.approvedRevisionId) ?? [],
  );
  async function reload() {
    busy = true;
    error = '';
    try {
      const result = await siteRequest();
      if (disposed) {
        return;
      }
      stored = result;
      draft = structuredClone(result);
      siteUrl = result.url ?? siteUrl;
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
  async function save() {
    if (!draft || !stored || busy) {
      return;
    }
    busy = true;
    error = '';
    message = '';
    try {
      const result = await siteRequest('PUT', { expectedRevision: stored.revision, site: $state.snapshot(draft.site) });
      if (disposed) {
        return;
      }
      stored = result;
      draft = structuredClone(result);
      message = draft.site.enabled
        ? $t('frameleaf_photography_site_saved_published')
        : $t('frameleaf_photography_site_saved');
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
  async function loadProject(id: string) {
    const current = ++generation;
    project = id;
    workflow = null;
    chosen = [];
    consent = false;
    error = '';
    if (!id) {
      return;
    }
    try {
      const result = await workflowRequest<Workflow>(id);
      if (!disposed && current === generation) {
        workflow = result;
      }
    } catch (error_) {
      if (!disposed && current === generation) {
        error = $t(photographyErrorKey(error_));
      }
    }
  }
  function include() {
    if (!draft || !consent) {
      return;
    }
    for (const captureId of chosen) {
      if (draft.site.portfolio.every((item) => !(item.shootId === project && item.captureId === captureId))) {
        draft.site.portfolio.push({ shootId: project, captureId, consent: true });
      }
    }
    chosen = [];
    consent = false;
    message = $t('frameleaf_photography_site_added');
  }
  function move(index: number, direction: number) {
    if (!draft || index + direction < 0 || !draft.site.portfolio.at(index + direction)) {
      return;
    }
    const items = draft.site.portfolio;
    const item = items[index];
    items[index] = items[index + direction];
    items[index + direction] = item;
  }
  onMount(() => {
    void reload();
  });
  onDestroy(() => {
    disposed = true;
    generation++;
  });
</script>

<div class="phd" aria-busy={busy}>
  <div class="phd-toolbar">
    <div>
      <span class="phd-eyebrow">{$t('frameleaf_photography_site_eyebrow')}</span>
      <h2>{$t('frameleaf_photography_studio_website')}</h2>
      <p>{$t('frameleaf_photography_site_lead')}</p>
    </div>
    <div class="phd-actions">
      <Button disabled={busy} onclick={reload}>{$t('frameleaf_photography_reload')}</Button><Button
        variant="primary"
        disabled={busy || !draft}
        onclick={save}>{$t('frameleaf_photography_site_save')}</Button
      >
    </div>
  </div>
  {#if error}<div class="phw-notice" role="alert">{error}</div>{/if}{#if message}<p role="status">{message}</p>{/if}
  {#if draft}<section class="phd-card">
      <div class="phd-row">
        <label
          ><input type="checkbox" bind:checked={draft.site.enabled} />{$t('frameleaf_photography_site_publish')}</label
        >{#if stored?.site.enabled && siteUrl}<a href={siteUrl} target="_blank" rel="noopener"
            >{$t('frameleaf_photography_site_open')} ↗</a
          >{/if}
      </div>
      <label
        >{$t('frameleaf_photography_site_title')}<input required maxlength="200" bind:value={draft.site.title} /></label
      >
      <div class="phd-fields">
        <label
          >{$t('frameleaf_photography_site_about')}<textarea rows="6" maxlength="10000" bind:value={draft.site.about}
          ></textarea></label
        ><label
          >{$t('frameleaf_photography_site_services')}<textarea
            rows="6"
            maxlength="10000"
            bind:value={draft.site.services}></textarea></label
        ><label
          >{$t('frameleaf_photography_site_contact_intro')}<textarea
            rows="6"
            maxlength="5000"
            bind:value={draft.site.contact}></textarea></label
        >
      </div>
      <div class="phd-fields">
        <label
          >{$t('frameleaf_photography_site_layout')}<select bind:value={draft.site.presentation.layout}
            ><option value="editorial">{$t('frameleaf_photography_type_editorial')}</option><option value="grid"
              >{$t('frameleaf_photography_site_layout_grid')}</option
            ><option value="slideshow">{$t('frameleaf_photography_block_slideshow')}</option></select
          ></label
        ><label
          >{$t('frameleaf_photography_typography')}<select bind:value={draft.site.presentation.font}
            ><option value="editorial">{$t('frameleaf_photography_font_editorial')}</option><option value="modern"
              >{$t('frameleaf_photography_font_modern')}</option
            ><option value="script">{$t('frameleaf_photography_font_script')}</option></select
          ></label
        ><label
          >{$t('frameleaf_photography_palette')}<select bind:value={draft.site.presentation.palette}
            ><option value="studio">{$t('frameleaf_photography_palette_studio')}</option><option value="ivory"
              >{$t('frameleaf_photography_palette_ivory')}</option
            ><option value="charcoal">{$t('frameleaf_photography_palette_charcoal')}</option></select
          ></label
        ><label
          >{$t('frameleaf_photography_spacing')}<select bind:value={draft.site.presentation.spacing}
            ><option value="compact">{$t('frameleaf_photography_spacing_compact')}</option><option value="comfortable"
              >{$t('frameleaf_photography_spacing_comfortable')}</option
            ><option value="airy">{$t('frameleaf_photography_spacing_airy')}</option></select
          ></label
        >
      </div>
    </section>
    <section class="phd-card">
      <h3>{$t('frameleaf_photography_site_choose')}</h3>
      <p>
        {$t('frameleaf_photography_site_choose_body')}
      </p>
      <label
        >{$t('frameleaf_photography_shoot')}<select
          value={project}
          onchange={(event) => loadProject(event.currentTarget.value)}
          ><option value="">{$t('frameleaf_photography_choose_shoot')}</option
          >{#each shoots.filter((shoot) => !shoot.unavailable) as shoot (shoot.id)}<option value={shoot.id}
              >{shoot.name}</option
            >{/each}</select
        ></label
      >{#if workflow}<div class="phd-portfolio-choices">
          {#each options as capture (capture.id)}<label
              >{#if capture.assetId}<img
                  src={getAssetMediaUrl({ id: capture.assetId, size: AssetMediaSize.Thumbnail })}
                  alt={$t('frameleaf_photography_photo_number', { values: { number: capture.number } })}
                  loading="lazy"
                />{/if}<span
                ><input
                  type="checkbox"
                  checked={chosen.includes(capture.id)}
                  onchange={(event) =>
                    (chosen = event.currentTarget.checked
                      ? [...chosen, capture.id]
                      : chosen.filter((id) => id !== capture.id))}
                />{$t('frameleaf_photography_photo_number', { values: { number: capture.number } })}</span
              ></label
            >{:else}<p>{$t('frameleaf_photography_site_none_ready')}</p>{/each}
        </div>{/if}<label
        ><input type="checkbox" bind:checked={consent} />{$t('frameleaf_photography_site_consent')}</label
      ><Button
        disabled={busy || chosen.length === 0 || !consent || draft.site.portfolio.length + chosen.length > 200}
        onclick={include}>{$t('frameleaf_photography_site_add')}</Button
      >
    </section>
    <section class="phd-card">
      <h3>{$t('frameleaf_photography_site_sequence')}</h3>
      {#each draft.site.portfolio as item, index (`${item.shootId}:${item.captureId}`)}<div class="phd-row phd-order">
          <span
            >{index + 1}. {shoots.find((shoot) => shoot.id === item.shootId)?.name ?? $t('frameleaf_photography_shoot')} ·
            {item.captureId.slice(0, 8)}</span
          >
          <div class="phd-actions">
            <Button
              disabled={busy || index === 0}
              label={$t('frameleaf_photography_site_move_earlier', { values: { number: index + 1 } })}
              onclick={() => move(index, -1)}>↑</Button
            ><Button
              disabled={busy || index === draft!.site.portfolio.length - 1}
              label={$t('frameleaf_photography_site_move_later', { values: { number: index + 1 } })}
              onclick={() => move(index, 1)}>↓</Button
            ><Button disabled={busy} onclick={() => draft!.site.portfolio.splice(index, 1)}>{$t('remove')}</Button>
          </div>
        </div>{:else}<p>{$t('frameleaf_photography_site_empty')}</p>{/each}
    </section>
  {:else}<p role="status">
      {busy ? $t('frameleaf_photography_site_loading') : $t('frameleaf_photography_reload_to_retry')}
    </p>{/if}
</div>
