import { fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { readFileSync } from 'node:fs';
import Menu from '$lib/components/frameleaf/Menu.svelte';

/**
 * FL-29 / FL-139: the September 24 sheet and menu chrome (apple-style.css:106-135, 211-217,
 * 303-332, 473-490). happy-dom does not compute styles, so the CSS contract is read from the
 * component sources; the behaviour the chrome must not break is exercised directly.
 */
const styles = (file: string) => {
  const source = readFileSync(`src/lib/components/frameleaf/${file}`, 'utf8');
  return source.slice(source.indexOf('<style>'));
};

describe('September 24 sheet chrome', () => {
  it('plays an exit before a dialog or menu goes (review finding 118)', () => {
    // Both leave through the shared helper, which finishes at once where nothing can animate.
    const dialog = readFileSync('src/lib/components/frameleaf/Dialog.svelte', 'utf8');
    expect(dialog).toContain("leave(dialog, 'sheet', finish, { backdrop: true })");
    const menu = readFileSync('src/lib/components/frameleaf/Menu.svelte', 'utf8');
    expect(menu).toContain("leave(menu, 'pop', () => (leaving = false))");
    // A menu that is fading out cannot be reached.
    expect(menu).toContain('inert={leaving && !open}');
  });

  it('gives dialogs 22px continuous corners, a spring rise and a blurred backdrop', () => {
    const css = styles('Dialog.svelte');
    expect(css).toMatch(/\.dialog {[^}]*border-radius: var\(--fl-radius-sheet\);/);
    // The Sheet pattern: the shared keyframes (base.css) on the token durations, 480ms on the spring.
    expect(css).toMatch(/fl-sheet-in var\(--fl-duration-sheet\) var\(--fl-spring\) both/);
    const baseline = readFileSync('src/lib/frameleaf/base.css', 'utf8');
    expect(baseline).toMatch(/@keyframes fl-sheet-in {\s*from {\s*translate: 0 40px;\s*scale: 0\.96;/);
    const tokens = readFileSync('src/lib/frameleaf/tokens.css', 'utf8');
    expect(tokens).toContain('--fl-duration-sheet: 480ms;');
    // The one scrim, with the token values repeated as fallbacks for ::backdrop.
    expect(css).toMatch(
      /\.dialog::backdrop {[^}]*background: var\(--fl-scrim, rgb\(0 0 0 \/ 40%\)\);[^}]*backdrop-filter: var\(--fl-scrim-blur, blur\(12px\)\);/,
    );
    expect(tokens).toContain('--fl-scrim: rgb(0 0 0 / 40%);');
    expect(tokens).toContain('--fl-scrim-blur: blur(12px);');
    // The continuous corner comes from app.css through `fl-continuous-corners`; the dialog grows its radius.
    expect(css).toMatch(
      /@supports \(corner-shape: squircle\) {\s*\.dialog {\s*border-radius: calc\(var\(--fl-radius-sheet\) \* 1\.8\);/,
    );
    const source = readFileSync('src/lib/components/frameleaf/Dialog.svelte', 'utf8');
    expect(source).toContain('class="frameleaf dialog fl-continuous-corners"');
  });

  it('gives every component surface that grows its radius the continuous-corner class', () => {
    // svelte-check's CSS service rejects `corner-shape` in component styles, so the shape is set by the
    // global `fl-continuous-corners` class (app.css) and each component keeps only its larger radius.
    const surfaces: Array<[string, string]> = [
      ['Dialog.svelte', 'dialog'],
      ['Pane.svelte', ''],
      ['CommandPalette.svelte', 'command-palette'],
      ['SearchChip.svelte', 'search-chip'],
      ['SearchPalette.svelte', 'search-palette'],
      ['settings/SettingsHost.svelte', 'tile'],
      ['settings/SettingsHost.svelte', 'cc-section'],
      ['settings/SettingsDirectory.svelte', 'cc-directory-list'],
      ['analytics/AnalyticsPanel.svelte', 'an-panel'],
      ['analytics/LibraryAnalytics.svelte', 'card'],
      ['analytics/LibraryHero.svelte', 'an-hero'],
    ];
    for (const [file, surface] of surfaces) {
      const source = readFileSync(`src/lib/components/frameleaf/${file}`, 'utf8');
      const css = styles(file);
      expect(css, file).not.toMatch(/corner-shape:\s*squircle;/);
      expect(css, file).toMatch(/@supports \(corner-shape: squircle\) {\s*[^{]+{\s*border-radius:/);
      const tags = [...source.slice(0, source.indexOf('<style>')).matchAll(/class="([^"]*)"/g)].map(([, value]) =>
        value.split(/\s+/),
      );
      // Every element drawn with the surface's class carries it (Pane styles its bare <section>).
      const owners = surface ? tags.filter((classes) => classes.includes(surface)) : tags;
      expect(owners.length, `${file} .${surface}`).toBeGreaterThan(0);
      for (const classes of owners) {
        expect(classes, `${file} .${surface}`).toContain('fl-continuous-corners');
      }
    }
  });

  it('turns the dialog rise into a crossfade under Reduce Motion and drops the blur for Increase Contrast', () => {
    const css = styles('Dialog.svelte');
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) {\s*\.dialog {\s*animation: fl-fade-in var\(--fl-duration-reduced\) var\(--fl-ease\) both !important;/,
    );
    expect(css).toMatch(
      /@media \(prefers-contrast: more\), \(prefers-reduced-transparency: reduce\) {\s*\.dialog::backdrop {[^}]*backdrop-filter: none;/,
    );
  });

  it('opens menus on the spring and crossfades them under Reduce Motion', () => {
    const css = styles('Menu.svelte');
    // The Pop pattern: a short fade while the popup grows from 0.9 on the 320ms spring.
    expect(css).toMatch(/fl-pop-in var\(--fl-duration-pop\) var\(--fl-spring\) both;/);
    expect(readFileSync('src/lib/frameleaf/tokens.css', 'utf8')).toContain('--fl-duration-pop: 320ms;');
    // Logical origin: the corner the popup hangs from flips in right-to-left layouts.
    expect(css).toMatch(/\[role='menu'\]:dir\(rtl\) {\s*transform-origin: top right;/);
    expect(css).toMatch(/\[role='menu'\]\.end:dir\(rtl\) {\s*transform-origin: top left;/);
    expect(readFileSync('src/lib/frameleaf/base.css', 'utf8')).toMatch(
      /@keyframes fl-pop-in {\s*from {\s*scale: 0\.9;/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) {\s*\[role='menu'\] {\s*animation: fl-fade-in var\(--fl-duration-reduced\) var\(--fl-ease\) both !important;/,
    );
  });

  it('keeps the menu keyboard contract: focus the first item, Escape closes and returns focus', async () => {
    const children = createRawSnippet(() => ({
      render: () => '<div><button type="button" role="menuitem">Rename</button></div>',
    }));
    render(Menu, { label: 'Album options', children });

    const trigger = screen.getByRole('button', { name: 'Album options' });
    await fireEvent.click(trigger);
    const item = await screen.findByRole('menuitem', { name: 'Rename' });
    expect(document.activeElement).toBe(item);

    await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('skips disabled menu items when opening and moving with the keyboard', async () => {
    const children = createRawSnippet(() => ({
      render: () => `<div><button role="menuitem" aria-disabled="true">Unavailable first</button>
        <button role="menuitem">Rename</button>
        <button role="menuitem" disabled>Unavailable middle</button>
        <button role="menuitem">Delete</button>
        <button role="menuitem" aria-disabled="true">Unavailable last</button></div>`,
    }));
    render(Menu, { label: 'Album options', children });

    const trigger = screen.getByRole('button', { name: 'Album options' });
    await fireEvent.click(trigger);
    const rename = screen.getByRole('menuitem', { name: 'Rename' });
    const deleteItem = screen.getByRole('menuitem', { name: 'Delete' });
    expect(rename).toHaveFocus();

    await fireEvent.keyDown(rename, { key: 'ArrowDown' });
    expect(deleteItem).toHaveFocus();
    await fireEvent.keyDown(deleteItem, { key: 'ArrowDown' });
    expect(rename).toHaveFocus();
    await fireEvent.keyDown(rename, { key: 'ArrowUp' });
    expect(deleteItem).toHaveFocus();
    await fireEvent.keyDown(deleteItem, { key: 'Home' });
    expect(rename).toHaveFocus();
    await fireEvent.keyDown(rename, { key: 'End' });
    expect(deleteItem).toHaveFocus();
  });

  it('keeps an all-disabled menu dismissible with Escape', async () => {
    const children = createRawSnippet(() => ({
      render: () => `<div><button role="menuitem" aria-disabled="true">Unavailable</button>
        <button role="menuitem" disabled>Also unavailable</button></div>`,
    }));
    render(Menu, { label: 'Album options', children });

    const trigger = screen.getByRole('button', { name: 'Album options' });
    trigger.focus();
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveFocus();

    await fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('keeps drag handles out of the button press scale', () => {
    const tagger = readFileSync('src/lib/components/frameleaf/FaceTagger.svelte', 'utf8');
    expect(tagger).toContain('class="ft-face-move fl-no-press"');
    expect(tagger).toContain('class="ft-resize fl-no-press"');
    const mask = readFileSync('src/lib/components/frameleaf/editor/MaskOverlay.svelte', 'utf8');
    const handles = [...mask.matchAll(/class="ed-mask-handle[^"]*"/g)].map(([value]) => value);
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) {
      expect(handle).toContain('fl-no-press');
    }
  });
});
