<script lang="ts">
  import { t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import CloudBackupSection from '$lib/components/frameleaf/cloud/CloudBackupSection.svelte';
  import BuddyBackupSection from '$lib/components/frameleaf/cloud/BuddyBackupSection.svelte';
  let destination = $state<'cloud' | 'buddy'>('cloud');
</script>

<div class="destinations" role="group" aria-label={$t('frameleaf_buddy_backup_destination')}>
  <Button pressed={destination === 'cloud'} onclick={() => (destination = 'cloud')}
    >{$t('frameleaf_buddy_cloud_backup')}</Button
  >
  <Button pressed={destination === 'buddy'} onclick={() => (destination = 'buddy')}
    >{$t('frameleaf_buddy_buddy_backup')}</Button
  >
</div>
{#if destination === 'cloud'}<CloudBackupSection />{:else}<BuddyBackupSection />{/if}

<style>
  .destinations {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
</style>
