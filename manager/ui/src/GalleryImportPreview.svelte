<script lang="ts">
  // FL-1742: what a Noodle Gallery import brings across and leaves behind (frameleaf-prototype
  // GalleryImportPreview.jsx, gallery-import-preview.css). "review" sits under the installation's facts;
  // "ready" is the short reminder before the switch and "done" the result once the server is ready.
  import Icon from './Icon.svelte';
  import {
    GALLERY_INTRO,
    GALLERY_KEPT,
    GALLERY_SPACES_NOTE,
    galleryNumber,
    galleryReview,
    gallerySummary,
    type GalleryData,
  } from './gallery-preview';
  let {
    gallery,
    version = '',
    mode = 'review',
    busy = false,
    oncheck,
  }: { gallery: GalleryData; version?: string; mode?: 'review' | 'ready' | 'done'; busy?: boolean; oncheck?: () => void } = $props();
  const review = $derived(mode === 'review' ? galleryReview(gallery, version) : null);
  const summary = $derived(mode === 'review' ? null : gallerySummary(gallery, mode === 'done'));
</script>

{#snippet title()}
  <h2 id="gip-title">What Noodle Gallery adds <span class="gip-beta">Beta</span></h2>
{/snippet}
{#snippet leftOut(items: { kind: string; title: string; detail: string }[])}
  {#each items as item (item.kind)}
    <p class="gip-warn" role="status"><Icon name="alert-circle" /><span><strong>{item.title}</strong> {item.detail}</span></p>
  {/each}
{/snippet}

{#if review?.state === 'unreadable'}
  <section class="gip gip-problem" role="status">
    <Icon name="alert-circle" />
    <div><h2>{review.title}</h2><p>{review.detail}</p></div>
    <button class="button quiet" disabled={busy} onclick={() => oncheck?.()}>Check again</button>
  </section>
{:else if review?.state === 'plain'}
  <section class="gip" aria-labelledby="gip-title">
    <header>{@render title()}</header>
    <div class="gip-none"><Icon name="check-circle" /><div><strong>{review.title}</strong><p>{review.detail}</p></div></div>
  </section>
{:else if review}
  <section class="gip" aria-labelledby="gip-title">
    <header>{@render title()}<p>{GALLERY_INTRO}</p></header>
    {#if review.carried.length}
      <h3>Comes across</h3>
      <ul class="gip-carried">
        {#each review.carried as item (item.kind)}
          <li><Icon name={item.icon} /><strong>{galleryNumber(item.value)}</strong><span>{item.name}</span><small>{item.detail}</small></li>
        {/each}
      </ul>
    {/if}
    {#if review.spaces.length}
      <details class="gip-spaces">
        <summary><Icon name="chevron" />{review.spacesTitle}</summary>
        <ul>
          {#each review.spaces as space, index (index)}
            <li><span class="gip-space-icon"><Icon name="group" /></span><strong>{space.name}</strong><span>{space.detail}</span></li>
          {/each}
        </ul>
        <p>{review.moreSpaces ? `And ${galleryNumber(review.moreSpaces)} more. ` : ''}{GALLERY_SPACES_NOTE}</p>
      </details>
    {/if}
    {@render leftOut(review.leftOut)}
    {#if review.behind.length}
      <h3>Stays behind</h3>
      <ul class="gip-behind">
        {#each review.behind as item (item.name)}
          <li><Icon name="minus-circle" /><div><strong>{item.name}</strong><p>{item.detail}</p></div></li>
        {/each}
      </ul>
    {/if}
    <p class="gip-kept"><Icon name="shield" />{GALLERY_KEPT}</p>
  </section>
{:else if summary}
  <section class="gip gip-summary" aria-label="From Noodle Gallery">
    {#if summary.carried.length}
      <h3>{summary.carriedTitle}</h3>
      <ul class="gip-chips">
        {#each summary.carried as item (item.kind)}
          <li><Icon name={item.icon} /><strong>{item.value}</strong> {item.name}</li>
        {/each}
      </ul>
    {/if}
    {@render leftOut(summary.leftOut)}
    {#if summary.behind}
      <h3>{summary.behindTitle}</h3>
      <p class="gip-behind-short">{summary.behind}</p>
    {/if}
    {#if summary.kept}<p class="gip-kept"><Icon name="shield" />{summary.kept}</p>{/if}
  </section>
{/if}
