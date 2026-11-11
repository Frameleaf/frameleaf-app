import { readFileSync } from 'node:fs';

/** The `<style>` rule for `selector` in EmptyState.svelte (component styles are not applied under jsdom). */
const rule = (selector: string) => {
  const source = readFileSync('src/lib/components/frameleaf/EmptyState.svelte', 'utf8');
  const style = source.slice(source.indexOf('<style>'));
  const match = new RegExp(String.raw`\n  ${selector.replaceAll('.', String.raw`\.`)} \{([^}]*)\}`).exec(style);
  return match?.[1] ?? '';
};

// FL-1457 (prototype messy-1110.css `.fl-empty`): a 15px semibold title over 13px text, the prototype's sizes.
describe('EmptyState type sizes (FL-1457)', () => {
  it('draws the title at 15px semibold', () => {
    expect(rule('h2')).toMatch(/font: 600 15px \/ 1\.3 var\(--fl-family-ui\);/);
  });

  it('draws the text at 13px (the callout size) with a 1.5 line height', () => {
    const block = rule('.fl-empty-state');
    expect(block).toContain('font: var(--fl-type-callout);');
    expect(block).toContain('line-height: 1.5;');
  });
});
