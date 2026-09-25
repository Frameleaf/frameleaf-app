import { isControlTarget, isDialogOpen, isTypingTarget } from '$lib/frameleaf/viewer-keys';

describe('viewer keys', () => {
  const make = (html: string) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.append(host);
    return host.firstElementChild!;
  };

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('leaves fields, comboboxes, sliders and videos their own keys', () => {
    expect(isTypingTarget(make('<input type="search" />'))).toBe(true);
    expect(isTypingTarget(make('<textarea></textarea>'))).toBe(true);
    expect(isTypingTarget(make('<div role="combobox"></div>'))).toBe(true);
    expect(isTypingTarget(make('<div role="slider"></div>'))).toBe(true);
    expect(
      isTypingTarget(make('<div contenteditable="true"><span id="inner"></span></div>').querySelector('#inner')),
    ).toBe(true);
    expect(isTypingTarget(make('<button>Go</button>'))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('lets Space press a focused control instead of playing the slideshow', () => {
    expect(isControlTarget(make('<button>Go</button>'))).toBe(true);
    expect(isControlTarget(make('<a href="/x">x</a>'))).toBe(true);
    expect(isControlTarget(make('<li role="menuitem">x</li>'))).toBe(true);
    expect(isControlTarget(make('<input />'))).toBe(true);
    expect(isControlTarget(make('<div tabindex="0"></div>'))).toBe(false);
    expect(isControlTarget(document.body)).toBe(false);
  });

  it('knows when a modal dialog is open over the viewer', () => {
    expect(isDialogOpen()).toBe(false);
    const closed = make('<dialog></dialog>');
    expect(isDialogOpen()).toBe(false);
    closed.setAttribute('open', '');
    expect(isDialogOpen()).toBe(true);
    closed.remove();
    make('<div role="dialog" aria-modal="true"></div>');
    expect(isDialogOpen()).toBe(true);
  });
});
