<script lang="ts">
  /**
   * A Command Center page's own actions (FL-71), the template's `.cc-section-action` row: the
   * actions the old administration pages carried in their header bar (create an account, pause a
   * queue, …) as buttons at the top of the section. Hidden actions (`$if`) and menu dividers are left out.
   */
  import type { HeaderButtonActionItem } from '$lib/types';
  import { Button, isMenuItemType, type MenuItemType } from '@immich/ui';

  let { actions }: { actions: Array<HeaderButtonActionItem | MenuItemType> } = $props();

  const enabled = $derived(
    actions
      .filter((action): action is HeaderButtonActionItem => !isMenuItemType(action))
      .filter((action) => action.$if?.() ?? true),
  );
</script>

{#if enabled.length > 0}
  <div class="cc-section-action">
    {#each enabled as action, index (index)}
      <Button
        variant="ghost"
        size="small"
        color={action.color ?? 'secondary'}
        leadingIcon={action.icon}
        title={action.data?.title}
        onclick={() => action.onAction(action)}
      >
        {action.title}
      </Button>
    {/each}
  </div>
{/if}

<style>
  .cc-section-action {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 16px;
  }
</style>
