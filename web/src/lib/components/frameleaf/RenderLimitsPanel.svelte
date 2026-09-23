<script lang="ts">
  /**
   * Render limits (FL-95): the instance default and every per-account ceiling on concurrent
   * operations, wall clock and output size. The server applies the tightest of worker, account
   * and instance ceilings at claim time and on every heartbeat; this panel only shows and edits
   * the rows. Account rows are keyed by user id; the name and email come from the users list the
   * page already loaded, so a removed account still shows its row until an administrator clears it.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Pane from '$lib/components/frameleaf/Pane.svelte';
  import { bytesToGiB, msToMinutes } from '$lib/frameleaf/render-workers';
  import { locale } from '$lib/stores/preferences.store';
  import type { RenderWorkerLimitDto, RenderWorkerLimitsResponseDto, UserAdminResponseDto } from '@immich/sdk';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  let {
    limits,
    users,
    onEditInstance,
    onAddUser,
    onEditUser,
    onRemoveUser,
  }: {
    limits: RenderWorkerLimitsResponseDto;
    users: UserAdminResponseDto[];
    onEditInstance: () => void;
    onAddUser: () => void;
    onEditUser: (limit: RenderWorkerLimitDto) => void;
    onRemoveUser: (limit: RenderWorkerLimitDto) => void;
  } = $props();

  const byId = $derived(new Map(users.map((user) => [user.id, user])));
  /** The instance row is synthesised by the server when nothing was ever set; `updatedAt` is then the epoch. */
  const instanceSet = $derived(Date.parse(limits.instance.updatedAt) > 0);

  const wallClock = (value: string | null) => {
    const minutes = msToMinutes(value);
    return minutes === null
      ? $t('frameleaf_render_workers_ceiling_none')
      : $t('frameleaf_render_workers_ceiling_wall_clock', { values: { minutes } });
  };

  const output = (value: string | null) => {
    const gib = bytesToGiB(value);
    return gib === null
      ? $t('frameleaf_render_workers_ceiling_none')
      : $t('frameleaf_render_workers_ceiling_output', { values: { gib } });
  };

  const concurrency = (limit: RenderWorkerLimitDto) =>
    limit.maxConcurrentOperations === 0 ? $t('frameleaf_render_workers_limits_paused') : limit.maxConcurrentOperations;

  const updated = (value: string) => DateTime.fromISO(value, { locale: $locale }).toLocaleString(DateTime.DATETIME_MED);
</script>

<Pane label={$t('frameleaf_render_workers_limits_title')}>
  <div class="head">
    <div>
      <h2>{$t('frameleaf_render_workers_limits_title')}</h2>
      <p>{$t('frameleaf_render_workers_limits_subtitle')}</p>
    </div>
    <Button onclick={onAddUser}>{$t('frameleaf_render_workers_limits_add')}</Button>
  </div>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrollable region must be reachable by keyboard to scroll it) -->
  <div class="scroll" role="region" aria-label={$t('frameleaf_render_workers_limits_table_label')} tabindex="0">
    <table>
      <thead>
        <tr>
          <th scope="col">{$t('frameleaf_render_workers_limits_column_subject')}</th>
          <th scope="col">{$t('frameleaf_render_workers_limits_column_concurrency')}</th>
          <th scope="col">{$t('frameleaf_render_workers_limits_column_wall_clock')}</th>
          <th scope="col">{$t('frameleaf_render_workers_limits_column_output')}</th>
          <th scope="col">{$t('frameleaf_render_workers_limits_column_updated')}</th>
          <th scope="col"><span class="sr-only">{$t('frameleaf_render_workers_column_actions')}</span></th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row">
            <strong>{$t('frameleaf_render_workers_limits_instance')}</strong>
          </th>
          <td>{concurrency(limits.instance)}</td>
          <td>{wallClock(limits.instance.maxWallClockMs)}</td>
          <td>{output(limits.instance.maxOutputBytes)}</td>
          <td>{instanceSet ? updated(limits.instance.updatedAt) : $t('frameleaf_render_workers_limits_never_set')}</td>
          <td class="actions">
            <Button variant="quiet" onclick={onEditInstance}>{$t('frameleaf_render_workers_edit')}</Button>
          </td>
        </tr>
        {#each limits.users as limit (limit.subject)}
          {@const user = limit.userId ? byId.get(limit.userId) : undefined}
          <tr>
            <th scope="row">
              <strong>{user?.name ?? $t('frameleaf_render_workers_limits_unknown_user')}</strong>
              <small>{user?.email ?? limit.userId}</small>
            </th>
            <td>{concurrency(limit)}</td>
            <td>{wallClock(limit.maxWallClockMs)}</td>
            <td>{output(limit.maxOutputBytes)}</td>
            <td>{updated(limit.updatedAt)}</td>
            <td class="actions">
              <Button variant="quiet" onclick={() => onEditUser(limit)}>{$t('frameleaf_render_workers_edit')}</Button>
              <Button variant="quiet" onclick={() => onRemoveUser(limit)}>
                {$t('frameleaf_render_workers_limits_remove')}
              </Button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</Pane>

<style>
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: start;
    justify-content: space-between;
    gap: 0.75rem 1rem;
    margin-bottom: 1rem;
  }
  .head h2 {
    font-size: var(--fl-font-size);
    margin: 0 0 0.25rem;
  }
  .head p {
    margin: 0;
    max-width: 60ch;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .scroll {
    overflow-x: auto;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fl-font-size);
    color: var(--fl-text);
  }
  th,
  td {
    padding: 0.625rem 0.875rem;
    text-align: start;
    vertical-align: top;
  }
  thead th {
    font-size: var(--fl-font-small);
    font-weight: 600;
    color: var(--fl-muted);
    border-bottom: 1px solid var(--fl-border);
  }
  tbody tr + tr {
    border-top: 1px solid var(--fl-border);
  }
  tbody th {
    display: grid;
    gap: 0.125rem;
    font-weight: 400;
  }
  tbody th small {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
    overflow-wrap: anywhere;
  }
  .actions {
    white-space: nowrap;
  }
</style>
