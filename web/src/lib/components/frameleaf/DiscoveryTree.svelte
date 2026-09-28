<script lang="ts" generics="T extends DiscoveryTreeNode">
  /**
   * The Tags and Folders tree (FL-46), a port of the prototype's `TagRow` / `FolderRow` and their
   * `dv-tree` markup (`design/frameleaf/template/src/Tags.jsx:25-87, 326-345`, `Folders.jsx:26-87,
   * 216-228`, `discovery.css` "Split layout"): a WAI-ARIA tree with one roving tab stop, a chevron
   * per branch, a leading mark (the tag's colour dot or a folder icon), the name and a count.
   *
   * The keyboard model lives in `discovery-tree.ts` so both trees answer a key the same way. The
   * tree owns only which row holds the tab stop; the page owns the chosen row (it is the address,
   * so browser Back returns to the previous one) and which branches are open.
   */
  import { treeKeyAction, visibleTreeRows, type DiscoveryTreeNode } from '$lib/frameleaf/discovery-tree';
  import { Icon } from '@immich/ui';
  import { mdiChevronDown, mdiChevronRight } from '@mdi/js';
  import type { Snippet } from 'svelte';

  interface Props {
    roots: T[];
    /** Accessible name of the tree. */
    label: string;
    expanded: ReadonlySet<string>;
    selectedId: string | null;
    /** The row holding the tab stop; the first row when unset or gone. */
    focusedId?: string | null;
    count: (node: T) => number;
    isMatch?: (node: T) => boolean;
    expandLabel: (node: T) => string;
    collapseLabel: (node: T) => string;
    onChoose: (node: T) => void;
    onToggle: (node: T) => void;
    /** The row's leading mark: a colour dot or a folder icon. */
    lead: Snippet<[T, boolean]>;
  }

  let {
    roots,
    label,
    expanded,
    selectedId,
    focusedId = $bindable(null),
    count,
    isMatch = () => false,
    expandLabel,
    collapseLabel,
    onChoose,
    onToggle,
    lead,
  }: Props = $props();

  let treeElement = $state<HTMLUListElement>();

  const visible = $derived(visibleTreeRows(roots, expanded));
  const parents = $derived.by(() => {
    const map = new Map<string, T | null>();
    const visit = (nodes: T[], parent: T | null) => {
      for (const node of nodes) {
        map.set(node.id, parent);
        visit(node.children as T[], node);
      }
    };
    visit(roots, null);
    return map;
  });
  const byId = $derived(new Map(visible.map((node) => [node.id, node])));
  /** Prototype `focusId`: the focused row while it is still visible, else the chosen one, else the first. */
  const tabStop = $derived(
    focusedId && byId.has(focusedId)
      ? focusedId
      : selectedId && byId.has(selectedId)
        ? selectedId
        : (visible[0]?.id ?? null),
  );

  const focusRow = (id: string) => {
    focusedId = id;
    for (const element of treeElement?.querySelectorAll<HTMLElement>('[data-tree-id]') ?? []) {
      if (element.dataset.treeId === id) {
        element.focus();
        return;
      }
    }
  };

  const handleKeydown = (event: KeyboardEvent, node: T) => {
    event.stopPropagation();
    const isOpen = expanded.has(node.id);
    const action = treeKeyAction(event.key, {
      visible: visible.map((row) => row.id),
      focusedId: node.id,
      hasChildren: node.children.length > 0,
      expanded: isOpen,
      parentId: parents.get(node.id)?.id ?? null,
      firstChildId: node.children.at(0)?.id ?? null,
    });
    if (!action) {
      return;
    }
    event.preventDefault();
    switch (action.type) {
      case 'focus': {
        focusRow(action.id);
        break;
      }
      case 'expand':
      case 'collapse': {
        onToggle(node);
        break;
      }
      case 'choose': {
        focusedId = node.id;
        onChoose(node);
        break;
      }
    }
  };
</script>

{#snippet row(node: T, depth: number)}
  {@const isOpen = expanded.has(node.id)}
  {@const hasChildren = node.children.length > 0}
  {@const selected = selectedId === node.id}
  <li
    role="treeitem"
    aria-expanded={hasChildren ? isOpen : undefined}
    aria-selected={selected}
    aria-level={depth + 1}
    data-tree-id={node.id}
    tabindex={tabStop === node.id ? 0 : -1}
    class="dv-tree-item"
    class:selected
    class:match={isMatch(node)}
    style:--depth={depth}
    onclick={(event) => {
      event.stopPropagation();
      focusedId = node.id;
      onChoose(node);
    }}
    onkeydown={(event) => handleKeydown(event, node)}
    onfocus={() => (focusedId = node.id)}
  >
    <span class="dv-tree-row">
      {#if hasChildren}
        <button
          type="button"
          class="dv-tree-toggle"
          tabindex="-1"
          aria-label={isOpen ? collapseLabel(node) : expandLabel(node)}
          onclick={(event) => {
            event.stopPropagation();
            onToggle(node);
          }}
        >
          <Icon icon={isOpen ? mdiChevronDown : mdiChevronRight} size="16" aria-hidden="true" />
        </button>
      {:else}
        <span class="dv-tree-toggle" aria-hidden="true"></span>
      {/if}
      {@render lead(node, selected)}
      <span class="dv-tree-name">{node.name}</span>
      <small>{count(node)}</small>
    </span>
    {#if hasChildren && isOpen}
      <ul role="group">
        {#each node.children as child (child.id)}
          {@render row(child as T, depth + 1)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

<ul role="tree" aria-label={label} class="dv-tree" bind:this={treeElement}>
  {#each roots as root (root.id)}
    {@render row(root, 0)}
  {/each}
</ul>
