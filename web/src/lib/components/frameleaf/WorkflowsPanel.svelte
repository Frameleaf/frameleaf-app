<script lang="ts">
  /**
   * Utilities → Workflows (FL-82), ported from the `workflows` tool of the design template's
   * `UtilitiesManager.jsx`: create, import, open, pause or enable and export the signed-in account's
   * workflows. Everything shown is the server's; a workflow the server can no longer run is marked
   * Blocked with the reason, and an import arrives paused.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import WorkflowDesigner from '$lib/components/frameleaf/WorkflowDesigner.svelte';
  import type { ReferenceOption } from '$lib/components/frameleaf/WorkflowParameter.svelte';
  import {
    draftFromWorkflow,
    emptyDraft,
    exportDocument,
    exportFileName,
    importWorkflowFile,
    workflowStatus,
    type WorkflowDraft,
  } from '$lib/frameleaf/workflows';
  import { pluginManager } from '$lib/managers/plugin-manager.svelte';
  import { Route } from '$lib/route';
  import { downloadJson } from '$lib/utils';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { getAllAlbums, getAllTags, getWorkflowForShare, updateWorkflow, type WorkflowResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiDownload, mdiPlus, mdiTuneVariant } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';
  import { untrack } from 'svelte';

  let { initial, openId }: { initial: WorkflowResponseDto[]; openId?: string } = $props();

  // svelte-ignore state_referenced_locally
  let workflows = $state<WorkflowResponseDto[]>(initial);
  let editing = $state<{ workflow?: WorkflowResponseDto; draft: WorkflowDraft } | null>(null);
  let designerOpen = $state(false);
  let notice = $state('');
  let error = $state('');
  let references = $state<Record<string, ReferenceOption[]>>({});
  let referencesLoaded = false;

  const triggerLabel = (trigger: string) => {
    const key = `frameleaf_workflows.trigger_${trigger}`;
    const label = $t(key as Translations);
    return label === key ? trigger : label;
  };

  const loadReferences = async () => {
    if (referencesLoaded) {
      return;
    }
    referencesLoaded = true;
    try {
      const [tags, albums] = await Promise.all([getAllTags(), getAllAlbums({})]);
      references = {
        TagId: tags.map((tag) => ({ id: tag.id, label: tag.value })),
        AlbumId: albums.map((album) => ({ id: album.id, label: album.albumName })),
      };
    } catch {
      // identifiers can still be entered directly
      referencesLoaded = false;
    }
  };

  const openDesigner = (workflow?: WorkflowResponseDto, draft?: WorkflowDraft) => {
    error = '';
    editing = { workflow, draft: draft ?? (workflow ? draftFromWorkflow(workflow) : emptyDraft()) };
    designerOpen = true;
    void loadReferences();
  };

  // a workflow's own address opens it once, when the page loads
  let opened = false;
  $effect(() => {
    if (!openId || opened) {
      return;
    }

    opened = true;
    const workflow = untrack(() => workflows.find((item) => item.id === openId));
    if (workflow) {
      untrack(() => openDesigner(workflow));
    }
  });

  $effect(() => {
    // the address follows the open workflow, so a reload reopens it
    if (designerOpen || !editing) {
      return;
    }

    editing = null;
    if (openId) {
      void goto(Route.workflows(), { replaceState: true, noScroll: true });
    }
  });

  const onSaved = (response: WorkflowResponseDto) => {
    const exists = workflows.some((item) => item.id === response.id);
    workflows = exists
      ? workflows.map((item) => (item.id === response.id ? response : item))
      : [response, ...workflows];
    notice = $t('frameleaf_workflows.saved');
  };

  const onDeleted = (id: string) => {
    workflows = workflows.filter((item) => item.id !== id);
    notice = $t('frameleaf_workflows.deleted');
  };

  const toggle = async (workflow: WorkflowResponseDto) => {
    error = '';
    try {
      const response = await updateWorkflow({ id: workflow.id, workflowUpdateDto: { enabled: !workflow.enabled } });
      workflows = workflows.map((item) => (item.id === response.id ? response : item));
      notice = response.enabled ? $t('frameleaf_workflows.enabled_toast') : $t('frameleaf_workflows.paused_toast');
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('errors.unable_to_update_workflow');
    }
  };

  const exportWorkflow = async (workflow: WorkflowResponseDto) => {
    try {
      downloadJson(exportDocument(await getWorkflowForShare({ id: workflow.id })), exportFileName(workflow.name));
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('errors.something_went_wrong');
    }
  };

  const importFile = async (event: Event & { currentTarget: HTMLInputElement }) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    try {
      openDesigner(undefined, importWorkflowFile(await file.text(), file.size));
      notice = $t('frameleaf_workflows.imported');
    } catch (error_) {
      error = (error_ as Error).message;
    }
  };
</script>

<div class="workflows">
  <div class="toolbar">
    <Button variant="primary" onclick={() => openDesigner()}>
      <Icon icon={mdiPlus} size="16" />
      {$t('frameleaf_workflows.create')}
    </Button>
    <label class="file-import">
      {$t('frameleaf_workflows.import')}
      <input type="file" accept="application/json,.json" onchange={(event) => void importFile(event)} />
    </label>
  </div>

  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#if notice}<p role="status" class="notice">{notice}</p>{/if}

  {#if workflows.length === 0}
    <p class="empty">{$t('frameleaf_workflows.empty')}</p>
  {:else}
    <div class="list">
      {#each workflows as workflow (workflow.id)}
        {@const status = workflowStatus(workflow)}
        <article>
          <Icon icon={mdiTuneVariant} size="25" />
          <div>
            <strong>{workflow.name || $t('frameleaf_workflows.new_workflow')}</strong>
            <p>
              {triggerLabel(workflow.trigger)} · {$t('frameleaf_workflows.steps_count', {
                values: { count: workflow.steps.length },
              })}
            </p>
            <small class:blocked={status === 'blocked'}>
              {$t(`frameleaf_workflows.status_${status}`)} ·
              {workflow.logging ? $t('frameleaf_workflows.history_on') : $t('frameleaf_workflows.history_off')}
            </small>
            {#if workflow.issues.length > 0}<small class="issue">{workflow.issues[0].message}</small>{/if}
          </div>
          <Button onclick={() => void goto(Route.viewWorkflow({ id: workflow.id }), { noScroll: true })}>
            {$t('frameleaf_workflows.open')}
          </Button>
          <Button disabled={!workflow.enabled && workflow.issues.length > 0} onclick={() => void toggle(workflow)}>
            {workflow.enabled ? $t('frameleaf_workflows.pause') : $t('frameleaf_workflows.enable')}
          </Button>
          <Button
            label={$t('frameleaf_workflows.export_label', { values: { name: workflow.name || workflow.id } })}
            onclick={() => void exportWorkflow(workflow)}
          >
            <Icon icon={mdiDownload} size="16" />
          </Button>
        </article>
      {/each}
    </div>
  {/if}
</div>

{#if editing}
  {#key editing}
    <WorkflowDesigner
      bind:open={designerOpen}
      workflow={editing.workflow}
      initial={editing.draft}
      methods={pluginManager.methods}
      triggers={pluginManager.triggers}
      templates={pluginManager.templates}
      {references}
      {onSaved}
      {onDeleted}
    />
  {/key}
{/if}

<style>
  .workflows {
    color: var(--fl-text);
    font-size: var(--fl-font-size);
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    padding: 0.875rem 0;
  }
  .file-import {
    display: inline-flex;
    align-items: center;
    padding: 0.4375rem 0.6875rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    cursor: pointer;
  }
  .file-import:focus-within {
    outline: 2px solid var(--fl-accent);
  }
  .file-import input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  .list article {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: center;
    padding: 1.25rem;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    margin-bottom: 0.75rem;
  }
  .list article > div {
    flex: 1;
    min-width: 12rem;
  }
  .list strong {
    font-weight: 550;
  }
  .list p,
  .list small {
    display: block;
    margin: 0.25rem 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .list small.blocked,
  .list small.issue {
    color: var(--fl-warning-text);
  }
  .empty {
    padding: 2.8rem 1.25rem;
    text-align: center;
    color: var(--fl-muted);
  }
  .error {
    color: var(--fl-danger-text);
  }
  .notice {
    color: var(--fl-muted);
  }
</style>
