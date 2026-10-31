import { tick } from 'svelte';
import type { Action } from 'svelte/action';
import { shortcuts } from '$lib/actions/shortcut';

interface Options {
  /**
   * A function that is called when the dropdown should be closed.
   */
  closeDropdown: () => void;
  /**
   * The container element that with direct children that should be navigated.
   */
  container?: HTMLElement;
  /**
   * Indicates if the dropdown is open.
   */
  isOpen: boolean;
  /**
   * Override the default behavior for the escape key.
   */
  onEscape?: (event: KeyboardEvent) => void;
  /**
   * A function that is called when the dropdown should be opened.
   */
  openDropdown?: (event: KeyboardEvent) => void;
  /**
   * The id of the currently selected element.
   */
  selectedId: string | undefined;
  /**
   * A function that is called when the selection changes, to notify consumers of the new selected id.
   */
  selectionChanged: (id: string | undefined) => void;
}

export const contextMenuNavigation: Action<HTMLElement, Options> = (node, options: Options) => {
  let isOpen = options.isOpen;
  let generation = 0;
  let destroyed = false;
  const getCurrentElement = () => {
    const { container, selectedId } = options;
    return container ? getItems(container).find((item) => item.id === selectedId) : undefined;
  };

  /**
   * The rows the keys move through: the options only. A grouped menu also holds heading rows and
   * separators, which have no id and are never a choice.
   */
  const getItems = (container: HTMLElement) =>
    [...container.children].filter((child) => child.matches('[role^="menuitem"]')) as HTMLElement[];

  const close = () => {
    generation++;
    const { closeDropdown, selectionChanged } = options;
    selectionChanged(undefined);
    closeDropdown();
  };

  const moveSelection = async (direction: 'up' | 'down', event: KeyboardEvent) => {
    const owner = generation;
    const currentContainer = options.isOpen ? options.container : undefined;
    const { openDropdown } = options;
    if (openDropdown) {
      openDropdown(event);
      await tick();
    }
    if (destroyed || owner !== generation || !options.isOpen) {
      return;
    }

    const { container, selectedId, selectionChanged } = options;
    if (!container || (currentContainer && currentContainer !== container)) {
      return;
    }
    const children = getItems(container);
    if (children.length === 0) {
      return;
    }

    const currentIndex = children.findIndex((item) => item.id === selectedId);
    let newIndex = currentIndex + (direction === 'up' ? -1 : 1);
    if (newIndex < 0) {
      newIndex = children.length - 1;
    } else if (newIndex >= children.length) {
      newIndex = 0;
    }
    const selectedNode = children[newIndex];
    selectedNode.scrollIntoView({ block: 'nearest' });
    selectionChanged(selectedNode.id);
  };

  /** Home and End belong to an open menu only; a closed one leaves them to the page. */
  const moveToEdge = (edge: 'first' | 'last', event: KeyboardEvent) => {
    const { selectionChanged, container, isOpen } = options;
    if (!isOpen || !container) {
      return;
    }
    event.preventDefault();

    const selectedNode = getItems(container).at(edge === 'first' ? 0 : -1);
    if (!selectedNode) {
      return;
    }
    selectedNode.scrollIntoView({ block: 'nearest' });

    selectionChanged(selectedNode.id);
  };

  const onEscape = (event: KeyboardEvent) => {
    const { onEscape } = options;
    if (onEscape) {
      onEscape(event);
      return;
    }
    event.stopPropagation();
    close();
  };

  const handleClick = (event: KeyboardEvent) => {
    const { selectedId, isOpen, closeDropdown } = options;
    if (isOpen && !selectedId) {
      generation++;
      closeDropdown();
      return;
    }
    if (!selectedId) {
      void moveSelection('down', event);
      return;
    }
    const currentEl = getCurrentElement();
    currentEl?.click();
  };

  const { destroy } = shortcuts(node, [
    { shortcut: { key: 'ArrowUp' }, onShortcut: (event) => moveSelection('up', event) },
    { shortcut: { key: 'ArrowDown' }, onShortcut: (event) => moveSelection('down', event) },
    { shortcut: { key: 'Home' }, onShortcut: (event) => moveToEdge('first', event), preventDefault: false },
    { shortcut: { key: 'End' }, onShortcut: (event) => moveToEdge('last', event), preventDefault: false },
    { shortcut: { key: 'Escape' }, onShortcut: (event) => onEscape(event), preventDefault: false },
    { shortcut: { key: ' ' }, onShortcut: (event) => handleClick(event) },
    { shortcut: { key: 'Enter' }, onShortcut: (event) => handleClick(event) },
  ]);

  return {
    update(newOptions) {
      if (isOpen && !newOptions.isOpen) {
        generation++;
      }
      isOpen = newOptions.isOpen;
      options = newOptions;
    },
    destroy() {
      destroyed = true;
      destroy?.();
    },
  };
};
