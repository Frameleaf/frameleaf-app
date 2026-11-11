<script lang="ts">
  /**
   * Where an item came from (approved Boards prototype `Inspector` source facts, README point 27):
   * "Saved with", the Page (title and site), Creator, Licence, the original image address with the
   * note that only the owner sees it, and when it was Added.
   *
   * Saved sources are private to the owner, so they are only read when `canRead`; anyone else sees
   * when the item was added and nothing about where it was saved from. A saved source came in
   * through the browser extension, an Eagle import, or a Boards media download. Any other item
   * was uploaded. Stored links are untrusted and only http(s) addresses
   * become links.
   */
  import { getAssetSources, type AssetSourceResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiDownloadOutline, mdiFolderZipOutline, mdiPuzzleOutline, mdiTrayArrowUp } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { locale, t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { libraryReferenceUrl } from '$lib/frameleaf/library-reference';

  let {
    assetId,
    canRead = false,
    added,
    headingClass = '',
    given,
    fallbackVia,
  }: {
    assetId: string;
    canRead?: boolean;
    /** When the item was added to the library (ISO date). */
    added?: string;
    /** Lets a host panel give the heading its own label style. */
    headingClass?: string;
    /** Sources the host already has (a saved link's own `source`); nothing is read for `assetId`. */
    given?: AssetSourceResponseDto[];
    /** "Saved with" when no source says otherwise (a saved link: "Save a link", not "Upload"). */
    fallbackVia?: { icon: string; label: string };
  } = $props();
  const headingId = $props.id();
  let sources = $state<AssetSourceResponseDto[]>([]);
  let loading = $state(false);
  let failed = $state(false);
  let generation = $state(0);
  $effect(() => {
    const id = assetId;
    const version = generation;
    sources = [];
    failed = false;
    loading = false;
    if (given) {
      sources = canRead ? [...given].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)) : [];
      return;
    }
    if (!canRead) {
      return;
    }
    const controller = new AbortController();
    loading = true;
    void getAssetSources({ id }, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted && canRead && assetId === id && generation === version) {
          sources = [...value].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && canRead && assetId === id && generation === version) {
          failed = true;
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && assetId === id && generation === version) {
          loading = false;
        }
      });
    return () => controller.abort();
  });
  onDestroy(
    onLibraryAccessChange(() => {
      sources = [];
      generation++;
    }),
  );

  const formatDate = (value: string) =>
    new Date(value).toLocaleDateString($locale ?? undefined, { dateStyle: 'medium' });
  /** A link's site and path without the scheme, for a licence or page shown as plain text. */
  const shortUrl = (href: string) => {
    const url = new URL(href);
    return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
  };
  const savedWith = $derived(
    sources.some((source) => !source.importedFrom && !source.provider)
      ? { icon: mdiPuzzleOutline, label: $t('frameleaf_boards_source_via_extension') }
      : sources.some((source) => source.importedFrom === 'eagle')
        ? { icon: mdiDownloadOutline, mdiFolderZipOutline, label: $t('frameleaf_boards_source_via_eagle') }
        : (fallbackVia ?? { icon: mdiTrayArrowUp, label: $t('frameleaf_boards_source_via_upload') }),
  );
</script>

{#if canRead || added}
  <section class="fl-asset-sources" aria-labelledby={headingId} aria-busy={loading}>
    <h3 id={headingId} class={headingClass}>{$t('frameleaf_boards_source')}</h3>
    {#if loading}<p role="status">{$t('loading')}</p>
    {:else if failed}
      <p role="status">{$t('frameleaf_sources_unavailable')}</p>
      <Button onclick={() => generation++}>{$t('retry')}</Button>
    {:else}
      <dl>
        {#if canRead}
          <dt>{$t('frameleaf_boards_source_saved_with')}</dt>
          <dd class="via">
            <Icon icon={savedWith.icon} size="15" aria-hidden />
            {savedWith.label}
          </dd>
        {/if}
        {#each sources as source (source.id)}
          {@const pageUrl = libraryReferenceUrl(source.pageUrl)}
          {@const mediaUrl = source.provider ? undefined : libraryReferenceUrl(source.mediaUrl)}
          {@const licenseUrl = libraryReferenceUrl(source.licenseUrl)}
          {#if pageUrl || source.title}
            <dt>{$t('frameleaf_boards_source_page')}</dt>
            <dd>
              {#if pageUrl}<a href={pageUrl} target="_blank" rel="noopener noreferrer">{source.title || pageUrl}</a>
                <small>{new URL(pageUrl).hostname}</small>
              {:else}{source.title}{/if}
            </dd>
          {/if}
          {#if source.creator}
            <dt>{$t('frameleaf_boards_source_creator')}</dt>
            <dd>{source.creator}</dd>
          {/if}
          {#if source.provider}
            <dt>{$t('frameleaf_boards_source_provider')}</dt>
            <dd>{source.provider}</dd>
          {/if}
          {#if source.creatorId && source.creatorId !== source.creator}
            <dt>{$t('frameleaf_boards_source_creator_id')}</dt>
            <dd>{source.creatorId}</dd>
          {/if}
          {#if source.postId}
            <dt>{$t('frameleaf_boards_source_post_id')}</dt>
            <dd>{source.postId}</dd>
          {/if}
          {#if source.attachmentId}
            <dt>{$t('frameleaf_boards_source_attachment_id')}</dt>
            <dd>{source.attachmentId}</dd>
          {/if}
          {#if source.publishedAt && Number.isFinite(Date.parse(source.publishedAt))}
            <dt>{$t('frameleaf_boards_source_published')}</dt>
            <dd><time datetime={source.publishedAt}>{formatDate(source.publishedAt)}</time></dd>
          {/if}
          {#if source.postText}
            <dt>{$t('frameleaf_boards_source_post_text')}</dt>
            <dd class="post-text">{source.postText}</dd>
          {/if}
          {#if licenseUrl}
            <dt>{$t('frameleaf_boards_source_licence')}</dt>
            <dd><a href={licenseUrl} target="_blank" rel="noopener noreferrer">{shortUrl(licenseUrl)}</a></dd>
          {/if}
          {#if mediaUrl}
            <dt>{$t('frameleaf_boards_source_image')}</dt>
            <dd>
              <a href={mediaUrl} target="_blank" rel="noopener noreferrer">{$t('frameleaf_boards_source_image_link')}</a
              >
              <small>{$t('frameleaf_boards_source_private')}</small>
            </dd>
          {/if}
          {#if source.note && source.note !== source.postText}
            <dd class="note">{source.note}</dd>
          {/if}
        {/each}
        {#if added || sources[0]}
          <dt>{$t('frameleaf_boards_source_added')}</dt>
          <dd>
            <time datetime={added ?? sources[0].capturedAt}>{formatDate(added ?? sources[0].capturedAt)}</time>
          </dd>
        {/if}
      </dl>
    {/if}
  </section>
{/if}

<style>
  .fl-asset-sources {
    display: grid;
    min-width: 0;
    gap: var(--fl-space-2);
  }
  h3 {
    margin: 0;
    color: var(--fl-muted);
    font-size: 12px;
  }
  dl {
    display: grid;
    grid-template-columns: minmax(5.5rem, auto) 1fr;
    gap: var(--fl-space-2) var(--fl-space-3);
    margin: 0;
    font-size: var(--fl-font-small);
  }
  dt {
    color: var(--fl-muted);
  }
  dd {
    display: grid;
    gap: 2px;
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }
  dd.via {
    display: flex;
    align-items: center;
    gap: var(--fl-space-1);
  }
  dd.note {
    grid-column: 1 / -1;
  }
  dd.note,
  dd.post-text {
    white-space: pre-wrap;
  }
  a {
    color: var(--fl-accent);
    text-decoration: underline;
    text-underline-offset: 0.15em;
  }
  a:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
    border-radius: var(--fl-radius-control);
  }
  p,
  small {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
</style>
