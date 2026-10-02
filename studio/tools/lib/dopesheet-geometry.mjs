/**
 * Read-only Dopesheet marker geometry shared by the native keyframe hit fixtures (FL-100).
 * Nothing here clicks, forces a position or overrides a hit test.
 */
import assert from "node:assert/strict";

export async function geometry(page, selector) {
  return page.evaluate((selector) => {
    const button = document.querySelector(selector);
    if (!button) throw Error(`Missing native marker ${selector}`);
    const surface = button.closest("[data-motion-viewport-surface]");
    if (!surface) throw Error("Missing actual Dopesheet viewport surface");
    const clip = surface.parentElement;
    const rect = (node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const b = rect(button),
      center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const hit = document.elementFromPoint(center.x, center.y);
    const describe = (node) =>
      node && {
        tag: node.tagName,
        testId: node.getAttribute("data-testid"),
        className: node.getAttribute("class"),
      };
    // What a pointer finds along the marker's middle row: one pixel inside each end of its box
    // (the whole marker is reachable), and two pixels beyond each end (it covers nothing more).
    const probe = (x) => {
      const found = document.elementFromPoint(x, center.y);
      return {
        x,
        hit: describe(found),
        label: found?.getAttribute("aria-label") ?? null,
        hitRect: found && rect(found),
        hitsButton: found === button || button.contains(found),
        region:
          found?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
        inSurface: !!found && surface.contains(found),
      };
    };
    const reach = {
      insideLeft: probe(b.x + 1),
      insideRight: probe(b.x + b.width - 1),
      outsideLeft: probe(b.x - 2),
      outsideRight: probe(b.x + b.width + 2),
    };
    const css = getComputedStyle(button);
    const clippedAncestors = [];
    for (let node = button.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        [style.overflowX, style.overflowY].some((v) =>
          ["hidden", "clip", "auto", "scroll"].includes(v),
        )
      ) {
        clippedAncestors.push({
          node: describe(node),
          rect: rect(node),
          overflowX: style.overflowX,
          overflowY: style.overflowY,
        });
      }
    }
    const clipStyle = getComputedStyle(clip);
    return {
      selector,
      button: b,
      diamond: rect(button.querySelector("span")),
      clip: rect(clip),
      clipMetrics: {
        clientLeft: clip.clientLeft,
        clientTop: clip.clientTop,
        clientWidth: clip.clientWidth,
        clientHeight: clip.clientHeight,
        scrollLeft: clip.scrollLeft,
        scrollTop: clip.scrollTop,
        borderLeftWidth: clipStyle.borderLeftWidth,
        borderRightWidth: clipStyle.borderRightWidth,
        borderTopWidth: clipStyle.borderTopWidth,
        borderBottomWidth: clipStyle.borderBottomWidth,
        paddingLeft: clipStyle.paddingLeft,
        paddingRight: clipStyle.paddingRight,
        paddingTop: clipStyle.paddingTop,
        paddingBottom: clipStyle.paddingBottom,
      },
      surface: rect(surface),
      // Horizontal part of the button inside the clip's content box: what a pointer can reach.
      visibleInClip: (() => {
        const c = clip.getBoundingClientRect();
        const left = Math.max(b.x, c.x + clip.clientLeft);
        const right = Math.min(
          b.x + b.width,
          c.x + clip.clientLeft + clip.clientWidth,
        );
        return { left, right, width: Math.max(0, right - left) };
      })(),
      defaultCenter: center,
      centerHit: describe(hit),
      centerHitsButton: hit === button || button.contains(hit),
      reach,
      clippedAncestors,
      frame: Number(button.dataset.dopesheetFrame),
      logicalAxis: {
        width: surface.dataset.motionViewportAxisWidth,
        edgeInset: surface.dataset.motionViewportEdgeInset,
        left: css.left,
        marginLeft: css.marginLeft,
        gridFrames: surface.querySelector("[data-motion-grid-frames]")?.dataset
          .motionGridFrames,
      },
    };
  }, selector);
}

// Layout readiness only: every #editor box is unchanged across consecutive frames. Says nothing
// about what the marker center hits, so an obstruction still fails the hit assertion.
export async function layoutSettled(page) {
  const settled = await page.evaluate(async () => {
    const boxes = () =>
      JSON.stringify(
        [...document.querySelectorAll("#editor, #editor *")].map((n) => {
          const r = n.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        }),
      );
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    let previous = boxes(),
      stable = 0;
    for (let i = 0; i < 300 && stable < 3; i++) {
      await frame();
      const current = boxes();
      stable = current === previous ? stable + 1 : 0;
      previous = current;
    }
    return stable >= 3;
  });
  assert.ok(settled, "editor layout settles within 300 frames");
}
