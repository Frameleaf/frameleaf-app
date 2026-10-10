import { tick } from 'svelte';
import { contextMenuNavigation } from '$lib/actions/context-menu-navigation';

/**
 * The viewer's More menu is grouped: heading rows sit between the options in the same list
 * (ViewerMenuGroupLabel). The keys must move through the options only.
 */
describe('contextMenuNavigation action', () => {
  const setup = ({ isOpen = true }: { isOpen?: boolean } = {}) => {
    const node = document.createElement('div');
    node.tabIndex = -1;
    const container = document.createElement('ul');
    container.innerHTML = `
      <li role="presentation">Download</li>
      <li role="menuitem" id="download">Download</li>
      <li role="menuitem" id="copy">Copy image</li>
      <li role="presentation">Organize</li>
      <li role="menuitem" id="archive">Archive</li>
      <hr />
      <li role="menuitem" id="slideshow">Play slideshow</li>
    `;
    node.append(container);
    document.body.append(node);

    const clicked: string[] = [];
    for (const item of container.querySelectorAll('[role="menuitem"]')) {
      item.addEventListener('click', () => {
        clicked.push(item.id);
      });
    }

    const options = {
      closeDropdown: vi.fn(),
      container: container as HTMLElement,
      isOpen,
      selectedId: undefined as string | undefined,
      // The action reads the selection back from the same options object, as ButtonContextMenu's store does.
      selectionChanged: (id: string | undefined) => {
        options.selectedId = id;
      },
    };
    const action = contextMenuNavigation(node, options);

    const press = async (key: string) => {
      node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      await tick();
    };

    return {
      options,
      clicked,
      press,
      destroy: () => {
        if (action) {
          action.destroy?.();
        }
        node.remove();
      },
    };
  };

  it('moves down through the options and skips the heading rows', async () => {
    const { options, press, destroy } = setup();

    await press('ArrowDown');
    expect(options.selectedId).toBe('download');
    await press('ArrowDown');
    expect(options.selectedId).toBe('copy');
    await press('ArrowDown');
    expect(options.selectedId).toBe('archive');
    await press('ArrowDown');
    expect(options.selectedId).toBe('slideshow');
    await press('ArrowDown');
    expect(options.selectedId).toBe('download');

    destroy();
  });

  it('moves up through the options, starting from the last one', async () => {
    const { options, press, destroy } = setup();

    await press('ArrowUp');
    expect(options.selectedId).toBe('slideshow');
    await press('ArrowUp');
    expect(options.selectedId).toBe('archive');
    await press('ArrowUp');
    expect(options.selectedId).toBe('copy');
    await press('ArrowUp');
    expect(options.selectedId).toBe('download');
    await press('ArrowUp');
    expect(options.selectedId).toBe('slideshow');

    destroy();
  });

  it('jumps to the first and the last option with Home and End', async () => {
    const { options, press, destroy } = setup();

    await press('End');
    expect(options.selectedId).toBe('slideshow');
    await press('Home');
    expect(options.selectedId).toBe('download');

    destroy();
  });

  it('leaves Home and End alone while the menu is closed', async () => {
    const { options, press, destroy } = setup({ isOpen: false });

    await press('End');
    expect(options.selectedId).toBeUndefined();
    await press('Home');
    expect(options.selectedId).toBeUndefined();

    destroy();
  });

  it('activates the highlighted option with Enter', async () => {
    const { clicked, press, destroy } = setup();

    await press('ArrowDown');
    await press('ArrowDown');
    await press('Enter');
    expect(clicked).toEqual(['copy']);

    destroy();
  });
});
