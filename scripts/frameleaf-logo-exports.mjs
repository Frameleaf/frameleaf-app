#!/usr/bin/env node
// FL-135: the single Frameleaf logo/icon generator. Renders every raster/ICO export for web
// (favicons, apple-touch and maskable manifest icons, email header), docs and, on request, mobile
// from the supplied brand kit (design/frameleaf/brand-kit, never modified), records each output's
// provenance in design/frameleaf/derivatives/exports.json, and re-copies the verbatim SVG copies
// the web app ships so they cannot drift from the kit.
//
// `sharp` is resolved from server/node_modules (it is a server dependency, not a web one), so run
// this from a checkout where `pnpm install` has been done:
//
//   node scripts/frameleaf-logo-exports.mjs            # web + docs
//   node scripts/frameleaf-logo-exports.mjs --mobile   # also mobile/ assets and native resources
//
// Visually qualify outputs against light/dark chrome before committing, per
// docs/docs/developer/frameleaf-plan/06-brand-assets.md. The only non-kit source is
// design/frameleaf/derivatives/frameleaf-logo-light.svg, the tracked dark-ink derivative of
// frameleaf-logo-dark.svg ("Frame" lettering filled with the kit's #111D26 canvas colour) that
// light surfaces (README, docs, email) need because the kit ships no light-background wordmark.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const includeMobile = process.argv.includes("--mobile");
const sharp = createRequire(join(root, "server/package.json"))("sharp");
const kit = "design/frameleaf/brand-kit";
const src = {
  symbol: `${kit}/frameleaf-symbol.svg`,
  symbolWhite: `${kit}/frameleaf-symbol-white.svg`,
  appIcon: `${kit}/frameleaf-app-icon.svg`,
  logoDark: `${kit}/frameleaf-logo-dark.svg`,
  logoLight: "design/frameleaf/derivatives/frameleaf-logo-light.svg",
};
const CANVAS = "#111d26";
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const read = (path) => readFileSync(join(root, path));

// Square tile without rounded corners, for platforms that apply their own mask (iOS, PWA maskable).
// symbolScale shrinks the symbol into a maskable safe zone.
const fullBleed = (symbolScale = 0.6417) => {
  const offset = (240 - 237 * symbolScale) / 2;
  return Buffer.from(
    read(src.appIcon)
      .toString()
      .replaceAll('rx="62"', 'rx="0"')
      .replace(
        "translate(44 44) scale(0.6417)",
        `translate(${offset} ${offset}) scale(${symbolScale})`,
      ),
  );
};

async function raster(
  svg,
  width,
  height,
  { pad = 0, background, trimLeft } = {},
) {
  let image = sharp(svg, { density: 300 });
  if (trimLeft) {
    // Wordmark only: drop the symbol (first 280 of 1080 viewBox units) and trim transparent edges.
    const meta = await image.metadata();
    const left = Math.round(meta.width * trimLeft);
    const cropped = await image
      .extract({ left, top: 0, width: meta.width - left, height: meta.height })
      .png()
      .toBuffer();
    return sharp(await sharp(cropped).trim().png().toBuffer())
      .resize({ height })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }
  const innerW = Math.round(width * (1 - 2 * pad));
  const innerH = Math.round(height * (1 - 2 * pad));
  let out = sharp(
    await image
      .resize(innerW, innerH, { fit: "contain", background: "#0000" })
      .png()
      .toBuffer(),
  ).extend({
    top: Math.floor((height - innerH) / 2),
    bottom: Math.ceil((height - innerH) / 2),
    left: Math.floor((width - innerW) / 2),
    right: Math.ceil((width - innerW) / 2),
    background: "#0000",
  });
  if (background) {
    out = sharp(await out.png().toBuffer()).flatten({ background });
  }
  return out.png({ compressionLevel: 9 }).toBuffer();
}

// Minimal ICO container holding PNG payloads (supported by all current browsers).
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size % 256, entry);
    header.writeUInt8(size % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map(({ data }) => data)]);
}

const records = [];
function write(path, data, source, note) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), data);
  records.push({
    path,
    source,
    sourceSha256: sha(read(source)),
    note,
    sha256: sha(data),
  });
}
const copy = (from, path) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  copyFileSync(join(root, from), join(root, path));
  records.push({
    path,
    source: from,
    sourceSha256: sha(read(from)),
    note: "byte-for-byte copy",
    sha256: sha(read(path)),
  });
};
const png = async (
  path,
  source,
  width,
  height,
  options = {},
  svg = read(source),
) =>
  write(
    path,
    await raster(svg, width, height, options),
    source,
    `${width || "auto"}x${height}${options.pad ? ` pad ${options.pad}` : ""}${options.background ? ` on ${options.background}` : ""}${options.trimLeft ? " wordmark only" : ""}${options.note ? `; ${options.note}` : ""}`,
  );

// Web: verbatim SVG copies imported by the app shell (Logo.svelte, Brand.svelte, About) and the SVG favicon.
for (const name of [
  "frameleaf-symbol.svg",
  "frameleaf-logo-dark.svg",
  "frameleaf-logo-white.svg",
]) {
  copy(`${kit}/${name}`, `web/src/lib/assets/frameleaf/${name}`);
}
copy(src.symbol, "web/static/favicon.svg");
// Email header, served by the Frameleaf server itself (server/src/emails/components/frameleaf-logo.tsx).
await png(
  "web/static/frameleaf/frameleaf-logo-light.png",
  src.logoLight,
  540,
  132,
);
for (const size of [16, 32, 48, 96, 144]) {
  await png(`web/static/favicon-${size}.png`, src.symbol, size, size);
}
await png("web/static/favicon.png", src.symbol, 512, 512);
const favicon = ico(
  await Promise.all(
    [16, 32, 48].map(async (size) => ({
      size,
      data: await raster(read(src.symbol), size, size),
    })),
  ),
);
for (const path of ["web/static/favicon.ico", "docs/static/img/favicon.ico"]) {
  write(path, favicon, src.symbol, "ICO with 16/32/48 PNG payloads");
}
await png(
  "web/static/apple-icon-180.png",
  src.appIcon,
  180,
  180,
  { note: "square full-bleed tile" },
  fullBleed(),
);
for (const size of [192, 512]) {
  await png(
    `web/static/manifest-icon-${size}.maskable.png`,
    src.appIcon,
    size,
    size,
    { note: "full-bleed tile, symbol in maskable safe zone" },
    fullBleed(0.52),
  );
}

// Docs
await png("docs/static/img/favicon.png", src.symbol, 180, 180);
copy(src.logoLight, "docs/static/img/frameleaf-logo-inline-light.svg");
copy(src.logoDark, "docs/static/img/frameleaf-logo-inline-dark.svg");

if (includeMobile) {
  // Mobile (Flutter assets)
  await png("mobile/assets/frameleaf-symbol.png", src.symbol, 1024, 1024);
  await png(
    "mobile/assets/frameleaf-logo-inline-light.png",
    src.logoLight,
    3038,
    742,
  );
  await png(
    "mobile/assets/frameleaf-logo-inline-dark.png",
    src.logoDark,
    3038,
    742,
  );
  await png(
    "mobile/assets/frameleaf-wordmark-light.png",
    src.logoLight,
    0,
    400,
    {
      trimLeft: 280 / 1080,
    },
  );
  await png("mobile/assets/frameleaf-wordmark-dark.png", src.logoDark, 0, 400, {
    trimLeft: 280 / 1080,
  });
  await png("mobile/assets/frameleaf-app-icon.png", src.appIcon, 1024, 1024);
  await png(
    "mobile/assets/frameleaf-app-icon-ios.png",
    src.appIcon,
    1024,
    1024,
    { note: "square full-bleed tile" },
    fullBleed(),
  );
  await png("mobile/assets/frameleaf-splash.png", src.symbol, 320, 320, {
    pad: 0.1,
  });
  await png(
    "mobile/assets/frameleaf-splash-android12.png",
    src.symbol,
    1152,
    1152,
    { pad: 0.28 },
  );

  // Mobile (generated native resources; flutter_launcher_icons / flutter_native_splash equivalents)
  const res = "mobile/android/app/src/main/res";
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [density, scale] of Object.entries(densities)) {
    await png(
      `${res}/mipmap-${density}/ic_launcher.png`,
      src.appIcon,
      48 * scale,
      48 * scale,
    );
    await png(
      `${res}/drawable-${density}/notification_icon.png`,
      src.symbolWhite,
      24 * scale,
      24 * scale,
      { pad: 0.08 },
    );
    await png(
      `${res}/drawable-${density}/splash.png`,
      src.symbol,
      80 * scale,
      80 * scale,
      { pad: 0.1 },
    );
    for (const prefix of ["drawable", "drawable-night"]) {
      await png(
        `${res}/${prefix}-${density}/android12splash.png`,
        src.symbol,
        288 * scale,
        288 * scale,
        { pad: 0.28 },
      );
    }
  }
  for (const images of [
    "mobile/android/fastlane/metadata/android/en-US/images",
    "mobile/android/metadata/en-US/images",
  ]) {
    await png(
      `${images}/icon.png`,
      src.appIcon,
      512,
      512,
      { note: "square full-bleed tile" },
      fullBleed(),
    );
    await png(
      `${images}/featureGraphic.png`,
      `${kit}/frameleaf-logo-dark-tagline.svg`,
      1024,
      500,
      { pad: 0.12, background: CANVAS },
    );
  }
  const appIconSet = "mobile/ios/Runner/Assets.xcassets/AppIcon.appiconset";
  for (const file of readdirSync(join(root, appIconSet)).filter((name) =>
    name.endsWith(".png"),
  )) {
    const size = Number.parseInt(file, 10);
    await png(
      `${appIconSet}/${file}`,
      src.appIcon,
      size,
      size,
      { background: CANVAS, note: "square full-bleed tile, opaque" },
      fullBleed(),
    );
  }
  const launch = "mobile/ios/Runner/Assets.xcassets/LaunchImage.imageset";
  for (const [file, size] of [
    ["LaunchImage.png", 80],
    ["LaunchImage@2x.png", 160],
    ["LaunchImage@3x.png", 240],
  ]) {
    await png(`${launch}/${file}`, src.symbol, size, size, { pad: 0.1 });
  }
}

writeFileSync(
  join(root, "design/frameleaf/derivatives/exports.json"),
  JSON.stringify(
    {
      generator: "scripts/frameleaf-logo-exports.mjs",
      renderer: `sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}`,
      exports: records,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Wrote ${records.length} Frameleaf logo exports.`);
