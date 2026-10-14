<script lang="ts">
  import { onMount } from 'svelte';
  import { getManagerAccess } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  let url = $state<string | null>(null),
    checked = $state(false);
  onMount(() => {
    let active = true;
    void getManagerAccess()
      .then((value) => {
        if (active) {
          url = value.url;
        }
      })
      .catch(() => {
        if (active) {
          url = null;
        }
      })
      .finally(() => {
        if (active) {
          checked = true;
        }
      });
    return () => {
      active = false;
    };
  });
</script>

<div class="manager-move">
  <p>{$t('admin.frameleaf_manager_move_intro')}</p>
  {#if url}
    <a href={`${url}/#storage`} target="_blank" rel="noopener noreferrer">{$t('admin.frameleaf_manager_open')}</a>
    <p>{$t('admin.frameleaf_manager_sign_in')}</p>
  {:else if checked}
    <p>{$t('admin.frameleaf_manager_move_unavailable')}</p>
  {/if}
  <p>{$t('admin.frameleaf_manager_new_server')}</p>
</div>

<style>
  .manager-move {
    display: grid;
    gap: var(--fl-space-3);
    padding-block: var(--fl-space-3);
  }
  p {
    margin: 0;
  }
  a {
    width: fit-content;
    min-height: 2.75rem;
    display: inline-flex;
    align-items: center;
    color: var(--fl-text);
    text-decoration: underline;
  }
</style>
