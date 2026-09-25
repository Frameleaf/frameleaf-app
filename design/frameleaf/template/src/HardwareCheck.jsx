import React, { useEffect, useRef, useState } from "react";
import { Button } from "./Controls";
import { Icon } from "./Icon";
import { copyText } from "./QrCode";
import { useCloudState } from "./FrameleafCloud";
import {
  detectedWorker,
  hardwareBenchmark,
  localCapability,
  setHardwareSample,
  workerGpu,
  workloadById,
} from "./frameleaf-cloud-data.mjs";
import {
  BANDS,
  LADDER_WORKLOADS,
  composeFixes,
  gpuProblems,
  hardwareSampleById,
  hardwareSamples,
  ladderStates,
  problemById,
  runBenchmark,
} from "./gpu-model-catalog.mjs";
import "./frameleaf-cloud.css";
import "./gpu-models.css";

// Settings → Compute & jobs → Hardware & GPU. Checks the GPU each container can
// use — the server container (video transcoding) and the ML container (photo
// and video analysis) — and explains common set-up problems with a copy-ready
// docker compose fix. Simulated: results come from sample hardware states.

const when = (value) =>
  value ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";

/** First sentence as a heading, the rest as the explanation. */
const splitFirst = (text) => {
  const index = text.indexOf(". ");
  return index < 0 ? [text.replace(/\.$/, ""), ""] : [text.slice(0, index), text.slice(index + 2)];
};

const BACKEND_LABEL = {
  CUDA: "CUDA",
  ROCm: "ROCm",
  OpenVINO: "OpenVINO",
  NVENC: "NVENC (NVIDIA video engine)",
  "VA-API": "VA-API",
  QSV: "Quick Sync",
  CPU: "Processor (no GPU)",
};

function ContainerCard({ title, purpose, result }) {
  const gpu = result.backend !== "CPU" && result.vramGb > 0;
  return (
    <section className="hw-container" aria-label={title}>
      <header>
        <div>
          <h3>{title}</h3>
          <p>{purpose}</p>
        </div>
        <span className={`fc-status is-${result.test.ok ? (gpu ? "ok" : "muted") : "warning"}`}>
          {gpu ? "GPU in use" : result.test.ok ? "Processor" : "GPU not reached"}
        </span>
      </header>
      <dl className="fc-facts">
        <dt>Vendor</dt>
        <dd>{result.vendor ?? "None found"}</dd>
        <dt>Model</dt>
        <dd>{result.model ?? "—"}</dd>
        <dt>GPU memory</dt>
        <dd>{result.vramGb ? `${result.vramGb} GB` : "—"}</dd>
        <dt>Driver / runtime</dt>
        <dd>{result.driver}</dd>
        <dt>Backend</dt>
        <dd>{BACKEND_LABEL[result.backend] ?? result.backend}</dd>
      </dl>
      <p className={`hw-test ${result.test.ok ? "is-ok" : "is-bad"}`}>
        <Icon name={result.test.ok ? "mdiCheckCircleOutline" : "mdiAlertOutline"} size={16} />
        <span>{result.test.text}</span>
      </p>
    </section>
  );
}

function CodeBlock({ code, label }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="hw-code">
      <pre aria-label={label}>
        <code>{code}</code>
      </pre>
      <Button
        icon={copied ? "mdiCheck" : "mdiContentCopy"}
        aria-label={`Copy ${label}`}
        onClick={async () => {
          setCopied(await copyText(code));
          setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function Fix({ fixId }) {
  const fix = composeFixes[fixId];
  if (!fix) return null;
  return (
    <div className="hw-fix">
      <strong>Fix for {fix.title}</strong>
      <ol>
        {fix.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {fix.yaml && <CodeBlock code={fix.yaml} label={`docker compose fix for ${fix.title}`} />}
    </div>
  );
}

/** One line per kind of work: what runs here and what would go to the cloud. */
function Consequences({ state, onNavigate }) {
  const worker = detectedWorker(state);
  return (
    <section className="fc-card" aria-labelledby="hw-effect-title">
      <div className="fc-card-title">
        <span className="fc-card-icon">
          <Icon name="mdiSourceBranch" />
        </span>
        <div>
          <h2 id="hw-effect-title">What this hardware can run</h2>
          <p>The model sliders in Where each job runs follow this result.</p>
        </div>
      </div>
      <dl className="fc-facts">
        {LADDER_WORKLOADS.map((workload) => {
          const states = ladderStates(workload, {
            gpu: workerGpu(worker, workload),
            cpuProfile: worker.cpuProfile,
            route: "both",
          });
          const local = states.filter((entry) => entry.runsOn === "local");
          const cloud = states.filter((entry) => entry.runsOn === "cloud");
          const heaviest = local[local.length - 1];
          return (
            <React.Fragment key={workload}>
              <dt>{workloadById(workload)?.name ?? workload}</dt>
              <dd>
                {heaviest
                  ? `Up to ${heaviest.item.name} here, on ${heaviest.band === "gpu" ? "your GPU" : "the processor"}${
                      /slow/.test(heaviest.label) ? " (slowly)" : ""
                    }.`
                  : localCapability(workload, worker).reason}{" "}
                {cloud.length > 0 && `${cloud.length} heavier ${cloud.length === 1 ? "model is" : "models are"} Frameleaf Cloud only.`}
              </dd>
            </React.Fragment>
          );
        })}
      </dl>
      {onNavigate && (
        <div className="fc-actions">
          <Button icon="mdiTuneVariant" onClick={() => onNavigate("processing", "routing")}>
            Choose models and where they run
          </Button>
        </div>
      )}
    </section>
  );
}

function Benchmark({ state }) {
  const benchmark = hardwareBenchmark(state);
  if (!benchmark) return null;
  const worker = detectedWorker(state);
  const rows = LADDER_WORKLOADS.flatMap((workload) =>
    ladderStates(workload, {
      gpu: workerGpu(worker, workload),
      cpuProfile: worker.cpuProfile,
      route: "both",
      benchmark,
    })
      .filter((entry) => entry.runsOn === "local")
      .map((entry) => ({ workload, entry })),
  );
  return (
    <div className="fc-table-wrap">
      <table className="hw-bench">
        <caption className="sr-only">Benchmark results</caption>
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col">Runs on</th>
            <th scope="col">Measured</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ workload, entry }) => (
            <tr key={entry.item.id}>
              <th scope="row">
                {entry.item.name}
                <small className="fc-muted"> · {workloadById(workload)?.name}</small>
              </th>
              <td>
                <Icon name={BANDS[entry.band].icon} size={14} /> {entry.band === "gpu" ? "Your GPU" : "Processor"}
              </td>
              <td>{entry.label.replace(/^(Your GPU|CPU) · (slow · )?/, "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HardwareCheck({ onNavigate }) {
  const [state, commit] = useCloudState();
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState("");
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const sample = hardwareSampleById(state.hardware?.sample);
  const issues = (sample.issues ?? []).map(problemById).filter(Boolean);
  const gpuUsed = Boolean(workerGpu(detectedWorker(state), "descriptions"));
  const status = issues.length
    ? ["Needs attention", "warning"]
    : gpuUsed
      ? ["GPU ready", "ok"]
      : ["Processor only", "muted"];

  const recheck = () => {
    setBusy("check");
    setNotice("");
    timer.current = setTimeout(() => {
      commit((current) => setHardwareSample(current, sample.id));
      setBusy(null);
      setNotice(issues.length ? "Check finished. The same problem is still there." : "Check finished. Nothing changed.");
    }, 1200);
  };
  const benchmark = () => {
    setBusy("benchmark");
    setNotice("");
    timer.current = setTimeout(() => {
      commit((current) => ({
        ...current,
        hardware: { ...current.hardware, benchmark: runBenchmark(sample.id) },
      }));
      setBusy(null);
      setNotice("Benchmark finished. Time estimates on the model sliders now use your measured speed.");
    }, 2200);
  };
  const preview = (id) => {
    commit((current) => setHardwareSample(current, id));
    setNotice(`Showing sample results for ${hardwareSampleById(id).label}.`);
  };

  return (
    <div className="hw frameleaf-cloud">
      {notice && (
        <div className="cc-notice" role="status">
          <span>{notice}</span>
          <button aria-label="Dismiss notice" onClick={() => setNotice("")}>
            <Icon name="mdiClose" />
          </button>
        </div>
      )}
      <section className="fc-card" aria-labelledby="hw-title">
        <div className="fc-card-title">
          <span className="fc-card-icon">
            <Icon name="mdiExpansionCard" />
          </span>
          <div>
            <h2 id="hw-title">GPU check</h2>
            <p>
              Whether your graphics card speeds up video and AI features. Each part of Frameleaf needs its own access, so both are checked.
              {" "}{sample.host} · last checked {when(state.hardware?.checkedAt)}.
            </p>
          </div>
          <span className={`fc-status is-${status[1]}`}>{status[0]}</span>
        </div>
        <div className="hw-containers">
          <ContainerCard title="Video playback and export" purpose="Server container · converts videos and exports Studio projects" result={sample.server} />
          <ContainerCard title="AI features" purpose="ML container · search, faces, captions and restoration" result={sample.ml} />
        </div>
        {(sample.notes ?? []).map((note) => (
          <p key={note} className="fc-muted">
            {note}
          </p>
        ))}
        {busy ? (
          <p className="hw-running fc-waiting" role="status">
            <Icon name="mdiProgressClock" />
            {busy === "check" ? "Checking both containers…" : "Running a short benchmark on each model that fits…"}
          </p>
        ) : null}
        <div className="fc-actions">
          <Button icon="mdiRefresh" disabled={Boolean(busy)} onClick={recheck}>
            Run check again
          </Button>
          <Button icon="mdiSpeedometer" disabled={Boolean(busy)} onClick={benchmark}>
            Run a short benchmark
          </Button>
        </div>
        <Benchmark state={state} />
      </section>

      {issues.length > 0 && (
        <section className="fc-card" aria-labelledby="hw-issues-title">
          <div className="fc-card-title">
            <span className="fc-card-icon">
              <Icon name="mdiWrenchOutline" />
            </span>
            <div>
              <h2 id="hw-issues-title">What needs fixing</h2>
              <p>
                {sample.onHost?.vramGb
                  ? `The host has ${sample.onHost.model} (${sample.onHost.vramGb} GB), but the containers cannot use it yet. Until then, work runs on the processor.`
                  : "Until this is resolved, work runs on the processor."}
              </p>
            </div>
          </div>
          {issues.map((issue) => (
            <div key={issue.id} className="hw-issue">
              <h3>
                <Icon name="mdiAlertOutline" size={16} /> {splitFirst(issue.explain)[0]}.
              </h3>
              {splitFirst(issue.explain)[1] && <p>{splitFirst(issue.explain)[1]}</p>}
              <p>
                Shown in the logs as <code>{issue.symptom}</code>
              </p>
            </div>
          ))}
          {(sample.fixes ?? []).map((fixId) => (
            <Fix key={fixId} fixId={fixId} />
          ))}
          <p className="fc-muted">After changing docker compose, recreate the containers with docker compose up -d, then run the check again.</p>
        </section>
      )}

      <Consequences state={state} onNavigate={onNavigate} />

      <details className="fc-disclosure">
        <summary>
          <Icon name="mdiEyeOutline" size={16} /> Preview other hardware
        </summary>
        <fieldset className="hw-samples fc-choices">
          <legend className="sr-only">Sample hardware</legend>
          {hardwareSamples.map((item) => (
            <label key={item.id}>
              <input
                type="radio"
                name="hw-sample"
                checked={item.id === sample.id}
                onChange={() => preview(item.id)}
              />
              <span>
                {item.label}
                <small>
                  {item.issues.length
                    ? `${item.issues.length === 1 ? "One problem" : `${item.issues.length} problems`} to fix`
                    : workerGpu(detectedWorkerFor(item.id), "descriptions")
                      ? "Works as expected"
                      : "Runs on the processor"}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="fc-muted">Sample results for this prototype. The choice is saved, and routing and the model sliders follow it.</p>
      </details>

      <details className="fc-disclosure">
        <summary>
          <Icon name="mdiLifebuoy" size={16} /> Common GPU set-up problems
        </summary>
        <ul className="hw-problems">
          {gpuProblems.map((problem) => (
            <li key={problem.id}>
              <strong>
                {problem.vendor} · {splitFirst(problem.explain)[0]}.
              </strong>
              <code>{problem.symptom}</code>
              {splitFirst(problem.explain)[1] && <span>{splitFirst(problem.explain)[1]}</span>}
            </li>
          ))}
        </ul>
        <div className="hw-fix">
          {Object.keys(composeFixes).map((fixId) => (
            <Fix key={fixId} fixId={fixId} />
          ))}
        </div>
      </details>
    </div>
  );
}

const detectedWorkerFor = (sampleId) => detectedWorker({ hardware: { sample: sampleId } });
