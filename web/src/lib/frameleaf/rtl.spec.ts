import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * FL-139: layout CSS is written in logical properties, so Arabic, Hebrew and Persian mirror it and
 * left-to-right looks the same. A declaration that must stay physical (a centring pair with
 * `left: 50%`, a shape drawn from borders) says so with a `rtl: physical` comment on its line.
 */
const PHYSICAL =
  /(?<![\w-])(?:(?:margin|padding)-(?:left|right)|border-(?:left|right)(?:-(?:color|width|style))?|border-(?:top|bottom)-(?:left|right)-radius)\s*:|(?<![\w-])text-align\s*:\s*(?:left|right)\b/;

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );

/** The CSS in a file: the whole of a stylesheet, or a component's style blocks and static style attributes. */
const cssOf = (path: string, source: string) =>
  path.endsWith('.css')
    ? source
    : [
        ...[...source.matchAll(/<style[^>]*>([\S\s]*?)<\/style>/g)].map((match) => match[1]),
        ...[...source.matchAll(/\sstyle="([^"{}]*)"/g)].map((match) => match[1]),
      ].join('\n');

describe('right-to-left layout (FL-139)', () => {
  it('writes layout CSS in logical properties', () => {
    const offenders: string[] = [];
    for (const path of [...files('src/lib'), ...files('src/routes'), 'src/app.css']) {
      if (!/\.(css|svelte)$/.test(path)) {
        continue;
      }
      for (const line of cssOf(path, readFileSync(path, 'utf8')).split('\n')) {
        if (PHYSICAL.test(line) && !line.includes('rtl: physical')) {
          offenders.push(`${path}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('slides a switch knob the other way in right-to-left', () => {
    const missing: string[] = [];
    for (const path of [...files('src/lib'), ...files('src/routes')]) {
      if (!/\.(css|svelte)$/.test(path)) {
        continue;
      }
      const css = cssOf(path, readFileSync(path, 'utf8'));
      for (const [, selector, distance] of css.matchAll(
        /([^{}]*switch[^{}]*)\{[^{}]*translateX\((\d[\d.]*(?:px|rem))\)/g,
      )) {
        if (!css.includes(`translateX(-${distance})`)) {
          missing.push(`${path}: ${selector.trim()} moves ${distance} with no right-to-left counterpart`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('leaves mirroring arrows to the Icon patch, so none is flipped twice', () => {
    const swapped: string[] = [];
    for (const path of [...files('src/lib'), ...files('src/routes')]) {
      if (!/\.(svelte|ts)$/.test(path) || path.endsWith('.spec.ts')) {
        continue;
      }

      const source = readFileSync(path, 'utf8');
      if (/rtl\s*\?\s*mdi(?:Arrow|Chevron|Menu)/.test(source)) {
        swapped.push(path);
      }
    }
    expect(swapped).toEqual([]);
  });

  it('mirrors the marked icons in a right-to-left page', () => {
    expect(readFileSync('src/app.css', 'utf8')).toMatch(/\[dir='rtl'\] svg\[data-rtl-mirror\] {\s*scale: -1 1;/);
  });
});
