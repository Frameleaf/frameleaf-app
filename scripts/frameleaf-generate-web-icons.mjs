#!/usr/bin/env node
/**
 * FL-135: derive the web app's raster favicon/manifest/apple-touch icons from the
 * authoritative Frameleaf brand kit, without ever hand-redrawing the source artwork.
 *
 * This machine (the operator's Mac, 7 GB RAM) has no SVG rasterizer and this repository's
 * policy forbids running Node builds/installs here, so this script is written but not run
 * as part of FL-135; run it on GitHub Actions (or any machine with `pnpm --dir web install`
 * already done) after review:
 *
 *   node scripts/frameleaf-generate-web-icons.mjs
 *
 * Sources (never modified by this script):
 *   - design/frameleaf/brand-kit/frameleaf-symbol.svg   -> favicon PNG set + favicon.ico
 *   - design/frameleaf/brand-kit/frameleaf-app-icon.svg -> apple-touch-icon + maskable manifest icons
 *
 * Outputs (derivatives only, all regenerated from the sources above):
 *   - web/static/favicon-16.png, favicon-32.png, favicon-48.png, favicon-96.png, favicon-144.png
 *   - web/static/favicon.ico (multi-resolution, from the 32/48 renders)
 *   - web/static/apple-icon-180.png
 *   - web/static/manifest-icon-192.maskable.png, manifest-icon-512.maskable.png
 *
 * Each run prints the source SHA-256 it derived from so the result stays traceable back to
 * the brand kit manifest (design/frameleaf/brand-kit/manifest.json). web/static/favicon.svg
 * is a verbatim copy of the symbol SVG and is not touched here; it already ships from FL-135.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const brandKit = resolve(root, "design/frameleaf/brand-kit");
const staticDir = resolve(root, "web/static");

const SYMBOL_SVG = resolve(brandKit, "frameleaf-symbol.svg");
const APP_ICON_SVG = resolve(brandKit, "frameleaf-app-icon.svg");

const FAVICON_SIZES = [16, 32, 48, 96, 144];

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  // Imported lazily so reading/printing the plan above doesn't require `sharp` to be
  // installed; only running the actual generation does.
  const sharp = (await import("sharp")).default;

  console.log(`Source: ${SYMBOL_SVG}`);
  console.log(`  sha256 ${await sha256(SYMBOL_SVG)}`);
  console.log(`Source: ${APP_ICON_SVG}`);
  console.log(`  sha256 ${await sha256(APP_ICON_SVG)}`);

  const symbolSvg = await readFile(SYMBOL_SVG);
  const appIconSvg = await readFile(APP_ICON_SVG);

  const pngBuffers = new Map();
  for (const size of FAVICON_SIZES) {
    const outPath = resolve(staticDir, `favicon-${size}.png`);
    const buffer = await sharp(symbolSvg, { density: 384 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    await writeFile(outPath, buffer);
    pngBuffers.set(size, buffer);
    console.log(`Wrote ${outPath}`);
  }

  // favicon.ico packs the 32/48 renders; sharp cannot emit .ico directly, so this step is
  // intentionally left to the `to-ico` (or equivalent) CI step rather than hand-rolled here.
  console.log(
    "favicon.ico: pack favicon-32.png and favicon-48.png with an .ico encoder (e.g. `to-ico`) as a follow-up CI step.",
  );

  const appleIconPath = resolve(staticDir, "apple-icon-180.png");
  await writeFile(
    appleIconPath,
    await sharp(appIconSvg, { density: 384 }).resize(180, 180).png().toBuffer(),
  );
  console.log(`Wrote ${appleIconPath}`);

  for (const size of [192, 512]) {
    const outPath = resolve(staticDir, `manifest-icon-${size}.maskable.png`);
    await writeFile(
      outPath,
      await sharp(appIconSvg, { density: 384 }).resize(size, size).png().toBuffer(),
    );
    console.log(`Wrote ${outPath}`);
  }

  console.log(
    "Done. Visually qualify every output against light/dark browser chrome before committing, " +
      "per docs/docs/developer/frameleaf-plan/06-brand-assets.md.",
  );
}

await main();
