import { shortcuts } from '$lib/actions/shortcut';

describe('shortcuts', () => {
  const unbind: Array<() => void> = [];
  const bind = (node: Document | HTMLElement = document) => {
    const onShortcut = vi.fn();
    const action = shortcuts(node as HTMLElement, [
      { shortcut: { key: '3' }, onShortcut },
      { shortcut: { key: 'p' }, onShortcut },
    ]);
    unbind.push(() => action.destroy?.());
    return { onShortcut };
  };

  const press = (target: EventTarget, key: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  const make = (html: string) => {
    document.body.insertAdjacentHTML('beforeend', html);
    return document.body.lastElementChild as HTMLElement;
  };

  afterEach(() => {
    for (const destroy of unbind.splice(0)) {
      destroy();
    }
    document.body.replaceChildren();
  });

  it('fires for keys pressed outside fields and dialogs', () => {
    const { onShortcut } = bind();
    press(document.body, '3');
    press(make('<button>Go</button>'), 'p');
    expect(onShortcut).toHaveBeenCalledTimes(2);
  });

  // LIB-02: a digit typed in Edit date and time's Time field set the star rating, and the "p" of
  // "p.m." opened Tag people
  it.each(['time', 'number', 'search', 'url', 'tel', 'month', 'week', 'text', 'date'])(
    'leaves keys typed in an input of type %s to the field',
    (type) => {
      const { onShortcut } = bind();
      const input = make(`<input type="${type}" />`);
      press(input, '3');
      press(input, 'p');
      expect(onShortcut).not.toHaveBeenCalled();
    },
  );

  it('leaves keys to selects, text areas and editable content', () => {
    const { onShortcut } = bind();
    press(make('<select><option>a</option></select>'), 'p');
    press(make('<textarea></textarea>'), 'p');
    press(make('<div contenteditable="true"><span>x</span></div>').querySelector('span')!, 'p');
    expect(onShortcut).not.toHaveBeenCalled();
  });

  it('keeps keys pressed in an open dialog away from shortcuts bound outside it', () => {
    const { onShortcut } = bind();
    const dialog = make('<dialog open><button>Save</button></dialog>');
    press(dialog.querySelector('button')!, '3');
    // nothing focused, but the dialog is still open over the page
    press(document.body, 'p');
    expect(onShortcut).not.toHaveBeenCalled();
  });

  it('still fires shortcuts bound inside the open dialog', () => {
    const dialog = make('<dialog open><div><button>Save</button></div></dialog>');
    const { onShortcut } = bind(dialog.querySelector('div')!);
    press(dialog.querySelector('button')!, '3');
    expect(onShortcut).toHaveBeenCalledTimes(1);
  });

  it('fires again once the dialog has closed', () => {
    const { onShortcut } = bind();
    const dialog = make('<dialog open></dialog>');
    dialog.removeAttribute('open');
    press(document.body, '3');
    expect(onShortcut).toHaveBeenCalledTimes(1);
  });
});
