// Regenerates ../../references captures and ../../animations walkthroughs from this template.
// Usage: pnpm capture [stills | animations | <name> ...]   (animations need ffmpeg and gifski)
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const referencesDir = path.resolve(root, "../references");
const animationsDir = path.resolve(root, "../animations");
const DESKTOP = [1487, 1058]; // viewport.html "Selected desktop"
const TABLET = [1280, 900];
const PHONE = [390, 844, 2];
const USERS = "/?screen=admin&settings=users&section=accounts";
const DUPLICATES = "/?screen=admin&settings=utilities&section=duplicates";

const viewer = (app) => app.getByRole("dialog", { name: /Media viewer/ });

async function showInfo(act, app, after) {
  const info = viewer(app)
    .getByRole("button", { name: "Information", exact: true })
    .first();
  if ((await info.getAttribute("aria-pressed")) !== "true")
    await act.click(info, after);
}

// Viewer → Information → People → Add, then drag a region given as image fractions [left, top, right, bottom].
async function drawFace(act, app, [left, top, right, bottom]) {
  await showInfo(act, app);
  await act.click(
    viewer(app).getByRole("button", { name: "Add person" }),
    1000,
  );
  const tagger = app.getByRole("dialog", { name: "Tag people" });
  const photo = tagger.locator(".ft-stage img");
  await photo.waitFor();
  await app.waitForTimeout(800); // let the dialog finish opening before measuring the photo
  const draw = tagger.getByRole("button", { name: "Draw face" });
  if ((await draw.getAttribute("aria-pressed")) !== "true")
    await act.click(draw);
  const box = await photo.boundingBox();
  const at = (x, y) => ({
    x: box.x + box.width * x,
    y: box.y + box.height * y,
  });
  await act.drag(at(left, top), at(right, bottom));
  return tagger;
}

async function openAccount(act, app, tab) {
  await act.click(app.getByText("jamie@example.test"));
  await act.click(
    app.getByLabel("Detail sections").getByRole("button", { name: tab }),
  );
  await app
    .getByLabel("Jamie details")
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
}

async function trimIn(act, app) {
  await app.getByLabel("In (seconds)").fill("2");
  await app.getByLabel("In (seconds)").blur();
}

const stills = [
  { name: "desktop-dark" },
  { name: "desktop-light", theme: "light" },
  {
    name: "timeline-dark",
    layout: "timeline",
    run: (act, app) =>
      act.click(app.getByRole("button", { name: "Days", exact: true })),
  },
  { name: "explore-light", theme: "light", path: "/?screen=explore" },
  {
    name: "face-tagging-dark",
    async run(act, app) {
      await act.click(
        app.getByRole("button", { name: "Open Emma at the lake" }),
      );
      const tagger = await drawFace(act, app, [0.335, 0.31, 0.525, 0.63]);
      await act.click(
        tagger.getByRole("button", { name: "Emma", exact: true }),
      );
    },
  },
  { name: "library-phone", size: PHONE },
  {
    name: "phone-quick-edit",
    size: PHONE,
    path: "/?screen=quick",
    run: trimIn,
  },
  { name: "tablet-studio", size: TABLET, path: "/?screen=studio" },
  { name: "settings-11-overview-dark", path: "/?screen=admin" },
  {
    name: "settings-09-tablet-analytics",
    size: TABLET,
    path: "/?screen=admin&settings=analytics",
  },
  {
    name: "settings-22-account-features-dark",
    path: USERS,
    run: (act, app) => openAccount(act, app, "features"),
  },
  {
    name: "settings-23-account-preferences-light",
    theme: "light",
    path: USERS,
    run: (act, app) => openAccount(act, app, "preferences"),
  },
  { name: "settings-24-duplicates-owner-only", path: DUPLICATES },
  {
    name: "settings-18-burst-contact-sheet-dark",
    path: DUPLICATES,
    async run(act, app) {
      await act.click(
        app.getByRole("button", { name: /Forest walk · burst/ }).first(),
      );
      await act.click(app.getByLabel("Keep frame 3", { exact: true }));
      await act.click(app.getByLabel("Keep frame 8", { exact: true }));
      await app.getByLabel("Group contact sheet").scrollIntoViewIfNeeded();
    },
  },
];

const dialog = (app) => app.locator("dialog[open]");
const palette = (app) =>
  app.getByRole("button", { name: "Search library", exact: true }).first();

const animations = [
  {
    name: "01-library-views",
    async steps(act, app) {
      await act.say("A collection opens in Browse: a dense, square photo grid");
      await act.pause(2400);
      await act.say("Timeline groups photos and videos by day");
      await act.click(
        app.getByRole("button", { name: "Timeline", exact: true }),
        900,
      );
      await act.click(
        app.getByRole("button", { name: "Days", exact: true }),
        1800,
      );
      await act.say("Work view keeps ratings and file names visible");
      await act.click(
        app.getByRole("button", { name: "Work", exact: true }),
        2000,
      );
      await act.say("Select a few photos to compare them side by side");
      await act.click(
        app.getByRole("checkbox", { name: "Select Moraine Lake" }),
        500,
        { force: true }, // revealed on hover
      );
      await act.click(
        app.getByRole("checkbox", { name: "Select Lake reflection" }),
        700,
        { force: true }, // revealed on hover
      );
      await act.click(
        app.getByRole("button", { name: "Compare", exact: true }),
        2800,
      );
      await act.click(
        app.getByRole("button", { name: "Done", exact: true }),
        900,
      );
      await act.say("Light mode gets the same care");
      await act.click(
        app.getByRole("button", { name: /theme/i }).first(),
        2600,
      );
    },
  },
  {
    name: "02-search-and-filters",
    async steps(act, app) {
      await act.say(
        "Search opens a palette with live results, dates and facets",
      );
      await act.pause(1200);
      await act.click(palette(app), 600);
      await act.say("Pick a person by their face photo, then add words");
      await act.click(
        dialog(app).getByRole("button", { name: "Emma", exact: true }),
        1200,
      );
      await act.type("lake", 1800);
      await act.click(
        dialog(app).getByRole("button", { name: /^Show \d+ results?$/ }),
        1800,
      );
      await act.say("Text in photos reads signs and documents");
      await act.click(palette(app), 600);
      await act.click(
        dialog(app).getByRole("button", { name: "Clear search" }),
        400,
      );
      await act.click(
        dialog(app).getByRole("button", { name: /Search mode/ }),
        500,
      );
      await act.click(
        app
          .getByRole("menuitemradio", { name: "Text in photos" })
          .or(app.getByRole("menuitem", { name: "Text in photos" }))
          .first(),
        500,
      );
      await act.click(dialog(app).getByLabel("Search query"), 200);
      await act.type("agnes", 1300);
      await act.click(
        dialog(app).getByRole("button", { name: /^Show \d+ results?$/ }),
        1400,
      );
      await act.click(
        app.getByRole("button", { name: "Open Trailhead directions" }),
        1000,
      );
      await showInfo(act, app, 3000);
    },
  },
  {
    name: "03-viewer-and-faces",
    async steps(act, app) {
      await act.say("Open any photo full-size, with its details alongside");
      await act.pause(1200);
      await act.click(
        app.getByRole("button", { name: "Open Campfire evening" }),
        1000,
      );
      await showInfo(act, app, 1400);
      await act.say(
        "Step through with the arrow keys; the details follow along",
      );
      await act.press("ArrowRight", 1300);
      await act.press("ArrowRight", 1300);
      await act.press("ArrowLeft", 900);
      await act.press("ArrowLeft", 1300);
      await act.say("Missed a face? Draw around it, then name the person");
      const tagger = await drawFace(act, app, [0.755, 0.2, 0.855, 0.385]);
      await act.click(
        tagger.getByRole("button", { name: "Create person" }),
        500,
      );
      await act.click(tagger.getByLabel("New person name"), 200);
      await act.type("Alex", 600);
      await act.click(
        tagger.getByRole("button", { name: "Create and assign" }),
        900,
      );
      await act.click(
        tagger.getByRole("button", { name: "Save face tags" }),
        1400,
      );
      await showInfo(act, app, 600);
      await act.say(
        "The new person now appears with the photo, in People and in filters",
      );
      await act.pause(2800);
    },
  },
  {
    name: "04-quick-edit-to-studio",
    async steps(act, app) {
      await act.say("Quick edit trims a clip without leaving the library");
      await act.pause(1200);
      await act.click(
        app.getByRole("checkbox", { name: "Select Lake morning" }),
        500,
        { force: true }, // revealed on hover
      );
      await act.click(
        app.getByRole("button", { name: "Quick edit", exact: true }),
        1400,
      );
      await act.click(app.getByLabel("In (seconds)"), 300);
      await act.press("ControlOrMeta+A", 100);
      await act.type("2", 500);
      await app.getByLabel("In (seconds)").blur();
      await act.pause(1400);
      await act.say("Continue in Studio's multi-track timeline");
      await act.click(
        dialog(app).getByRole("button", { name: "Open in Studio" }),
        2600,
      );
      await act.say(
        "Restoration previews before and after, on your own hardware",
      );
      await act.click(app.getByRole("tab", { name: "Restore" }), 1400);
      await act.click(app.getByRole("radio", { name: "Creative" }), 1000);
      await act.click(app.getByRole("radio", { name: "4×" }), 1000);
      await act.choose(app.getByLabel("Local worker"), "lan", 1000);
      await act.click(
        app.getByRole("button", { name: "Preview 5 seconds" }),
        3000,
      );
    },
  },
  {
    name: "05-export-and-activity",
    path: "/?screen=studio",
    async steps(act, app) {
      await act.say("Exports run as tracked jobs");
      await act.pause(1200);
      await act.click(
        app.getByRole("button", { name: "Export", exact: true }),
        1200,
      );
      await act.click(
        dialog(app).getByRole("button", { name: "Export", exact: true }),
        1000,
      );
      await act.click(
        app.getByRole("button", { name: "Activity", exact: true }),
        2600,
      );
      await act.say(
        "Jobs pause when the connection drops and resume when it returns",
      );
      await act.click(
        app.getByRole("button", { name: "Simulate a disconnect" }),
        2200,
      );
      await act.click(
        app.getByRole("button", { name: "Reconnect" }).first(),
        2800,
      );
      await act.say("Back in the library, right where you left off");
      await act.click(
        app.getByRole("button", { name: "Library", exact: true }).first(),
        2600,
      );
    },
  },
  {
    name: "06-command-center",
    async steps(act, app) {
      await act.say(
        "Settings opens on a command center: health, storage and backups",
      );
      await act.pause(900);
      await act.click(
        app.getByRole("button", { name: "Settings", exact: true }),
        2600,
      );
      await act.say(
        "Analytics by account and library, with graphs, tables and export",
      );
      await act.click(
        app.getByRole("button", { name: "Library analytics" }),
        1600,
      );
      const scope = app
        .locator("label", { hasText: "Library scope" })
        .locator("select");
      await act.choose(scope, { label: "Family photo archive" }, 2200);
      await act.say(
        "Duplicate review: one key per decision, automatic advance, undo",
      );
      await act.click(
        app.getByRole("button", { name: "Utilities", exact: true }),
        1000,
      );
      await act.click(
        app.getByRole("button", { name: "Duplicate review" }).first(),
        1600,
      );
      await act.press("k", 1500);
      await act.press("1", 1500);
      await act.click(app.getByRole("button", { name: "Undo" }), 1800);
      await act.say("Trash keeps deleted items one click from restored");
      await act.click(
        app.getByRole("button", { name: "Trash", exact: true }),
        1600,
      );
      await act.click(
        app.getByRole("button", { name: "Restore", exact: true }).first(),
        2400,
      );
    },
  },
];

const seed = ({ key, value }) => {
  if (!localStorage.getItem(key)) localStorage.setItem(key, value);
};

async function settle(frame) {
  await frame.waitForLoadState("networkidle");
  await frame.evaluate(async () => {
    await document.fonts.ready;
    const onScreen = [...document.images].filter((img) => {
      const r = img.getBoundingClientRect();
      return (
        r.width &&
        r.bottom > 0 &&
        r.top < innerHeight &&
        r.right > 0 &&
        r.left < innerWidth
      );
    });
    const loaded = (img) =>
      img.complete
        ? img.decode().catch(() => {})
        : new Promise((done) =>
            img.addEventListener("load", done, { once: true }),
          );
    await Promise.race([
      Promise.all(onScreen.map(loaded)),
      new Promise((done) => setTimeout(done, 8000)),
    ]);
  });
  await frame.waitForTimeout(300);
}

// One set of flows serves both outputs: stills act instantly, animations glide a drawn cursor and pause.
function actor(page, animate) {
  let at = { x: 640, y: 400 };
  const pause = (ms) => (animate ? page.waitForTimeout(ms) : Promise.resolve());
  const cursor = (x, y, ms) =>
    page.evaluate(([x, y, ms]) => window.__cursor(x, y, ms), [x, y, ms]);
  async function glide(to) {
    if (animate) {
      const ms = Math.round(
        Math.min(900, 350 + Math.hypot(to.x - at.x, to.y - at.y) * 0.6),
      );
      await cursor(to.x, to.y, ms);
      await page.waitForTimeout(ms);
    }
    await page.mouse.move(to.x, to.y);
    at = to;
  }
  return {
    pause,
    say: (text) =>
      animate && page.evaluate((text) => window.__caption(text), text),
    async click(locator, after = 700, options = {}) {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      await glide({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
      if (animate) await page.evaluate(() => window.__press());
      await locator.click(options);
      await pause(after);
    },
    // Native select popups are not painted into screenshots, so point at the control and set it directly.
    async choose(select, option, after = 700) {
      await select.scrollIntoViewIfNeeded();
      const box = await select.boundingBox();
      await glide({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
      if (animate) await page.evaluate(() => window.__press());
      await select.selectOption(option);
      await pause(after);
    },
    async drag(from, to, steps = 24) {
      await glide(from);
      await page.mouse.down();
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = from.x + (to.x - from.x) * t;
        const y = from.y + (to.y - from.y) * t;
        await page.mouse.move(x, y);
        if (animate) {
          await cursor(x, y, 0);
          await page.waitForTimeout(30);
        }
      }
      await page.mouse.up();
      at = to;
      await pause(700);
    },
    async type(text, after = 700) {
      await page.keyboard.type(text, { delay: animate ? 90 : 0 });
      await pause(after);
    },
    async press(key, after = 700) {
      await page.keyboard.press(key);
      await pause(after);
    },
  };
}

async function newPage(
  browser,
  { size = DESKTOP, theme = "dark", layout },
  extraHeight = 0,
) {
  const [width, height, scale = 1] = size;
  const mobile = width < 700;
  const context = await browser.newContext({
    viewport: { width, height: height + extraHeight },
    deviceScaleFactor: scale,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: theme,
    locale: "en-US",
  });
  const value = JSON.stringify({ theme, ...(layout && { layout }) });
  await context.addInitScript(seed, { key: "frameleaf:prototype:v1", value });
  return context.newPage();
}

async function capture(browser, base, still) {
  const page = await newPage(browser, still);
  await page.goto(new URL(still.path || "/", base).href);
  await settle(page);
  await still.run?.(actor(page, false), page);
  await settle(page);
  const file = path.join(referencesDir, `${still.name}.jpg`);
  await page.screenshot({ path: file, type: "jpeg", quality: 85 });
  await page.context().close();
  console.log(`still      ${path.relative(process.cwd(), file)}`);
}

const font = (weight) =>
  readFileSync(
    path.join(
      root,
      `node_modules/@fontsource/inter/files/inter-latin-${weight}-normal.woff2`,
    ),
  ).toString("base64");
const CAPTION = 64;
const stage = (src) => `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: Inter; font-weight: 500; src: url(data:font/woff2;base64,${font(500)}) format("woff2"); }
html, body { margin: 0; height: 100%; overflow: hidden; background: #101416; }
iframe { display: block; width: 100%; height: calc(100% - ${CAPTION}px); border: 0; }
footer { box-sizing: border-box; height: ${CAPTION}px; display: flex; align-items: center; gap: 16px; padding: 0 24px;
  border-top: 1px solid #303940; background: #171d21; font: 500 18px Inter, sans-serif; color: #e5e7eb; }
#caption { flex: 1; transition: opacity 0.25s; }
#caption.out { opacity: 0; }
small { font-size: 13px; color: #a1adb8; }
#cursor { position: fixed; left: -5px; top: -3px; pointer-events: none; transform: translate(640px, 400px); }
#cursor svg { display: block; filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.6)); }
#ring { position: absolute; left: -9px; top: -11px; width: 24px; height: 24px; border: 2px solid #22c55e; border-radius: 50%; opacity: 0; }
#cursor.press #ring { animation: ring 0.45s ease-out; }
@keyframes ring { from { transform: scale(0.3); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }
</style>
<iframe name="app" src="${src}"></iframe>
<footer><span id="caption"></span><small>Frameleaf design template · sample data</small></footer>
<div id="cursor"><svg width="22" height="26" viewBox="0 0 22 26"><path d="M5 3v17l4.3-4.1 3.1 6.8 2.8-1.2-3-6.7h6z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg><span id="ring"></span></div>
<script>
  const cursor = document.getElementById("cursor"), caption = document.getElementById("caption");
  window.__cursor = (x, y, ms) => {
    cursor.style.transition = ms ? "transform " + ms + "ms cubic-bezier(0.45, 0, 0.25, 1)" : "none";
    cursor.style.transform = "translate(" + x + "px, " + y + "px)";
  };
  window.__press = () => { cursor.classList.remove("press"); void cursor.offsetWidth; cursor.classList.add("press"); };
  window.__caption = (text) => {
    caption.classList.add("out");
    setTimeout(() => { caption.textContent = text; caption.classList.remove("out"); }, 250);
  };
</script>`;

async function record(browser, base, animation, work) {
  const page = await newPage(browser, { size: [1280, 800] }, CAPTION);
  const stageUrl = new URL("/__capture-stage", base).href;
  await page.route(stageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: stage(animation.path || "/"),
    }),
  );
  await page.goto(stageUrl);
  const app = page.frame({ name: "app" });
  await settle(app);

  const frames = [];
  const dir = mkdtempSync(path.join(work, `${animation.name}-`));
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const file = path.join(
      dir,
      `${String(frames.length).padStart(5, "0")}.jpg`,
    );
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, time: metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92 });
  await animation.steps(actor(page, true), app);
  await page.waitForTimeout(400);
  await cdp.send("Page.stopScreencast");
  await page.context().close();

  // Screencast frames arrive only on repaint, so each frame lasts until the next one.
  const hold = 1.5;
  const list = frames
    .map(
      (frame, i) =>
        `file '${frame.file}'\nduration ${((frames[i + 1]?.time ?? frame.time + hold) - frame.time).toFixed(4)}`,
    )
    .concat(`file '${frames.at(-1).file}'`)
    .join("\n");
  const listFile = path.join(dir, "frames.txt");
  writeFileSync(listFile, list);
  const input = [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
  ];
  const mp4 = path.join(animationsDir, `${animation.name}.mp4`);
  execFileSync("ffmpeg", [
    ...input,
    "-vf",
    "fps=30,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "22",
    "-movflags",
    "+faststart",
    mp4,
  ]);
  const gifFrames = path.join(dir, "gif");
  mkdirSync(gifFrames);
  execFileSync("ffmpeg", [
    ...input,
    "-vf",
    "fps=15,scale=960:-2:flags=lanczos",
    path.join(gifFrames, "%05d.png"),
  ]);
  const pngs = readdirSync(gifFrames)
    .sort()
    .map((file) => path.join(gifFrames, file));
  const gif = path.join(animationsDir, `${animation.name}.gif`);
  execFileSync("gifski", [
    "--quiet",
    "--fps",
    "15",
    "--quality",
    "70",
    "-o",
    gif,
    ...pngs,
  ]);
  console.log(
    `animation  ${path.relative(process.cwd(), mp4)}, ${path.basename(gif)}`,
  );
}

const wanted = process.argv.slice(2);
const known = ["stills", "animations", ...stills, ...animations].map(
  (item) => item.name ?? item,
);
const unknown = wanted.filter((name) => !known.includes(name));
if (unknown.length)
  throw new Error(`Unknown capture ${unknown}. Choose from: ${known}`);
const pick = (items, group) =>
  items.filter(
    (item) =>
      !wanted.length || wanted.includes(group) || wanted.includes(item.name),
  );
const server = await createServer({
  root,
  logLevel: "error",
  server: { port: 4190 },
});
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const work = mkdtempSync(path.join(tmpdir(), "frameleaf-capture-"));
try {
  for (const still of pick(stills, "stills"))
    await capture(browser, base, still);
  const recordings = pick(animations, "animations");
  if (recordings.length) mkdirSync(animationsDir, { recursive: true });
  for (const animation of recordings)
    await record(browser, base, animation, work);
} finally {
  await browser.close();
  await server.close();
  rmSync(work, { recursive: true, force: true });
}
