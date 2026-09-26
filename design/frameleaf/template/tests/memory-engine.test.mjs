import assert from "node:assert/strict";
import test from "node:test";
import { kenBurnsMove } from "../src/media-viewer.mjs";
import {
  MEMORY_PHOTO_MS,
  MEMORY_PREVIEW_MS,
  memoryCountLabel,
  memoryLowerThird,
  memoryMotion,
  memoryOverline,
  memoryPreviewMotion,
  memorySlideClass,
  memoryTitleCard,
  memoryTransition,
} from "../src/memory-engine.mjs";

test("memory transition follows the viewer's Reduce Motion rule", () => {
  assert.equal(memoryTransition(false), "memories");
  assert.equal(memoryTransition(true), "fade");
});

test("memory motion uses the viewer's Ken Burns move for the same asset", () => {
  const motion = memoryMotion("asset-7");
  const move = kenBurnsMove("asset-7");
  assert.deepEqual(motion, {
    "--kb-from": move.from,
    "--kb-to": move.to,
    "--kb-duration": `${(MEMORY_PHOTO_MS + 1000) / 1000}s`,
  });
  assert.deepEqual(memoryMotion("asset-7"), motion, "deterministic per asset");
  assert.equal(
    memoryMotion("asset-7", { durationMs: 2500 })["--kb-duration"],
    "2.5s",
  );
});

test("memory motion is dropped under Reduce Motion or without an asset", () => {
  assert.equal(memoryMotion("asset-7", { reducedMotion: true }), undefined);
  assert.equal(memoryMotion(null), undefined);
  assert.equal(memoryPreviewMotion("cover", true), undefined);
});

test("card previews drift slower than playback", () => {
  const preview = memoryPreviewMotion("cover-1");
  assert.equal(preview["--kb-duration"], `${MEMORY_PREVIEW_MS / 1000}s`);
  assert.equal(preview["--kb-from"], kenBurnsMove("cover-1").from);
  assert.ok(MEMORY_PREVIEW_MS > MEMORY_PHOTO_MS);
});

test("slide classes move photos, crossfade videos and reduced motion, and pause", () => {
  assert.equal(memorySlideClass(), "memories");
  assert.equal(memorySlideClass({ reducedMotion: true }), "fade");
  assert.equal(memorySlideClass({ video: true }), "fade");
  assert.equal(memorySlideClass({ paused: true }), "memories paused");
});

test("title card and overline copy", () => {
  assert.equal(memoryOverline({ kind: "event" }), "Trip");
  assert.equal(memoryOverline({ kind: "best-of" }), "Highlights");
  assert.equal(memoryOverline({ kind: "on-this-day" }), "Memory");
  assert.deepEqual(
    memoryTitleCard(
      { kind: "event", title: "Lisbon", subtitle: "May 2024", count: 9 },
      1,
    ),
    {
      overline: "Trip",
      title: "Lisbon",
      subtitle: "May 2024",
      count: "1 item",
    },
  );
  assert.equal(memoryTitleCard(null).title, "Memories");
  assert.equal(memoryCountLabel(3), "3 items");
  assert.equal(memoryCountLabel(1, "memory"), "1 memory");
});

test("lower third shows the place, or the memory title, over the date", () => {
  assert.deepEqual(
    memoryLowerThird(
      { city: "Porto" },
      { fallbackTitle: "Trip", day: "Monday, 3 June 2024" },
    ),
    {
      place: "Porto",
      detail: "Monday, 3 June 2024",
    },
  );
  assert.deepEqual(
    memoryLowerThird({}, { fallbackTitle: "Summer", day: "", video: true }),
    {
      place: "Summer",
      detail: "Video, muted",
    },
  );
  assert.equal(memoryLowerThird(null), null);
});
