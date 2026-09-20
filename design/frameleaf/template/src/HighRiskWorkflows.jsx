import React, { useEffect, useRef, useState } from "react";
import { Button, Dialog } from "./App";
import {
  workflowIds,
  workflowStates,
  getWorkflowActionOutcome,
  getWorkflowActionSurface,
  getWorkflowReview,
} from "./high-risk-workflows.mjs";
import "./high-risk-workflows.css";

const flowLabels = {
  album: "Album",
  people: "People",
  recovery: "Recovery",
  studio: "Studio",
  tablet: "Tablet",
};

const stateLabels = {
  normal: "Normal",
  empty: "Empty",
  forbidden: "Forbidden",
  stale: "Stale",
  retry: "Cancel / retry",
  keyboard: "Keyboard",
  narrow: "Narrow",
};

function Visual({ review }) {
  if (review.flowId === "people") {
    return (
      <div
        className="hr-media people-correction"
        aria-label="Face correction preview"
      >
        <img src="/media/portrait.png" alt="Emma standing outdoors" />
        {review.stateId !== "forbidden" && (
          <span className="hr-face-box" aria-hidden="true" />
        )}
        <div className="hr-overlay-card">
          <strong>
            {review.stateId === "empty"
              ? "No face selected"
              : "Suggested: Emma"}
          </strong>
          <span>
            {review.stateId === "keyboard"
              ? "Region x 42%, y 18%, width 24%, height 31%"
              : "Detected region · 92% confidence"}
          </span>
        </div>
      </div>
    );
  }
  if (review.flowId === "recovery") {
    const retry = review.stateId === "retry";
    return (
      <div className="hr-recovery" aria-label="Recovery candidates">
        {["Lake morning.mov", "Emma portrait.jpg", "Forest trail.mov"].map(
          (name, index) => (
            <div className="hr-file-row" key={name}>
              <span
                className={`hr-check ${index === 2 || (retry && index === 1) ? "uncertain" : ""}`}
                aria-hidden="true"
              >
                {index === 2 || (retry && index === 1) ? "!" : "✓"}
              </span>
              <span>
                <strong>{name}</strong>
                <small>
                  {index === 2
                    ? "Filename match only · blocked"
                    : retry && index === 1
                      ? "Access changed before publish · no replacement written"
                      : "SHA-256 exact · decode valid"}
                </small>
              </span>
              <span>
                {index === 2
                  ? "Needs review"
                  : retry && index === 1
                    ? "Retry after access review"
                    : retry
                      ? "Recovered"
                      : "Ready"}
              </span>
            </div>
          ),
        )}
      </div>
    );
  }
  if (review.flowId === "studio") {
    return (
      <div className="hr-compare" aria-label="Revision comparison">
        <section>
          <span>Your recoverable draft</span>
          <strong>Revision 18 + 6 local changes</strong>
          <small>Not eligible to overwrite</small>
        </section>
        <section className="latest">
          <span>Current project</span>
          <strong>Revision 19 by Jamie</strong>
          <small>Saved 2 minutes ago</small>
        </section>
      </div>
    );
  }
  if (review.flowId === "tablet") {
    return (
      <div
        className={`hr-tablet ${review.stateId === "narrow" ? "is-narrow" : ""}`}
        aria-label="Native tablet workspace adaptation"
      >
        <aside>
          <strong>Projects</strong>
          <span>Rockies film</span>
          <span>Family archive</span>
        </aside>
        <div className="hr-tablet-preview">
          <img src="/media/lake.png" alt="Lake project preview" />
          <span>00:08:14</span>
        </div>
        <aside>
          <strong>Inspector</strong>
          <span>Transform</span>
          <span>Color</span>
          <span>Audio</span>
        </aside>
        <footer>
          <span>V1</span>
          <span className="clip">Lake morning.mov</span>
          <span className="clip short">Title</span>
        </footer>
      </div>
    );
  }
  return (
    <div className="hr-album" aria-label="Album sharing review">
      <img src="/media/lake.png" alt="Lake album cover" />
      <div>
        <strong>Summer in the Rockies</strong>
        <span>19 items · activity on</span>
      </div>
      <div className="hr-members">
        {review.facts.map((fact) => (
          <span key={fact}>{fact}</span>
        ))}
      </div>
    </div>
  );
}

export function HighRiskWorkflows({ back }) {
  const params = new URL(location.href).searchParams;
  const [flowId, setFlowId] = useState(params.get("flow") || "album");
  const [stateId, setStateId] = useState(params.get("state") || "normal");
  const [narrowOpen, setNarrowOpen] = useState(stateId === "narrow");
  const [actionOutcome, setActionOutcome] = useState("");
  const [actionSurface, setActionSurface] = useState(null);
  const [resultsClosed, setResultsClosed] = useState(false);
  const primaryAction = useRef(null);
  const actionSurfaceHeading = useRef(null);
  const restorePrimaryFocus = useRef(false);
  const review = getWorkflowReview(flowId, stateId);
  const runAction = (kind) => {
    setActionOutcome(getWorkflowActionOutcome(flowId, stateId, kind));
    if (review.stateId === "forbidden" && kind === "primary") {
      back();
      return;
    }
    const nextSurface = getWorkflowActionSurface(flowId, stateId, kind);
    setActionSurface(nextSurface);
    if (kind === "primary") setResultsClosed(false);
    if (
      review.flowId === "recovery" &&
      review.stateId === "retry" &&
      kind === "secondary"
    ) {
      setResultsClosed(true);
    }
    if (!nextSurface) {
      restorePrimaryFocus.current = true;
    }
  };
  const closeActionSurface = () => {
    setActionSurface(null);
    setActionOutcome("Review closed. No production mutation ran.");
    restorePrimaryFocus.current = true;
  };
  useEffect(() => {
    setActionOutcome("");
    setActionSurface(null);
    setResultsClosed(false);
    setNarrowOpen(stateId === "narrow");
    if (stateId === "keyboard") primaryAction.current?.focus();
  }, [flowId, stateId]);
  useEffect(() => {
    if (actionSurface) {
      actionSurfaceHeading.current?.focus();
    } else if (restorePrimaryFocus.current) {
      restorePrimaryFocus.current = false;
      primaryAction.current?.focus();
    }
  }, [actionSurface]);
  return (
    <main
      className={`high-risk-review state-${review.stateId}`}
      data-flow={review.flowId}
      data-state={review.stateId}
      onKeyDown={(event) => {
        if (review.stateId === "keyboard" && event.key === "Escape") {
          event.preventDefault();
          runAction("secondary");
        }
      }}
    >
      <header className="hr-header">
        <div>
          <p className="eyebrow">Interaction decision review</p>
          <h1>High-risk workflows</h1>
          <p>
            Design evidence only. Production services, native controls,
            rendering, and authorization remain separately qualified.
          </p>
        </div>
        <Button onClick={back}>Return to library</Button>
      </header>
      <nav className="hr-tabs" aria-label="Workflow under review">
        {workflowIds.map((id) => (
          <button
            key={id}
            aria-current={review.flowId === id ? "page" : undefined}
            onClick={() => setFlowId(id)}
          >
            {flowLabels[id]}
          </button>
        ))}
      </nav>
      <div className="hr-state-picker" role="group" aria-label="Review state">
        {workflowStates.map((id) => (
          <button
            key={id}
            aria-pressed={review.stateId === id}
            onClick={() => setStateId(id)}
          >
            {stateLabels[id]}
          </button>
        ))}
      </div>
      <section className="hr-layout">
        <div className="hr-stage">
          <div
            className={`hr-state-banner tone-${review.state.tone}`}
            role={review.state.tone === "blocked" ? "alert" : "status"}
          >
            <strong>{review.state.label}</strong>
            <span>{review.state.summary}</span>
          </div>
          {resultsClosed ? (
            <div
              className="hr-closed-panel"
              role="status"
              data-results-closed="true"
            >
              <strong>Recovery results closed</strong>
              <span>
                Lake morning.mov remains recovered. Two findings remain
                unchanged.
              </span>
            </div>
          ) : review.stateId === "empty" ? (
            <div className="hr-empty-panel" role="status">
              <strong>No eligible items</strong>
              <span>
                Change the current source or return to the previous step.
              </span>
            </div>
          ) : review.stateId === "forbidden" ? (
            <div className="hr-unavailable" aria-hidden="true" />
          ) : (
            <Visual review={review} />
          )}
        </div>
        {review.stateId !== "narrow" && (
          <aside className="hr-decision">
            <p className="eyebrow">{review.eyebrow}</p>
            <h2>{review.title}</h2>
            <p>{review.description}</p>
            <div className="hr-scope">
              <strong>Current scope</strong>
              <span>{review.scope}</span>
            </div>
            <ol>
              {review.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <div className="hr-warning">
              <strong>Safety rule</strong>
              <span>{review.warning}</span>
            </div>
            {review.facts.length > 0 && (
              <ul>
                {review.facts.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
            )}
            <div className="hr-actions">
              <Button
                ref={primaryAction}
                primary
                onClick={() => runAction("primary")}
                onKeyDown={(event) => {
                  if (review.stateId === "keyboard" && event.key === "Enter") {
                    event.preventDefault();
                    runAction("primary");
                  }
                }}
              >
                {review.state.primary}
              </Button>
              <Button onClick={() => runAction("secondary")}>
                {review.state.secondary}
              </Button>
            </div>
            {review.stateId === "keyboard" && (
              <p className="hr-shortcuts">
                <kbd>Tab</kbd> moves · <kbd>Enter</kbd> applies · <kbd>Esc</kbd>{" "}
                cancels
              </p>
            )}
          </aside>
        )}
      </section>
      {actionOutcome && (
        <output className="hr-action-outcome" role="status" aria-live="polite">
          {actionOutcome}
        </output>
      )}
      {actionSurface && (
        <section
          className="hr-action-surface"
          data-action-surface={actionSurface.id}
          aria-labelledby="hr-action-surface-title"
        >
          <div>
            <p className="eyebrow">Bounded interaction state</p>
            <h2
              id="hr-action-surface-title"
              ref={actionSurfaceHeading}
              tabIndex={-1}
            >
              {actionSurface.title}
            </h2>
            <p>{actionSurface.summary}</p>
          </div>
          <ul>
            {actionSurface.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <Button onClick={closeActionSurface}>Close review</Button>
        </section>
      )}
      {review.stateId === "narrow" && !narrowOpen && (
        <Button
          className="hr-open-sheet"
          primary
          onClick={() => setNarrowOpen(true)}
        >
          Review details
        </Button>
      )}
      {review.stateId === "narrow" && narrowOpen && (
        <Dialog
          wide
          title={`${review.eyebrow} details`}
          close={() => setNarrowOpen(false)}
          actions={
            <>
              <Button
                onClick={() => {
                  setNarrowOpen(false);
                  runAction("secondary");
                }}
              >
                Not now
              </Button>
              <Button
                primary
                data-initial-focus
                onClick={() => {
                  setNarrowOpen(false);
                  runAction("primary");
                }}
              >
                Continue review
              </Button>
            </>
          }
        >
          <div className="hr-narrow-sheet">
            <p>{review.description}</p>
            <div className="hr-scope">
              <strong>Current scope</strong>
              <span>{review.scope}</span>
            </div>
            <ol>
              {review.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <div className="hr-warning">
              <strong>Safety rule</strong>
              <span>{review.warning}</span>
            </div>
            <p className="hr-shortcuts">
              <kbd>Tab</kbd> moves within this sheet · <kbd>Esc</kbd> closes and
              restores focus
            </p>
          </div>
        </Dialog>
      )}
    </main>
  );
}
