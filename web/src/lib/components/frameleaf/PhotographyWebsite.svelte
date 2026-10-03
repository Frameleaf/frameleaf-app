<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { AssetMediaSize } from '@immich/sdk';
  import Button from './Button.svelte';
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
        error = error_ instanceof Error ? error_.message : 'Could not load studio website.';
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
      message = draft.site.enabled ? 'Studio website saved and published.' : 'Studio website saved.';
    } catch (error_) {
      if (!disposed) {
        error = error_ instanceof Error ? error_.message : 'Could not save studio website.';
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
        error = error_ instanceof Error ? error_.message : 'Could not load photographs.';
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
    message = 'Portfolio choices added to the draft. Save to publish.';
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
      <span class="phd-eyebrow">Your public studio</span>
      <h2>Studio website</h2>
      <p>A curated portfolio with your studio identity, services and contact details.</p>
    </div>
    <div class="phd-actions">
      <Button disabled={busy} onclick={reload}>Reload</Button><Button
        variant="primary"
        disabled={busy || !draft}
        onclick={save}>Save website</Button
      >
    </div>
  </div>
  {#if error}<div class="phw-notice" role="alert">{error}</div>{/if}{#if message}<p role="status">{message}</p>{/if}
  {#if draft}<section class="phd-card">
      <div class="phd-row">
        <label><input type="checkbox" bind:checked={draft.site.enabled} />Publish studio website</label
        >{#if stored?.site.enabled && siteUrl}<a href={siteUrl} target="_blank" rel="noopener">Open studio website ↗</a
          >{/if}
      </div>
      <label>Website title<input required maxlength="200" bind:value={draft.site.title} /></label>
      <div class="phd-fields">
        <label>About<textarea rows="6" maxlength="10000" bind:value={draft.site.about}></textarea></label><label
          >Services<textarea rows="6" maxlength="10000" bind:value={draft.site.services}></textarea></label
        ><label
          >Contact introduction<textarea rows="6" maxlength="5000" bind:value={draft.site.contact}></textarea></label
        >
      </div>
      <div class="phd-fields">
        <label
          >Layout<select bind:value={draft.site.presentation.layout}
            ><option value="editorial">Editorial</option><option value="grid">Portfolio grid</option><option
              value="slideshow">Slideshow</option
            ></select
          ></label
        ><label
          >Typography<select bind:value={draft.site.presentation.font}
            ><option value="editorial">Editorial serif</option><option value="modern">Modern sans</option><option
              value="script">Studio script</option
            ></select
          ></label
        ><label
          >Palette<select bind:value={draft.site.presentation.palette}
            ><option value="studio">Studio colours</option><option value="ivory">Ivory</option><option value="charcoal"
              >Charcoal</option
            ></select
          ></label
        ><label
          >Spacing<select bind:value={draft.site.presentation.spacing}
            ><option value="compact">Compact</option><option value="comfortable">Comfortable</option><option
              value="airy">Airy</option
            ></select
          ></label
        >
      </div>
    </section>
    <section class="phd-card">
      <h3>Choose portfolio photographs</h3>
      <p>Use approved versions already published in a project. Portfolio inclusion makes these photographs public.</p>
      <label
        >Project<select value={project} onchange={(event) => loadProject(event.currentTarget.value)}
          ><option value="">Choose a project</option
          >{#each shoots.filter((shoot) => !shoot.unavailable) as shoot (shoot.id)}<option value={shoot.id}
              >{shoot.name}</option
            >{/each}</select
        ></label
      >{#if workflow}<div class="phd-portfolio-choices">
          {#each options as capture (capture.id)}<label
              >{#if capture.assetId}<img
                  src={getAssetMediaUrl({ id: capture.assetId, size: AssetMediaSize.Thumbnail })}
                  alt={`Photo ${capture.number}`}
                  loading="lazy"
                />{/if}<span
                ><input
                  type="checkbox"
                  checked={chosen.includes(capture.id)}
                  onchange={(event) =>
                    (chosen = event.currentTarget.checked
                      ? [...chosen, capture.id]
                      : chosen.filter((id) => id !== capture.id))}
                />Photo {capture.number}</span
              ></label
            >{:else}<p>Approve edited versions and publish this project before adding photographs.</p>{/each}
        </div>{/if}<label
        ><input type="checkbox" bind:checked={consent} />I have permission to display these photographs in the public
        portfolio.</label
      ><Button
        disabled={busy || chosen.length === 0 || !consent || draft.site.portfolio.length + chosen.length > 200}
        onclick={include}>Add to portfolio draft</Button
      >
    </section>
    <section class="phd-card">
      <h3>Portfolio sequence</h3>
      {#each draft.site.portfolio as item, index (`${item.shootId}:${item.captureId}`)}<div class="phd-row phd-order">
          <span
            >{index + 1}. {shoots.find((shoot) => shoot.id === item.shootId)?.name ?? 'Project'} · {item.captureId.slice(
              0,
              8,
            )}</span
          >
          <div class="phd-actions">
            <Button
              disabled={busy || index === 0}
              label="Move portfolio photograph earlier"
              onclick={() => move(index, -1)}>↑</Button
            ><Button
              disabled={busy || index === draft!.site.portfolio.length - 1}
              label="Move portfolio photograph later"
              onclick={() => move(index, 1)}>↓</Button
            ><Button disabled={busy} onclick={() => draft!.site.portfolio.splice(index, 1)}>Remove</Button>
          </div>
        </div>{:else}<p>No photographs included yet.</p>{/each}
    </section>
  {:else}<p role="status">{busy ? 'Loading website…' : 'Reload to retry.'}</p>{/if}
</div>
