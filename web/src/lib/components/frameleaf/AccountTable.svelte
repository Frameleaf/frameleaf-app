<script lang="ts">
  /**
   * The Frameleaf admin Users list (FL-76), ported from the design template's accounts view
   * in `design/frameleaf/template/src/AccountsLibraries.jsx`: one toolbar with a search box,
   * a lifecycle filter and a sort, then a table whose rows carry the avatar, role, storage
   * and status of each account.
   *
   * The Items and "Storage used / quota" columns are the template's (CC-26, `AccountsLibraries.jsx`
   * 143-196, 948-1000): each account's photos and videos from the server statistics
   * (`usageByUser`, admin-only), and its logical usage against its quota with a meter and what
   * remains. An account the statistics do not list (a deleted one) shows no item count.
   *
   * The rows are whatever `searchUsersAdmin({ withDeleted: true })` returned; the filtering,
   * sorting and lifecycle rules live in `$lib/frameleaf/accounts` so they can be tested
   * without a DOM. Nothing here mutates an account: every row is a link to that account's
   * page, where the lifecycle and security actions live.
   */
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import {
    ACCOUNT_QUERY_MAX_LENGTH,
    accountLifecycle,
    accountQuotaUsage,
    filterAccounts,
    sortAccounts,
    type AccountFilter,
    type AccountSort,
  } from '$lib/frameleaf/accounts';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import type { UsageByUserDto, UserAdminResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  let { users, usage = [] }: { users: UserAdminResponseDto[]; usage?: UsageByUserDto[] } = $props();

  const usageById = $derived(new Map(usage.map((row) => [row.userId, row])));
  const count = (value: number) => value.toLocaleString($locale);
  const bytes = (value: number) => getByteUnitString(value, $locale);

  let query = $state('');
  // Bound to <select>, so these stay plain strings and are narrowed where the rules are applied.
  let filter = $state('active');
  let sort = $state('name');

  const rows = $derived(
    sortAccounts(filterAccounts(users, { query, filter: filter as AccountFilter }), sort as AccountSort),
  );

  const statusLabel = (user: UserAdminResponseDto) => {
    switch (accountLifecycle(user)) {
      case 'removing': {
        return $t('frameleaf_users_status_removing');
      }
      case 'deleted': {
        return $t('frameleaf_users_status_deleted');
      }
      case 'active': {
        return $t('frameleaf_users_status_active');
      }
    }
  };
</script>

<!-- The template's `resource-toolbar` (AccountsLibraries.jsx 892-932): named controls, no visible labels. -->
<div class="toolbar">
  <input
    type="search"
    maxlength={ACCOUNT_QUERY_MAX_LENGTH}
    aria-label={$t('frameleaf_users_search_label')}
    placeholder={$t('frameleaf_users_search_placeholder')}
    bind:value={query}
  />
  <select aria-label={$t('frameleaf_users_filter_label')} bind:value={filter}>
    <option value="active">{$t('frameleaf_users_filter_active')}</option>
    <option value="all">{$t('frameleaf_users_filter_all')}</option>
    <option value="deleted">{$t('frameleaf_users_filter_deleted')}</option>
    <option value="admin">{$t('frameleaf_users_filter_admin')}</option>
  </select>
  <select aria-label={$t('frameleaf_users_sort_label')} bind:value={sort}>
    <option value="name">{$t('frameleaf_users_sort_name')}</option>
    <option value="storage">{$t('frameleaf_users_sort_storage')}</option>
    <option value="created">{$t('frameleaf_users_sort_created')}</option>
  </select>
  <span class="count" aria-live="polite">{$t('frameleaf_users_count', { values: { count: rows.length } })}</span>
</div>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrollable region must be reachable by keyboard to scroll it) -->
<div class="scroll" role="region" aria-label={$t('frameleaf_users_table_label')} tabindex="0">
  <table>
    <thead>
      <tr>
        <th scope="col">{$t('frameleaf_users_column_account')}</th>
        <th scope="col">{$t('frameleaf_users_column_role')}</th>
        <th scope="col">{$t('frameleaf_users_column_items')}</th>
        <th scope="col">{$t('frameleaf_users_column_storage')}</th>
        <th scope="col">{$t('frameleaf_users_column_status')}</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as user (user.id)}
        {@const quota = accountQuotaUsage(user)}
        {@const stats = usageById.get(user.id)}
        {@const used = user.quotaUsageInBytes ?? 0}
        <tr>
          <th scope="row">
            <a href={Route.viewUser(user)}>
              <UserAvatar {user} size="sm" />
              <span>
                <strong>{user.name}</strong>
                <small>{user.email}</small>
              </span>
            </a>
          </th>
          <td>{user.isAdmin ? $t('frameleaf_users_role_admin') : $t('frameleaf_users_role_user')}</td>
          <td>
            {#if stats}
              {count(stats.photos + stats.videos)}
              <small>{$t('frameleaf_users_items_videos', { values: { count: stats.videos } })}</small>
            {:else}
              <span aria-label={$t('frameleaf_users_items_unknown')}>—</span>
            {/if}
          </td>
          <td>
            <!-- The template's Quota (AccountsLibraries.jsx 170-196). -->
            <div class="quota">
              <span>
                {bytes(used)}
                <small>/ {quota ? bytes(quota.total) : $t('frameleaf_users_quota_unlimited')}</small>
              </span>
              {#if quota}
                <progress
                  aria-label={$t('frameleaf_users_quota_usage', { values: { name: user.name } })}
                  max={Math.max(1, quota.total)}
                  value={Math.min(used, Math.max(1, quota.total))}
                ></progress>
                <small>
                  {used > quota.total
                    ? $t('frameleaf_users_quota_over')
                    : $t('frameleaf_users_quota_remaining', {
                        values: { size: bytes(Math.max(0, quota.total - used)) },
                      })}
                </small>
              {/if}
            </div>
          </td>
          <td>
            <Badge
              value={statusLabel(user)}
              label={statusLabel(user)}
              tone={accountLifecycle(user) === 'active' ? 'neutral' : 'warning'}
            />
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if rows.length === 0}
    <p class="empty">{$t('frameleaf_users_empty')}</p>
  {/if}
</div>

<style>
  /* accounts-libraries.css `.resource-toolbar`. */
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-bottom: 1rem;
  }
  .toolbar input {
    flex: 1;
    min-width: 180px;
  }
  .toolbar input,
  .toolbar select {
    min-width: 0;
    max-width: 100%;
    min-height: 36px;
    padding: 8px 10px;
    font: inherit;
    font-size: 12px;
    color: var(--fl-text);
    background: var(--fl-canvas);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .count {
    font-size: 11px;
    color: var(--fl-muted);
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
    vertical-align: middle;
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
    font-weight: 400;
  }
  a {
    display: inline-flex;
    align-items: center;
    gap: 0.625rem;
    color: inherit;
  }
  a span {
    display: grid;
    min-width: 0;
  }
  a small {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  td small {
    display: block;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  /* accounts-libraries.css `.resource-quota`. */
  .quota {
    display: grid;
    gap: 4px;
    min-width: 140px;
    font-size: 12px;
  }
  .quota small {
    font-size: 10px;
  }
  .quota span small {
    display: inline;
  }
  .quota progress {
    display: block;
    width: 100%;
    max-width: 280px;
    height: 4px;
    overflow: hidden;
    accent-color: var(--fl-accent);
    background: var(--fl-border);
    border: 0;
    border-radius: 4px;
  }
  .quota progress::-webkit-progress-bar {
    background: var(--fl-border);
  }
  .quota progress::-webkit-progress-value {
    background: var(--fl-accent);
  }
  .empty {
    margin: 0;
    padding: 1.5rem 0.875rem;
    color: var(--fl-muted);
  }
</style>
