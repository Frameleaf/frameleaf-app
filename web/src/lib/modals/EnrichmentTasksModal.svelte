<script lang="ts">
  /**
   * The Jobs manager's "Enrichment tasks" entry (FL-59), ported from the design template's
   * `EnrichmentJobDialog` in `JobsManager.jsx`. The prototype's three tasks — regenerate
   * descriptions, re-evaluate smart albums, apply a description hardware preset — already have
   * real, authorized flows elsewhere in the admin settings; this dialog is the single entry
   * point the prototype places in the Jobs manager, and it delegates to those existing flows
   * instead of duplicating their business logic:
   *   - "Regenerate descriptions" opens the same confirm-with-estimate modal as the machine
   *     learning settings page (`ImageDescriptionRequeueModal`).
   *   - "Re-evaluate smart albums" opens the same confirm-with-estimate modal as the Smart
   *     albums settings page (`SmartAlbumReevaluateModal`), optionally scoped to one category.
   *   - "Apply a description hardware preset" needs the full machine-learning config draft to
   *     apply safely, so it navigates to that settings section instead of mutating config here.
   * A fourth shortcut opens the sample-first enrichment workbench directly, since the prototype
   * groups "preview before you commit" and "regenerate everywhere" in the same surface.
   */
  import { goto } from '$app/navigation';
  import Combobox, { type ComboBoxOption } from '$lib/components/shared-components/Combobox.svelte';
  import { OpenQueryParam } from '$lib/constants';
  import ImageDescriptionRequeueModal from '$lib/modals/ImageDescriptionRequeueModal.svelte';
  import SmartAlbumReevaluateModal from '$lib/modals/SmartAlbumReevaluateModal.svelte';
  import { Route } from '$lib/route';
  import { Kind3 as SmartAlbumKind } from '@immich/sdk';
  import { Button, Modal, ModalBody, ModalFooter, modalManager } from '@immich/ui';
  import { t } from 'svelte-i18n';

  type CloseResult = { queued: boolean } | { deferred: true } | undefined;

  interface Props {
    onClose: (result?: CloseResult) => void;
  }

  let { onClose }: Props = $props();

  type Task = 'descriptions' | 'smart-albums' | 'hardware';

  const taskOptions: ComboBoxOption[] = [
    { value: 'descriptions', label: $t('frameleaf_enrichment_tasks_task_descriptions') },
    { value: 'smart-albums', label: $t('frameleaf_enrichment_tasks_task_smart_albums') },
    { value: 'hardware', label: $t('frameleaf_enrichment_tasks_task_hardware') },
  ];
  let selectedTask: ComboBoxOption | undefined = $state(taskOptions[0]);
  const task = $derived((selectedTask?.value as Task | undefined) ?? 'descriptions');

  // The generated client names the built-in smart-album kind enum `Kind3`.
  const kindKeys = [
    SmartAlbumKind.Travel,
    SmartAlbumKind.Documents,
    SmartAlbumKind.Screenshots,
    SmartAlbumKind.Food,
    SmartAlbumKind.Pets,
    SmartAlbumKind.Nature,
  ] as const;
  const kindTitle = (kind: SmartAlbumKind) => $t(`admin.smart_albums_kind_${kind}` as const);
  const kindOptions: ComboBoxOption[] = [
    { value: '', label: $t('frameleaf_enrichment_tasks_category_all') },
    ...kindKeys.map((kind) => ({ value: kind as string, label: kindTitle(kind) })),
  ];
  let selectedKind: ComboBoxOption | undefined = $state(kindOptions[0]);

  let busy = $state(false);

  const handleDescriptions = async () => {
    busy = true;
    try {
      const result = await modalManager.show(ImageDescriptionRequeueModal, {});
      if (result) {
        onClose(result);
      }
    } finally {
      busy = false;
    }
  };

  const handleSmartAlbums = async () => {
    const value = selectedKind?.value;
    const kind = (value as SmartAlbumKind | undefined) || undefined;
    busy = true;
    try {
      const props = kind ? { kind, kindLabel: kindTitle(kind) } : {};
      const result = await modalManager.show(SmartAlbumReevaluateModal, props);
      if (result) {
        onClose({ queued: result.queued });
      }
    } finally {
      busy = false;
    }
  };

  const openHardwareSettings = () => {
    onClose();
    void goto(Route.systemSettings({ isOpen: OpenQueryParam.IMAGE_DESCRIPTION }));
  };

  const openWorkbench = () => {
    onClose();
    void goto(Route.systemSettings({ isOpen: OpenQueryParam.IMAGE_DESCRIPTION, openSetting: 'workbench' }));
  };
</script>

<Modal title={$t('frameleaf_enrichment_tasks_title')} {onClose} size="small">
  <ModalBody>
    <div class="flex flex-col gap-4">
      <Combobox
        label={$t('frameleaf_enrichment_tasks_task_label')}
        options={taskOptions}
        bind:selectedOption={selectedTask}
      />

      {#if task === 'descriptions'}
        <p class="text-sm text-immich-fg/70 dark:text-immich-dark-fg/70">
          {$t('frameleaf_enrichment_tasks_descriptions_help')}
        </p>
        <Button shape="round" color="secondary" size="small" onclick={openWorkbench} disabled={busy}>
          {$t('frameleaf_enrichment_tasks_open_workbench')}
        </Button>
      {:else if task === 'smart-albums'}
        <Combobox
          label={$t('frameleaf_enrichment_tasks_category_label')}
          options={kindOptions}
          bind:selectedOption={selectedKind}
        />
        <p class="text-sm text-immich-fg/70 dark:text-immich-dark-fg/70">
          {$t('frameleaf_enrichment_tasks_smart_albums_help')}
        </p>
      {:else}
        <p class="text-sm text-immich-fg/70 dark:text-immich-dark-fg/70">
          {$t('frameleaf_enrichment_tasks_hardware_help')}
        </p>
      {/if}
    </div>
  </ModalBody>

  <ModalFooter>
    <div class="flex w-full justify-end gap-2">
      <Button shape="round" color="secondary" onclick={() => onClose()} disabled={busy}>{$t('cancel')}</Button>
      {#if task === 'hardware'}
        <Button shape="round" color="primary" onclick={openHardwareSettings}>
          {$t('frameleaf_enrichment_tasks_review_settings')}
        </Button>
      {:else if task === 'smart-albums'}
        <Button shape="round" color="primary" onclick={handleSmartAlbums} disabled={busy}>
          {$t('frameleaf_enrichment_tasks_continue')}
        </Button>
      {:else}
        <Button shape="round" color="primary" onclick={handleDescriptions} disabled={busy}>
          {$t('frameleaf_enrichment_tasks_continue')}
        </Button>
      {/if}
    </div>
  </ModalFooter>
</Modal>
