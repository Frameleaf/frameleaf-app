import React, { useId } from "react";
import { Icon } from "./Icon";
import { detectedWorker, hardwareBenchmark, workerGpu, workloadRoute } from "./frameleaf-cloud-data.mjs";
import { BANDS, ladderStates, resolvePosition } from "./gpu-model-catalog.mjs";
import "./gpu-models.css";

// Model slider: every model for one kind of work, ordered light → heavy and
// banded by where it runs with the detected hardware — white = processor,
// green = your GPU, blue = Frameleaf Cloud only. Each stop has an icon and a
// text label, so colour is never the only signal. Built on native radio
// buttons, so arrow keys move between the stops that can be chosen.

/** Options for the catalogue: the GPU a worker offers this work, the route and benchmark. */
export function sliderContext(state, workload, { worker, route } = {}) {
  const chosen = worker ?? detectedWorker(state);
  return {
    gpu: workerGpu(chosen, workload),
    cpuProfile: chosen?.cpuProfile ?? "cpu8",
    route: route ?? workloadRoute(state, workload),
    // Benchmarks measure this server, not other workers.
    benchmark: !worker || worker.id === "local" ? hardwareBenchmark(state) : null,
  };
}

/** The model a slider shows for a saved choice (falls back when it no longer fits). */
export function resolveModelChoice(state, workload, savedId, options = {}) {
  return resolvePosition(workload, savedId, sliderContext(state, workload, options));
}

export function ModelSlider({
  state,
  workload,
  value,
  onChange,
  worker,
  route,
  label = "Model",
  hideLegend = false,
  localDisabledReason = "",
  gpuLabel,
}) {
  const id = useId();
  const context = sliderContext(state, workload, { worker, route });
  const stops = ladderStates(workload, context).map((entry) =>
    localDisabledReason && entry.runsOn === "local" && !entry.disabled
      ? { ...entry, disabled: true, reason: localDisabledReason }
      : entry,
  );
  const selected = stops.find((entry) => entry.item.id === value) ?? null;
  const reasons = [...new Set(stops.filter((entry) => entry.disabled).map((entry) => entry.reason))];
  const gpu = context.gpu;
  const bandsPresent = new Set(stops.map((entry) => entry.band));
  return (
    <fieldset className="ms" data-workload={workload}>
      <legend className="ms-legend">{label}</legend>
      <div className="ms-track" style={{ "--ms-count": stops.length }}>
        {stops.map((entry) => {
          const band = BANDS[entry.band];
          const checked = entry.item.id === value;
          return (
            <label
              key={entry.item.id}
              className={`ms-stop is-${entry.band}${checked ? " is-selected" : ""}${entry.disabled ? " is-disabled" : ""}`}
              title={entry.disabled ? entry.reason : `${entry.item.name} · ${entry.label}`}
            >
              <input
                type="radio"
                className="sr-only"
                name={`${id}-model`}
                value={entry.item.id}
                checked={checked}
                disabled={entry.disabled}
                aria-describedby={entry.disabled ? `${id}-reasons` : undefined}
                onChange={() => onChange?.(entry.item.id, entry)}
              />
              <span className="ms-band" aria-hidden="true" />
              <span className="ms-knob" aria-hidden="true" />
              <span className="ms-stop-name" aria-hidden="true">
                <Icon name={band.icon} size={14} />
                <span>{entry.item.short}</span>
              </span>
              <span className="sr-only">
                {entry.item.name}: {entry.label}
                {entry.disabled ? `. Unavailable: ${entry.reason}` : ""}
              </span>
            </label>
          );
        })}
      </div>
      <div className="ms-scale" aria-hidden="true">
        <span>Lighter</span>
        <span>Heavier</span>
      </div>
      {selected ? (
        <p className={`ms-readout is-${selected.band}`} aria-live="polite">
          <Icon name={BANDS[selected.band].icon} size={16} />
          <span>
            <strong>{selected.item.name}</strong> · {selected.label}
            <small>
              {selected.item.note}
              {selected.detail ? ` ${selected.detail}` : ""}
              {selected.licenceNote ? ` Licence: ${selected.licenceNote}` : ""}
            </small>
          </span>
        </p>
      ) : (
        <p className="ms-readout is-none" role="status">
          <Icon name="mdiCancel" size={16} />
          <span>Nothing can run this work with the current settings.</span>
        </p>
      )}
      {!hideLegend && (
        <ul className="ms-key" aria-label="What the colours mean">
          {bandsPresent.has("cpu") && (
            <li className="is-cpu">
              <Icon name={BANDS.cpu.icon} size={14} /> White · processor, no GPU
            </li>
          )}
          {bandsPresent.has("gpu") && (
            <li className="is-gpu">
              <Icon name={BANDS.gpu.icon} size={14} /> Green · {gpuLabel ?? (gpu ? `your GPU (${gpu.name}, ${gpu.vramGb} GB)` : "your GPU")}
            </li>
          )}
          {bandsPresent.has("cloud") && (
            <li className="is-cloud">
              <Icon name={BANDS.cloud.icon} size={14} /> Blue · Frameleaf Cloud only, cost shown first
            </li>
          )}
        </ul>
      )}
      {reasons.length > 0 && (
        <ul className="ms-reasons" id={`${id}-reasons`}>
          {reasons.map((reason) => (
            <li key={reason}>
              <Icon name="mdiInformationOutline" size={14} /> {reason}
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
