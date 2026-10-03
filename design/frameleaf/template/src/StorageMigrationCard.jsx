import React, { useEffect, useState } from "react";
import { Icon } from "./Icon";
import {
  advanceStorageMigrationDemo,
  createStorageMigrationDemo,
  storageMigrationView,
} from "./storage-migration-data.mjs";

/**
 * FL-326 (spec §5.1, §5.3): Library Care's storage migration status. Shown while
 * the migration runs in the background (after "Run in background instead"), with
 * the same stages as Getting Ready, and afterwards while files wait for review.
 */
export function StorageMigrationCard({ onReview, tick = 600 }) {
  const [status, setStatus] = useState(() => ({
    ...advanceStorageMigrationDemo(createStorageMigrationDemo(), 1000),
    background: true,
  }));
  const view = storageMigrationView(status);
  useEffect(() => {
    if (status.stage === "done") return undefined;
    const id = setInterval(
      () => setStatus((prev) => advanceStorageMigrationDemo(prev, 1000)),
      tick,
    );
    return () => clearInterval(id);
  }, [status.stage, tick]);
  const finished = status.stage === "done";
  if (finished && view.toReview === 0) return null;
  return (
    <section className="care-row storage-migration-card" aria-labelledby="storage-migration-title">
      <Icon name={finished ? "mdiShieldCheckOutline" : "mdiFileTree"} />
      <div className="grow">
        <strong id="storage-migration-title">
          {finished ? view.title : "Combining duplicate files"}
        </strong>
        {!finished && (
          <>
            <div
              className="fl-bar"
              role="progressbar"
              aria-label="Combining duplicate files"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={view.percent}
            >
              <span style={{ width: `${view.percent}%` }} />
            </div>
            <ul className="storage-migration-stages">
              {view.tasks.map((task) => (
                <li key={task.id} data-status={task.status}>
                  {task.title}
                  <span>
                    {task.status === "running"
                      ? task.progressLabel
                      : task.status === "done"
                        ? "Done"
                        : "Waiting"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="muted">
              {view.relinkLine} · {view.freedLabel} freed so far
              {view.timeLeftLabel ? ` · ${view.timeLeftLabel}` : ""}. Extra
              copies are not freed until it finishes.
            </p>
          </>
        )}
      </div>
      {view.toReview > 0 && (
        <button type="button" className="button" onClick={onReview}>
          Review {view.toReview}
        </button>
      )}
    </section>
  );
}
