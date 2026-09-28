import React from "react";
import { Icon } from "./Icon";
import {
  detectedWorker,
  jobDestinations,
  localCapability,
  localGbNeeded,
  mlWorkloads,
  routeSummary,
  routingModes,
  setWorkloadRoute,
  workloadRoute,
} from "./frameleaf-cloud-data.mjs";
import { LADDER_WORKLOADS } from "./gpu-model-catalog.mjs";
import { ModelSlider, resolveModelChoice } from "./ModelSlider";
import "./frameleaf-cloud.css";

// Where each kind of ML work may run: this server, Frameleaf Cloud, or both.
// "Both" means each job offers both destinations; a job is never moved between
// them on its own, and every cloud job shows its cost before it starts.

/** Save the default model for one kind of work (the slider's position). */
export function setDefaultModel(state, workload, modelId) {
  return {
    ...state,
    processing: {
      ...state.processing,
      defaultModels: { ...(state.processing.defaultModels ?? {}), [workload]: modelId },
    },
  };
}

/** The model slider for one kind of work, bound to its saved default. */
export function DefaultModelSlider({ state, run, workload, label }) {
  const resolved = resolveModelChoice(state, workload, state.processing.defaultModels?.[workload]);
  return (
    <>
      <ModelSlider
        state={state}
        workload={workload}
        label={label}
        value={resolved?.item.id}
        onChange={(id, entry) =>
          run(
            (current) => setDefaultModel(current, workload, id),
            `${entry.item.name} is now the default${entry.runsOn === "cloud" ? "; each job still shows its cost first" : ""}.`,
          )
        }
      />
      {resolved?.fallback && (
        <p className="fc-routing-summary is-warning">
          Your saved model no longer fits this hardware or route, so {resolved.item.name} is used.
        </p>
      )}
    </>
  );
}

export function WorkloadRoutingTable({ state, run, onNavigate, showModels = true }) {
  const linked = state.link.status === "linked";
  const cloudOn = linked && state.processing.enabled;
  const worker = detectedWorker(state);
  const setRoute = (id, mode, name) =>
    run(
      (current) => setWorkloadRoute(current, id, mode),
      `${name}: ${routingModes.find((item) => item.id === mode).short.toLowerCase()}.`,
    );
  return (
    <section className="fc-card fc-routing" aria-labelledby="fc-routing-title">
      <div className="fc-card-title">
        <span className="fc-card-icon">
          <Icon name="mdiSourceBranch" />
        </span>
        <div>
          <h2 id="fc-routing-title">Where each job runs</h2>
          <p>
            Choose this server, Frameleaf Cloud, or both for every kind of work
            that uses the ML service. With both, each job lets you pick, and a
            job never moves to the cloud on its own.
          </p>
        </div>
      </div>
      <p className="fc-note">
        <Icon name="mdiExpansionCard" /> AI features on this server use:{" "}
        {worker.memoryGb ? `${worker.gpu} · ${worker.memoryGb} GB GPU memory` : "the processor (no usable graphics card)"}
        {onNavigate && (
          <>
            {" · "}
            <button className="fc-link" onClick={() => onNavigate("processing", "hardware")}>
              Hardware & GPU
            </button>
          </>
        )}
      </p>
      {!cloudOn && (
        <p className="fc-muted">
          {linked ? "Turn on Frameleaf Cloud above" : "Link this server to Frameleaf"} to
          choose Frameleaf Cloud or both.{" "}
          {onNavigate && !linked && (
            <button className="fc-link" onClick={() => onNavigate("cloud", "cloud-account")}>
              Link this server
            </button>
          )}
        </p>
      )}
      <ul className="fc-routing-list">
        {mlWorkloads.map((workload) => {
          const route = workloadRoute(state, workload.id);
          const local = localCapability(workload.id, worker);
          const summary = workload.cloud
            ? routeSummary(state, workload.id, worker)
            : { tone: "muted", text: workload.why };
          return (
            <li key={workload.id}>
              <div className="fc-routing-name">
                <strong>{workload.name}</strong>
                <span className="fc-muted">{workload.use}</span>
                <span className={`fc-routing-local ${local.ok ? "is-ok" : "is-short"}`}>
                  <Icon name={local.ok ? "mdiCheckCircleOutline" : "mdiAlertOutline"} size={14} />{" "}
                  {local.ok ? "Runs on this server" : `Needs ${localGbNeeded(workload.id)} GB locally`}
                </span>
              </div>
              <div
                className="fc-segmented"
                role="radiogroup"
                aria-label={`Where ${workload.name.toLowerCase()} runs`}
              >
                {routingModes.map((mode) => {
                  const disabled =
                    mode.id !== "local" && (!workload.cloud || !cloudOn);
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      role="radio"
                      aria-checked={route === mode.id}
                      className={route === mode.id ? "is-on" : ""}
                      disabled={disabled}
                      title={disabled && !workload.cloud ? workload.why : undefined}
                      onClick={() => setRoute(workload.id, mode.id, workload.name)}
                    >
                      {mode.short}
                    </button>
                  );
                })}
              </div>
              <p className={`fc-routing-summary is-${summary.tone}`}>{summary.text}</p>
              {showModels && workload.cloud && LADDER_WORKLOADS.includes(workload.id) && (
                <div className="fc-routing-models">
                  <DefaultModelSlider
                    state={state}
                    run={run}
                    workload={workload.id}
                    label={`Model for ${workload.name.toLowerCase()}`}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Destination picker for one job. Unavailable destinations stay visible with
 * the reason, so a person with a small GPU sees why the cloud is offered.
 */
export function JobDestination({ state, workload, workers, value, onChange, onOpenSettings, legend = "Run on" }) {
  const options = jobDestinations(state, workload, workers);
  const none = options.every((item) => !item.available);
  return (
    <fieldset className="fc-choices fc-job-destination">
      <legend>{legend}</legend>
      {options.map((option) => (
        <label
          key={option.id}
          className={`${value === option.id ? "is-selected" : ""} ${option.available ? "" : "is-disabled"}`}
        >
          <input
            type="radio"
            name={`fc-destination-${workload}`}
            checked={value === option.id}
            disabled={!option.available}
            onChange={() => onChange(option.id)}
          />
          <strong>
            <Icon name={option.id === "cloud" ? "mdiCloudOutline" : "mdiServerOutline"} size={14} />{" "}
            {option.name}
          </strong>
          <span>{option.reason}</span>
        </label>
      ))}
      {(none || onOpenSettings) && (
        <p className="fc-muted">
          {none && "Nothing can run this job yet. "}
          {onOpenSettings && (
            <button type="button" className="fc-link" onClick={() => onOpenSettings("cloud-processing")}>
              Change where this work runs
            </button>
          )}
        </p>
      )}
    </fieldset>
  );
}
