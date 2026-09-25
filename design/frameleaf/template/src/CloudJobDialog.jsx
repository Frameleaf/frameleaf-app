import React, { useEffect, useRef, useState } from "react";
import { Button, Dialog } from "./Controls";
import { Icon } from "./Icon";
import {
  cloudAdmission,
  formatUsd,
  loadCloudState,
  saveCloudState,
  walletAvailable,
} from "./frameleaf-cloud-data.mjs";
import {
  DISCLOSURE_TEXT,
  billingFormula,
  cloudJobMeta,
  estimateJob,
  estimateRange,
  findModel,
  perUnitText,
  placeHold,
  settlementBreakdown,
  spentSoFar,
} from "./cloud-jobs.mjs";
import { cloudStartNote, jobStatusLine, stageOf } from "./activity-feed.mjs";
import { findLiveJob, subscribeJobs } from "./live-jobs.mjs";
import { ModelSlider, sliderContext } from "./ModelSlider";
import { ladderStates } from "./gpu-model-catalog.mjs";
import "./cloud-job.css";

/** Live Frameleaf Cloud state: follows saves from any screen or tab. */
export function useCloudState() {
  const [state, setState] = useState(() => loadCloudState());
  useEffect(() => {
    const refresh = () => setState(loadCloudState());
    window.addEventListener("frameleaf-cloud-change", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("frameleaf-cloud-change", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return state;
}

const WORKLOAD_LABEL = {
  restoration: "Video restoration",
  upscale: "Upscale",
  descriptions: "Descriptions",
  render: "Studio render",
  studio: "Captions",
  interpolation: "Smooth motion",
};
const RUN_HEAD = {
  queued: "Queued for Frameleaf Cloud",
  starting: "Starting a Frameleaf Cloud worker",
  running: "Running on Frameleaf Cloud",
  paused: "Paused",
  done: "Finished",
  failed: "Stopped",
  cancelled: "Cancelled",
};

/** The submitted job as it is in app state now, so the dialog mirrors Activity. */
function useLiveJob(id) {
  const [job, setJob] = useState(() => findLiveJob(id));
  useEffect(() => {
    setJob(findLiveJob(id));
    return subscribeJobs(() => setJob(findLiveJob(id)));
  }, [id]);
  return job;
}

/**
 * Confirmation for one Frameleaf Cloud job: model, estimate with its range,
 * the amount held from AI credit and a per-job disclosure. A refusal replaces
 * the submit button; nothing falls back to another worker.
 */
export function CloudJobDialog({
  title,
  workload,
  quantity,
  quantityLabel,
  summary,
  preview = false,
  onSubmit,
  onFinish,
  onOpenSettings,
  onAddCredit,
  modelId: requestedModel,
  onRunLocal,
  worker,
  close,
}) {
  const cloud = useCloudState();
  const [modelId, setModelId] = useState(() => {
    // Start on the requested or saved model when it runs on the cloud here,
    // otherwise on the lightest model Frameleaf Cloud can run.
    const stops = ladderStates(workload, sliderContext(cloud, workload, { worker }));
    const usable = (id) => stops.find((entry) => entry.item.id === id && !entry.disabled && entry.runsOn === "cloud");
    return (
      usable(requestedModel)?.item.id ??
      usable(cloud.processing.defaultModels?.[workload])?.item.id ??
      stops.find((entry) => !entry.disabled && entry.runsOn === "cloud")?.item.id ??
      null
    );
  });
  const [runsLocal, setRunsLocal] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [phase, setPhase] = useState("confirm");
  const [job, setJob] = useState(null);
  const live = useLiveJob(job?.id);
  // Until app state has the job, show it as just queued.
  const current = live || (job ? { ...job, status: "queued", progress: 0 } : null);
  const stage = current ? stageOf(current.status) : "queued";
  const ended = ["done", "failed", "cancelled"].includes(stage);
  const progress = Math.round(current?.progress || 0);
  const finished = useRef(false);
  useEffect(() => {
    if (!job || !ended || finished.current) return;
    finished.current = true;
    onFinish?.(job.id);
  }, [ended, job]);

  const model = !runsLocal ? findModel(modelId) : null;
  const estimate = model ? estimateJob(model.id, quantity) : null;
  const refusal = runsLocal ? null : cloudAdmission(cloud, estimate);
  const available = walletAvailable(cloud.wallet);
  const creditShort = refusal?.startsWith("Add AI credit");

  const submit = () => {
    if (!model || !estimate || refusal || !agreed) return;
    const meta = cloudJobMeta({ model, estimate, quantity, label: quantityLabel });
    saveCloudState(placeHold(loadCloudState(), estimate.hold));
    const id = onSubmit?.(meta) || `local-${Date.now()}`;
    setJob({ id, kind: WORKLOAD_LABEL[workload], destination: "cloud", cloud: meta });
    setPhase("running");
  };

  const settledCloud = current?.cloud?.settled ? current.cloud : null;
  const settled = settledCloud ? settledCloud.chargedUsd ?? 0 : null;

  const actions =
    phase === "confirm" ? (
      <>
        <Button onClick={close}>Cancel</Button>
        {runsLocal ? (
          <Button
            primary
            icon="mdiServerOutline"
            data-initial-focus
            disabled={!onRunLocal}
            onClick={() => {
              onRunLocal?.(modelId);
              close();
            }}
          >
            Run on this server instead
          </Button>
        ) : refusal ? (
          <>
            {creditShort && onAddCredit && (
              <Button icon="mdiPlusCircleOutline" onClick={onAddCredit}>
                Add credit
              </Button>
            )}
            {onOpenSettings && (
              <Button
                primary
                icon="mdiCogOutline"
                onClick={() =>
                  onOpenSettings(
                    cloud.link.status !== "linked" ? "cloud-account" : "cloud-processing",
                  )
                }
              >
                Open Frameleaf Cloud settings
              </Button>
            )}
          </>
        ) : (
          <Button
            primary
            icon="mdiCloudUploadOutline"
            data-initial-focus
            disabled={!agreed || !estimate}
            onClick={submit}
          >
            Run on Frameleaf Cloud · hold {formatUsd(estimate?.hold ?? 0)}
          </Button>
        )}
      </>
    ) : !ended ? (
      <Button onClick={close}>Continue in Activity</Button>
    ) : (
      <Button primary data-initial-focus onClick={close}>
        Done
      </Button>
    );

  return (
    <Dialog title={title} close={close} actions={actions}>
      <div className="fcj">
        <p className="fcj-summary">
          <Icon name="mdiCloudOutline" size={16} />
          <span>
            {WORKLOAD_LABEL[workload] ?? "Cloud job"} · {quantityLabel}
            {preview ? " · preview" : ""}
            {summary ? ` · ${summary}` : ""}
          </span>
        </p>

        {phase === "confirm" && (
          <>
            <ModelSlider
              state={cloud}
              workload={workload}
              worker={worker}
              value={modelId}
              label="Model · lighter to heavier"
              localDisabledReason={onRunLocal ? "" : "This job is being sent to Frameleaf Cloud. To run it here, close this and choose a model on your GPU."}
              onChange={(id, entry) => {
                setModelId(id);
                setRunsLocal(entry.runsOn === "local");
                setAgreed(false);
              }}
            />
            {runsLocal && (
              <p className="fcj-note" role="status">
                <Icon name="mdiServerOutline" size={14} /> This model runs on this server, so nothing is sent and
                there is no cloud cost.
              </p>
            )}

            {!runsLocal && (
              <dl className="fcj-facts">
                <dt>Estimate</dt>
                <dd>
                  <strong>{estimateRange(estimate)}</strong>
                  <small>Typical to high end, start fees included</small>
                </dd>
                <dt>Billed as</dt>
                <dd>
                  {estimate ? billingFormula(estimate) : "—"}
                  <small>
                    {estimate?.gpuClass.label}
                    {estimate?.workers > 1
                      ? ` · video runs as ${estimate.chunkSeconds} s chunks on ${estimate.workers} workers, each with its own start fee`
                      : ""}
                  </small>
                </dd>
                <dt>Per {model?.unit ?? "item"}</dt>
                <dd>
                  {estimate ? perUnitText(estimate) : "—"}
                  <small>An estimate from measured speed; you pay for the GPU time used</small>
                </dd>
                <dt>Held from AI credit</dt>
                <dd>
                  {formatUsd(estimate?.hold ?? 0)}
                  <small>The high-end estimate, released when the job settles</small>
                </dd>
                <dt>AI credit available</dt>
                <dd className={creditShort ? "fcj-short" : ""}>{formatUsd(available)}</dd>
              </dl>
            )}

            {runsLocal ? null : refusal ? (
              <p className="fcj-refusal" role="alert">
                <Icon name="mdiAlertCircleOutline" size={16} />
                <span>
                  {refusal} Nothing is sent, and the job does not move to another worker.
                </span>
              </p>
            ) : (
              <label className="fcj-consent">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(event) => setAgreed(event.target.checked)}
                />
                <span>
                  <strong>Send this job to Frameleaf Cloud</strong>
                  <small>{DISCLOSURE_TEXT}</small>
                </span>
              </label>
            )}
            <p className="fcj-note">
              If Frameleaf Cloud can't finish, the job stops and shows why. It never switches to
              another worker without asking.
            </p>
          </>
        )}

        {phase !== "confirm" && current && (
          <div className="fcj-run" aria-live="polite">
            <div className="fcj-run-head">
              <strong>{RUN_HEAD[stage]}</strong>
              <span>{current.cloud.modelName}</span>
            </div>
            {stage === "starting" ? (
              <div className="fcj-progress is-indeterminate" role="progressbar" aria-label="Cloud job: starting">
                <span />
              </div>
            ) : (
              <div
                className="fcj-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
                aria-label="Cloud job progress"
              >
                <span style={{ width: `${progress}%` }} />
              </div>
            )}
            <p className="fcj-note">{jobStatusLine(current)}</p>
            {stage === "starting" && <p className="fcj-note">{cloudStartNote(current)}</p>}
            <dl className="fcj-facts">
              <dt>Estimate</dt>
              <dd>{estimateRange(current.cloud)}</dd>
              {!ended ? (
                <>
                  <dt>So far</dt>
                  <dd>{stage === "queued" ? "Nothing yet · billing starts when a worker starts" : formatUsd(spentSoFar(current))}</dd>
                </>
              ) : (
                <>
                  <dt>Settled</dt>
                  <dd>
                    {settled === null ? (
                      "Settling…"
                    ) : stage === "failed" ? (
                      <strong>No charge</strong>
                    ) : (
                      <>
                        <strong>{formatUsd(settled)}</strong>
                        <small>
                          {settled <= current.cloud.p90
                            ? "Within the estimate"
                            : "Above the estimate, below the amount held"}
                          {" · "}
                          {formatUsd(current.cloud.hold - settled)} returned to AI credit
                        </small>
                        <small>
                          {settlementBreakdown(current, stage === "cancelled" ? current.progress : 100)}
                        </small>
                      </>
                    )}
                  </dd>
                </>
              )}
            </dl>
            <p className="fcj-note">
              {!ended
                ? "You can close this; the job keeps going in Activity."
                : stage === "done"
                  ? "Previews and results are deleted from Frameleaf Cloud now that the job is done."
                  : "Nothing moved to another worker. Retry it from Activity."}
            </p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
