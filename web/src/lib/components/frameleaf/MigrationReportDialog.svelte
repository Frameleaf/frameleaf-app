<script lang="ts">
  /**
   * Read-only view of an imported migration audit report (FL-75), following the design
   * template's Maintenance report viewer: a verdict, the summary the decommission decision
   * needs, and a filterable, paged list of unresolved items. It offers no action on either
   * server; closing it discards the report.
   */
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    countUnresolvedByKind,
    filterUnresolved,
    unresolvedKinds,
    type MigrationReport,
    type MigrationReportStatus,
    type UnresolvedKind,
    type UnresolvedReason,
  } from '$lib/frameleaf/migration-report';
  import type { Translations } from 'svelte-i18n';
  import { locale, t } from 'svelte-i18n';

  const PAGE_SIZE = 50;

  let { report, open = $bindable(false) }: { report: MigrationReport; open?: boolean } = $props();

  let kind = $state<UnresolvedKind | ''>('');
  let query = $state('');
  let page = $state(1);

  const statusTone: Record<MigrationReportStatus, 'teal' | 'warning' | 'blue'> = {
    pass: 'teal',
    incomplete: 'warning',
    'audit-incomplete': 'warning',
    'dry-run': 'blue',
  };
  const statusKey = (status: MigrationReportStatus) =>
    `admin.frameleaf_migration_status_${status.replaceAll('-', '_')}` as Translations;
  const reasonKey = (reason: UnresolvedReason) =>
    `admin.frameleaf_migration_reason_${reason.replaceAll('-', '_')}` as Translations;
  const kindKey = (value: UnresolvedKind) => `admin.frameleaf_migration_kind_${value}` as Translations;
  const kindsKey = (value: UnresolvedKind) => `admin.frameleaf_migration_kinds_${value}` as Translations;

  const byKind = $derived(countUnresolvedByKind(report.unresolved));
  const filtered = $derived(filterUnresolved(report.unresolved, { kind, query }));
  const pages = $derived(Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));
  const current = $derived(Math.min(page, pages));
  const visible = $derived(filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE));
  const generated = $derived(
    new Intl.DateTimeFormat($locale ?? undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(report.generatedAt),
    ),
  );

  const of = (value: number, total: number) => $t('admin.frameleaf_migration_metric_of', { values: { value, total } });
  const number = (value: number) => new Intl.NumberFormat($locale ?? undefined).format(value);

  const sections = $derived([
    {
      title: $t('admin.frameleaf_migration_section_originals'),
      rows: [
        [$t('admin.frameleaf_migration_metric_total'), number(report.assets.total)],
        [$t('admin.frameleaf_migration_metric_transferred'), of(report.assets.transferred, report.assets.total)],
        [$t('admin.frameleaf_migration_metric_verified'), of(report.assets.verified, report.assets.total)],
        [$t('admin.frameleaf_migration_metric_missing'), number(report.assets.missing)],
        [$t('admin.frameleaf_migration_metric_failed'), number(report.assets.failed)],
      ],
    },
    {
      title: $t('admin.frameleaf_migration_section_albums'),
      rows: [
        [$t('admin.frameleaf_migration_metric_complete'), of(report.albums.linked, report.albums.total)],
        [$t('admin.frameleaf_migration_metric_top_level'), number(report.albums.topLevel)],
        [$t('admin.frameleaf_migration_metric_nested'), number(report.albums.nested)],
      ],
    },
    {
      title: $t('admin.frameleaf_migration_section_tags'),
      rows: [[$t('admin.frameleaf_migration_metric_assigned'), of(report.tags.assigned, report.tags.total)]],
    },
    {
      title: $t('admin.frameleaf_migration_section_people'),
      rows: [[$t('admin.frameleaf_migration_metric_attached'), of(report.people.attached, report.people.total)]],
    },
    {
      title: $t('admin.frameleaf_migration_section_stacks'),
      rows: [[$t('admin.frameleaf_migration_metric_recreated'), of(report.stacks.created, report.stacks.total)]],
    },
    {
      title: $t('admin.frameleaf_migration_section_physical'),
      rows: [
        [$t('admin.frameleaf_migration_metric_new_uploads'), number(report.physicalReferences.newUploads)],
        [$t('admin.frameleaf_migration_metric_matched_existing'), number(report.physicalReferences.matchedExisting)],
        [
          $t('admin.frameleaf_migration_metric_live_photos'),
          of(report.physicalReferences.livePhotoPairsLinked, report.physicalReferences.livePhotoPairs),
        ],
      ],
    },
  ]);

  const setKind = (value: UnresolvedKind | '') => {
    kind = kind === value ? '' : value;
    page = 1;
  };
</script>

<Dialog title={$t('admin.frameleaf_migration_report_title')} closeLabel={$t('close')} wide bind:open>
  <div class="report">
    <div class="verdict" data-status={report.status}>
      <Badge
        value={$t(statusKey(report.status))}
        label={$t(statusKey(report.status))}
        tone={statusTone[report.status]}
      />
      <p>{$t(`${statusKey(report.status)}_description` as Translations)}</p>
    </div>
    <p class="meta">
      <span>{$t('admin.frameleaf_migration_report_generated', { values: { date: generated } })}</span>
      <span>
        {$t('admin.frameleaf_migration_report_servers', {
          values: { source: report.source, destination: report.destination },
        })}
      </span>
    </p>
    <div class="owners">
      <strong>{$t('admin.frameleaf_migration_report_owners')}</strong>
      <ul>
        {#each report.owners as owner, index (index)}
          <li>
            {$t('admin.frameleaf_migration_report_owner_row', {
              values: {
                source: owner.source ?? $t('admin.frameleaf_migration_report_owner_unknown'),
                destination: owner.destination,
              },
            })}
          </li>
        {/each}
      </ul>
    </div>

    <div class="grid">
      {#each sections as section (section.title)}
        <section aria-label={section.title}>
          <h3>{section.title}</h3>
          <dl>
            {#each section.rows as [label, value] (label)}
              <div>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            {/each}
          </dl>
        </section>
      {/each}
    </div>

    <section class="unresolved" aria-label={$t('admin.frameleaf_migration_unresolved_title')}>
      <h3>{$t('admin.frameleaf_migration_unresolved_title')}</h3>
      {#if report.unresolvedCount === 0}
        <p class="empty">{$t('admin.frameleaf_migration_unresolved_none')}</p>
      {:else}
        {#if report.unresolvedCount > report.unresolved.length}
          <p class="truncated">
            {$t('admin.frameleaf_migration_unresolved_truncated', {
              values: { shown: report.unresolved.length, total: report.unresolvedCount },
            })}
          </p>
        {/if}
        <div class="toolbar">
          <div class="filters" role="group" aria-label={$t('admin.frameleaf_migration_unresolved_filter_label')}>
            <Button pressed={kind === ''} onclick={() => setKind('')}>
              {$t('admin.frameleaf_migration_unresolved_filter_all')}
              {number(report.unresolved.length)}
            </Button>
            {#each unresolvedKinds as value (value)}
              {#if byKind[value] > 0}
                <Button pressed={kind === value} onclick={() => setKind(value)}>
                  {$t(kindsKey(value))}
                  {number(byKind[value])}
                </Button>
              {/if}
            {/each}
          </div>
          <input
            type="search"
            aria-label={$t('admin.frameleaf_migration_unresolved_search_label')}
            placeholder={$t('admin.frameleaf_migration_unresolved_search_placeholder')}
            bind:value={query}
            oninput={() => (page = 1)}
          />
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{$t('type')}</th>
                <th scope="col">{$t('name')}</th>
                <th scope="col">{$t('admin.frameleaf_migration_unresolved_reason')}</th>
              </tr>
            </thead>
            <tbody>
              {#each visible as item (`${item.kind}:${item.id}:${item.reason}`)}
                <tr>
                  <td>{$t(kindKey(item.kind))}</td>
                  <td>{item.name || item.id}</td>
                  <td>
                    {$t(reasonKey(item.reason))}
                    {#if item.detail}<small>{item.detail}</small>{/if}
                  </td>
                </tr>
              {:else}
                <tr>
                  <td colspan="3" class="empty">{$t('admin.frameleaf_migration_unresolved_search_empty')}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if pages > 1}
          <div class="pager">
            <Button disabled={current <= 1} onclick={() => (page = current - 1)}>{$t('previous')}</Button>
            <span aria-live="polite">
              {$t('admin.frameleaf_migration_unresolved_page', { values: { page: current, pages } })}
            </span>
            <Button disabled={current >= pages} onclick={() => (page = current + 1)}>{$t('next')}</Button>
          </div>
        {/if}
      {/if}
    </section>

    <p class="note">{$t('admin.frameleaf_migration_no_source_deletion')}</p>
    <div class="actions">
      <Button variant="primary" onclick={() => (open = false)}>{$t('close')}</Button>
    </div>
  </div>
</Dialog>

<style>
  .report {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-top: 1rem;
  }
  .verdict {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .verdict p,
  .meta,
  .note,
  .truncated,
  .empty {
    margin: 0;
    font-size: var(--fl-font-small);
  }
  .meta,
  .note,
  .truncated,
  .empty {
    color: var(--fl-muted);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
  }
  .owners ul {
    margin: 0.25rem 0 0;
    padding-inline-start: 1.25rem;
    font-size: var(--fl-font-small);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.75rem;
  }
  .grid section {
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    padding: 0.75rem;
  }
  h3 {
    font-size: var(--fl-font-size);
    margin: 0 0 0.5rem;
  }
  dl {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  dl div {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    font-size: var(--fl-font-small);
  }
  dt {
    color: var(--fl-muted);
  }
  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
    text-align: end;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  input[type='search'] {
    min-width: 12rem;
    padding: 0.4375rem 0.6875rem;
    color: var(--fl-text);
    background: var(--fl-canvas);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fl-font-small);
  }
  th,
  td {
    text-align: start;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--fl-border);
    vertical-align: top;
  }
  tbody tr:last-child td {
    border-bottom: 0;
  }
  td small {
    display: block;
    color: var(--fl-muted);
  }
  .pager {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
    font-size: var(--fl-font-small);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
