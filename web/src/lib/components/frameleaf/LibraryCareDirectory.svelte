<script lang="ts">
  import type { Translations } from 'svelte-i18n';
  /**
   * Library Care: the Utilities directory the rail's Library Care entry opens (FL-69).
   *
   * Ported from the September 22, 2026 prototype, where Library Care opens Settings → Utilities:
   * the repair queues first (the command center's "repairs" grid), then every utility grouped as
   * Organize, Repair, Import, Automate and Connect with the prototype's descriptions. The queue
   * counts are the server's (`getSummary`), read with the reader's own privacy: another account's
   * Locked media is never counted, and the reader's own only in an unlocked session.
   *
   * Missing media and Damaged media stay administrator tools, as the prototype marks them.
   * Preservation verification (FL-74) is every account's own, like the prototype's Library Care row.
   */
  import { OpenQueryParam } from '$lib/constants';
  import { careQueues, CARE_TOOL_GROUPS, type CareQueue, type CareToolGroup } from '$lib/frameleaf/library-care';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import type { MediaHealthSummaryResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiArchiveLockOutline,
    mdiChevronRight,
    mdiCloudOutline,
    mdiCompare,
    mdiDevices,
    mdiDownload,
    mdiFolderSearchOutline,
    mdiHarddisk,
    mdiMapMarker,
    mdiMovieOpenOutline,
    mdiShieldCheckOutline,
    mdiTuneVariant,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let { summary }: { summary: MediaHealthSummaryResponseDto | null } = $props();

  const isAdmin = $derived(authManager.user.isAdmin);

  type Tool = {
    id: string;
    group: CareToolGroup;
    icon: string;
    titleKey: Translations;
    descriptionKey: Translations;
    href: string;
    adminOnly?: boolean;
  };

  const TOOLS: Tool[] = [
    {
      id: 'duplicates',
      group: 'organize',
      icon: mdiCompare,
      titleKey: 'library_care_tool_duplicates',
      descriptionKey: 'library_care_tool_duplicates_description',
      href: Route.duplicatesUtility(),
    },
    {
      id: 'large-files',
      group: 'organize',
      icon: mdiHarddisk,
      titleKey: 'library_care_tool_large_files',
      descriptionKey: 'library_care_tool_large_files_description',
      href: Route.largeFileUtility(),
    },
    {
      id: 'geolocation',
      group: 'organize',
      icon: mdiMapMarker,
      titleKey: 'library_care_tool_geolocation',
      descriptionKey: 'library_care_tool_geolocation_description',
      href: Route.geolocationUtility(),
    },
    {
      id: 'live-photos',
      group: 'repair',
      icon: mdiMovieOpenOutline,
      titleKey: 'library_care_tool_live_photos',
      descriptionKey: 'library_care_tool_live_photos_description',
      href: Route.livePhotosUtility(),
    },
    {
      id: 'missing-media',
      group: 'repair',
      icon: mdiFolderSearchOutline,
      titleKey: 'library_care_tool_missing',
      descriptionKey: 'library_care_tool_missing_description',
      href: Route.missingMediaUtility(),
      adminOnly: true,
    },
    {
      id: 'corrupt-media',
      group: 'repair',
      icon: mdiShieldCheckOutline,
      titleKey: 'library_care_tool_damaged',
      descriptionKey: 'library_care_tool_damaged_description',
      href: Route.corruptMediaUtility(),
      adminOnly: true,
    },
    {
      id: 'icloud',
      group: 'import',
      icon: mdiCloudOutline,
      titleKey: 'library_care_tool_icloud',
      descriptionKey: 'library_care_tool_icloud_description',
      href: Route.icloudSyncUtility(),
    },
    {
      // FL-74: the prototype's Library Care row "Preservation verification". Packages live in
      // Settings → Import & protection → Originals & preservation, where this opens.
      id: 'preservation',
      group: 'import',
      icon: mdiArchiveLockOutline,
      titleKey: 'frameleaf_preservation_care_link',
      descriptionKey: 'library_care_tool_preservation_description',
      href: Route.userSettings({ isOpen: OpenQueryParam.PRESERVATION }),
    },
    {
      id: 'workflows',
      group: 'automate',
      icon: mdiTuneVariant,
      titleKey: 'library_care_tool_workflows',
      descriptionKey: 'library_care_tool_workflows_description',
      href: Route.workflows(),
    },
    {
      id: 'downloads',
      group: 'connect',
      icon: mdiDevices,
      titleKey: 'library_care_tool_downloads',
      descriptionKey: 'library_care_tool_downloads_description',
      href: Route.downloadsUtility(),
    },
    {
      id: 'obtainium',
      group: 'connect',
      icon: mdiDownload,
      titleKey: 'library_care_tool_obtainium',
      descriptionKey: 'library_care_tool_obtainium_description',
      href: Route.obtainiumUtility(),
    },
  ];

  const QUEUE_HREF: Record<CareQueue['id'], string | undefined> = {
    missing: Route.missingMediaUtility(),
    damaged: Route.corruptMediaUtility(),
    duplicates: Route.duplicatesUtility(),
    import: Route.icloudSyncUtility(),
    enrichment: undefined,
  };

  const queues = $derived(careQueues(summary).filter((queue) => isAdmin || !queue.adminOnly));
  const tools = $derived(TOOLS.filter((tool) => isAdmin || !tool.adminOnly));
</script>

<div class="directory">
  <p class="lede">{$t('library_care_description')}</p>

  <section aria-labelledby="library-care-queues">
    <h2 id="library-care-queues">{$t('library_care_repair_queues')}</h2>
    <div class="queues">
      {#each queues as queue (queue.id)}
        {@const href = QUEUE_HREF[queue.id]}
        <svelte:element this={href ? 'a' : 'div'} class="queue" {href}>
          <strong>{$t(queue.labelKey)}</strong>
          <span class="count">
            {queue.count === null ? $t('library_care_count_unavailable') : queue.count.toLocaleString()}
          </span>
          <span class="detail">
            {$t(queue.descriptionKey)}
            {#if queue.ready}
              · {$t('library_care_queue_ready', { values: { count: queue.ready } })}
            {/if}
          </span>
          {#if href}
            <Icon icon={mdiChevronRight} size="1.125rem" aria-hidden={true} />
          {/if}
        </svelte:element>
      {/each}
    </div>
  </section>

  {#each CARE_TOOL_GROUPS as group (group)}
    {@const groupTools = tools.filter((tool) => tool.group === group)}
    {#if groupTools.length > 0}
      <section aria-labelledby={`library-care-${group}`}>
        <h2 id={`library-care-${group}`}>{$t(`library_care_group_${group}`)}</h2>
        <ul class="tools">
          {#each groupTools as tool (tool.id)}
            <li>
              <a class="tool" href={tool.href}>
                <Icon icon={tool.icon} size="1.375rem" aria-hidden={true} />
                <span>
                  <strong>{$t(tool.titleKey)}</strong>
                  <small>{$t(tool.descriptionKey)}</small>
                </span>
                <Icon icon={mdiChevronRight} size="1.125rem" aria-hidden={true} />
              </a>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/each}
</div>

<style>
  .directory {
    display: grid;
    gap: 1.25rem;
    color: var(--fl-text);
    font-size: var(--fl-font-size, 0.875rem);
  }
  .lede {
    margin: 0;
    color: var(--fl-muted);
  }
  section {
    display: grid;
    gap: 0.5rem;
  }
  h2 {
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 0.75rem);
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .queues {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(15rem, 100%), 1fr));
    gap: 0.625rem;
  }
  .queue {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.125rem 0.5rem;
    padding: 0.75rem;
    color: inherit;
    text-decoration: none;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  a.queue:hover,
  .tool:hover {
    background: color-mix(in srgb, var(--fl-panel), var(--fl-text) 5%);
  }
  a.queue:focus-visible,
  .tool:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .queue strong {
    grid-column: 1;
  }
  .queue .count {
    grid-column: 1;
    font-size: 1.375rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .queue .detail {
    grid-column: 1;
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 0.75rem);
  }
  .queue :global(svg) {
    grid-column: 2;
    grid-row: 1 / span 3;
    color: var(--fl-muted);
  }
  .tools {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    overflow: hidden;
  }
  .tools li + li {
    border-top: 1px solid var(--fl-border);
  }
  .tool {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem 0.875rem;
    color: inherit;
    text-align: left;
    text-decoration: none;
    background: transparent;
    border: 0;
    font: inherit;
    cursor: pointer;
  }
  .tool > span {
    display: grid;
    gap: 0.125rem;
    flex: 1;
    min-width: 0;
  }
  .tool small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 0.75rem);
  }
  .tool :global(svg:first-child) {
    color: var(--fl-teal-text, var(--fl-teal));
  }
  .tool :global(svg:last-child) {
    color: var(--fl-muted);
  }
</style>
