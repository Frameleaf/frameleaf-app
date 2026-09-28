<script lang="ts">
  /**
   * "Move or export your library" (FL-75), the last section of the design template's Storage &
   * originals area (`settings-catalog.mjs` section `migration`). It has no setting of its own:
   * its "Prepare migration checklist" action opens the "Plan a library move" workflow, which
   * walks through the command-line migration and opens its audit report read-only.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import MigrationChecklistDialog from '$lib/components/frameleaf/settings/MigrationChecklistDialog.svelte';
  import { Icon } from '@immich/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let open = $state(false);
  let notice = $state('');
</script>

<div class="migration-section">
  <div class="action">
    <Button
      onclick={() => {
        notice = '';
        open = true;
      }}
    >
      {$t('admin.frameleaf_migration_checklist_action')}
      <span aria-hidden="true"><Icon icon={mdiChevronRight} size="16" /></span>
    </Button>
  </div>
  <p class="notice" role="status">{notice}</p>
</div>

<MigrationChecklistDialog bind:open onDone={() => (notice = $t('admin.frameleaf_migration_checklist_final'))} />

<style>
  .migration-section {
    display: grid;
    gap: 0.5rem;
  }
  .action {
    display: flex;
  }
  .notice {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .notice:empty {
    display: none;
  }
</style>
