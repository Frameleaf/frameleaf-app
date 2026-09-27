import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "./Controls";
import { Icon } from "./Icon";
import { prefersReducedMotion } from "./interactions";
import { clampTourStep, cloudTourStatus, cloudTourSteps } from "./cloud-tour.mjs";
import "./cloud-tour.css";

// The linked-server tour (proposed, pending owner approval). A sheet over
// Settings → Frameleaf Cloud that an administrator lands on after linking this
// server outside first-run setup. Arrow keys and swipes move between steps, Escape
// skips, and every step opens its real settings page.

// Web Animations need a literal easing, so read the shared spring token.
const spring = (node) =>
  (node && getComputedStyle(node).getPropertyValue("--fl-spring").trim()) ||
  "cubic-bezier(0.2, 0.8, 0.2, 1)";

/**
 * state: the Frameleaf Cloud state. onClose(how) ends the tour ("finished" | "skipped" |
 * "opened-settings"). onOpen(area, section) opens a settings page.
 */
export function CloudTour({ state, initialStep = 0, onClose, onOpen }) {
  const dialog = useRef(null);
  const body = useRef(null);
  const heading = useRef(null);
  const swipe = useRef(null);
  const direction = useRef(1);
  const shown = useRef(null);
  const titleId = useId();
  const summaryId = useId();
  const [index, setIndex] = useState(() => clampTourStep(initialStep));
  const step = cloudTourSteps[index];
  const last = index === cloudTourSteps.length - 1;
  const status = cloudTourStatus(step.id, state);
  const account = state.link.account?.email;

  const go = (next) => {
    const target = clampTourStep(next);
    if (target === index) return;
    direction.current = target > index ? 1 : -1;
    setIndex(target);
  };
  const close = (how) => onClose?.(how);

  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement;
    if (node && !node.open) node.showModal?.();
    node?.querySelector("[data-initial-focus]")?.focus();
    return () => {
      if (node?.open) node.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // Slide in from the direction of travel; a plain crossfade under Reduce Motion.
  useLayoutEffect(() => {
    const previous = shown.current;
    shown.current = index;
    if (previous === null || previous === index) return undefined;
    heading.current?.focus({ preventScroll: true });
    const reduced = prefersReducedMotion();
    const frames = reduced
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { opacity: 0, transform: `translateX(${direction.current * 28}px)` },
          { opacity: 1, transform: "none" },
        ];
    const run = body.current?.animate?.(frames, {
      duration: reduced ? 200 : 460,
      easing: reduced ? "ease" : spring(body.current),
      fill: "both",
    });
    const tile = reduced
      ? null
      : body.current
          ?.querySelector(".ct-tile")
          ?.animate?.([{ transform: "scale(0.82)" }, { transform: "none" }], {
            duration: 520,
            easing: spring(body.current),
          });
    return () => {
      run?.cancel();
      tile?.cancel();
    };
  }, [index]);

  function keydown(event) {
    if (event.target.closest?.("input, select, textarea")) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      go(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(index - 1);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="dialog cloud-tour"
      aria-labelledby={titleId}
      aria-describedby={summaryId}
      data-step={step.id}
      onKeyDown={keydown}
      onCancel={(event) => {
        event.preventDefault();
        close("skipped");
      }}
    >
      <p className="ct-overline" aria-live="polite">
        <span>Frameleaf Cloud</span>
        <span aria-hidden="true">·</span>
        <span>
          {index + 1} of {cloudTourSteps.length}
        </span>
      </p>

      <div
        className="ct-body"
        ref={body}
        onPointerDown={(event) => {
          if (event.pointerType !== "mouse") swipe.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUp={(event) => {
          const start = swipe.current;
          swipe.current = null;
          if (!start) return;
          const dx = event.clientX - start.x;
          if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(event.clientY - start.y) * 1.5)
            go(index + (dx < 0 ? 1 : -1));
        }}
        onPointerCancel={() => {
          swipe.current = null;
        }}
      >
        {index === 0 && (
          <p className="ct-linked">
            <Icon name="mdiCheckCircle" size={16} />
            <span>
              This server is linked{account ? <> to <strong>{account}</strong></> : null}. Here is
              what that unlocks. Nothing is turned on until you choose.
            </span>
          </p>
        )}
        <div className="ct-head">
          <span className="ct-tile" style={{ "--tile": step.tile }} aria-hidden="true">
            <Icon name={step.icon} size={30} />
            {step.ai && (
              <span className="ct-ai">
                <Icon name="mdiShimmer" size={12} />
              </span>
            )}
          </span>
          <h2 id={titleId} ref={heading} tabIndex={-1}>
            {step.title}
          </h2>
          <p id={summaryId}>{step.summary}</p>
        </div>

        <ul className="ct-points">
          {step.points.map((point) => (
            <li key={point.title}>
              <Icon name={point.icon} size={20} />
              <span>
                <strong>{point.title}</strong>
                <small>{point.text}</small>
              </span>
            </li>
          ))}
        </ul>

        <div className="ct-where">
          {status && (
            <p className="ct-status">
              <span>On this server</span>
              <span className={`fc-status is-${status.tone}`}>{status.label}</span>
            </p>
          )}
          <div className="ct-links">
            {step.links.map((link) => (
              <button
                key={link.label}
                type="button"
                className="ct-link"
                onClick={() => {
                  close("opened-settings");
                  onOpen?.(link.area, link.section);
                }}
              >
                Open {link.label}
                <Icon name="mdiChevronRight" size={16} />
              </button>
            ))}
          </div>
        </div>
      </div>

      <footer className="ct-footer">
        <div className="ct-dots" role="group" aria-label="Tour steps">
          {cloudTourSteps.map((item, position) => (
            <button
              key={item.id}
              type="button"
              aria-label={`Step ${position + 1}: ${item.title}`}
              aria-current={position === index ? "step" : undefined}
              onClick={() => go(position)}
            />
          ))}
        </div>
        <div className="ct-actions">
          {!last && (
            <button type="button" className="ct-skip" onClick={() => close("skipped")}>
              Skip tour
            </button>
          )}
          <span className="ct-spacer" />
          {index > 0 && (
            <Button icon="mdiChevronLeft" aria-label="Back" className="ct-back" onClick={() => go(index - 1)} />
          )}
          <Button
            primary
            data-initial-focus
            onClick={() => (last ? close("finished") : go(index + 1))}
          >
            {last ? "Done" : "Next"}
          </Button>
        </div>
      </footer>
    </dialog>
  );
}
