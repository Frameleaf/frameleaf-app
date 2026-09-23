<script lang="ts">
  /**
   * The Frameleaf admin Users list (FL-76), ported from the design template's accounts view
   * in `design/frameleaf/template/src/AccountsLibraries.jsx`: one toolbar with a search box,
   * a lifecycle filter and a sort, then a table whose rows carry the avatar, role, storage
   * and status of each account.
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
  import type { UserAdminResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  let { users }: { users: UserAdminResponseDto[] } = $props();

  let query = $state('');
  // Bound to <select>, so these stay plain strings and are narrowed where the rules are applied.
  let filter = $state('active');
  let sort = $state('name');

  const rows = $derived(
    sortAccounts(filterAccounts(users, { query, filter: filter as AccountFilter }), sort as AccountSort),
  );

  const idPrefix = $props.id();
  const searchId = `${idPrefix}-search`;
  const filterId = `${idPrefix}-filter`;
  const sortId = `${idPrefix}-sort`;

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

<div class="toolbar">
  <label class="field" for={searchId}>
    <span>{$t('frameleaf_users_search_label')}</span>
    <input
      id={searchId}
      type="search"
      maxlength={ACCOUNT_QUERY_MAX_LENGTH}
      placeholder={$t('frameleaf_users_search_placeholder')}
      bind:value={query}
    />
  </label>
  <label class="field" for={filterId}>
    <span>{$t('frameleaf_users_filter_label')}</span>
    <select id={filterId} bind:value={filter}>
      <option value="active">{$t('frameleaf_users_filter_active')}</option>
      <option value="all">{$t('frameleaf_users_filter_all')}</option>
      <option value="deleted">{$t('frameleaf_users_filter_deleted')}</option>
      <option value="admin">{$t('frameleaf_users_filter_admin')}</option>
    </select>
  </label>
  <label class="field" for={sortId}>
    <span>{$t('frameleaf_users_sort_label')}</span>
    <select id={sortId} bind:value={sort}>
      <option value="name">{$t('frameleaf_users_sort_name')}</option>
      <option value="storage">{$t('frameleaf_users_sort_storage')}</option>
      <option value="created">{$t('frameleaf_users_sort_created')}</option>
    </select>
  </label>
  <p class="count" aria-live="polite">{$t('frameleaf_users_count', { values: { count: rows.length } })}</p>
</div>

<div class="scroll" role="region" aria-label={$t('frameleaf_users_table_label')} tabindex="0">
  <table>
    <thead>
      <tr>
        <th scope="col">{$t('frameleaf_users_column_account')}</th>
        <th scope="col">{$t('frameleaf_users_column_role')}</th>
        <th scope="col">{$t('frameleaf_users_column_storage')}</th>
        <th scope="col">{$t('frameleaf_users_column_status')}</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as user (user.id)}
        {@const quota = accountQuotaUsage(user)}
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
            {#if quota}
              {$t('frameleaf_users_storage_used', {
                values: {
                  used: getByteUnitString(quota.used, $locale),
                  total: getByteUnitString(quota.total, $locale),
                },
              })}
            {:else}
              {$t('frameleaf_users_storage_unlimited')}
            {/if}
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
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .field {
    display: grid;
    gap: 0.25rem;
    min-width: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .field:first-child {
    flex: 1 1 14rem;
  }
  .field input,
  .field select {
    padding: 0.4375rem 0.6875rem;
    font: inherit;
    font-size: var(--fl-font-size);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .count {
    margin: 0 0 0.4375rem;
    font-size: var(--fl-font-small);
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
  .empty {
    margin: 0;
    padding: 1.5rem 0.875rem;
    color: var(--fl-muted);
  }
</style>
