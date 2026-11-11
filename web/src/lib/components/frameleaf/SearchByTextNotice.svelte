<script lang="ts">
  /**
   * FL-1403: a search by meaning was answered by text (file name, description, text in the picture,
   * folder), because the server has Visual search off or it did not answer. One quiet line above the
   * results says so, and takes an administrator to the setting.
   */
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { t } from 'svelte-i18n';
</script>

<p class="search-by-text" role="status" data-testid="search-by-text-notice">
  {$t('frameleaf_search_by_text_notice')}
  {#if authManager.authenticated && authManager.user.isAdmin}
    <a href={commandCenterUrl('intelligence', 'smart-search')}>{$t('frameleaf_cp_model_row_search_open')}</a>
  {/if}
</p>

<style>
  .search-by-text {
    margin: 0;
    padding: var(--fl-space-3) 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  a {
    color: var(--fl-accent);
    text-decoration: underline;
    white-space: nowrap;
  }
</style>
