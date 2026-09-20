import React, { useState } from "react";
import { Button, Dialog } from "./App";
import { Icon } from "./Icon";
import {
  configuredWorkers,
  updateWorkerUrls,
  workerRequestPreview,
} from "./worker-settings.mjs";
import "./worker-manager.css";

export function WorkerManager({
  values,
  onSettingChange,
  onNavigate = () => {},
}) {
  const urls = configuredWorkers(values);
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [report, setReport] = useState(null);
  const enabled = values.advancedMlEnabled !== false;
  function open(next) {
    setError("");
    setForm(next);
  }
  function change(next) {
    try {
      const updated = updateWorkerUrls(values, next);
      if (onSettingChange("advancedMlUrls", updated) === false)
        throw new Error(
          "The endpoint change could not be added to your draft.",
        );
      setForm(null);
      setError("");
      setNotice("Endpoint list updated in your draft. Review changes to save.");
    } catch (error) {
      setError(error.message);
    }
  }
  function preview(url, kind) {
    try {
      setReport(workerRequestPreview(url, kind));
      setError("");
    } catch (error) {
      setError(error.message);
    }
  }
  return (
    <div className="worker-manager">
      <div className="worker-heading">
        <div>
          <h2>Machine-learning endpoints</h2>
          <p>
            Local machines, home servers, and remote workers use the same
            endpoint list.
          </p>
        </div>
        <Button
          icon="mdiPlus"
          disabled={!enabled}
          onClick={() => open({ kind: "add", url: "" })}
        >
          Add endpoint
        </Button>
      </div>
      {!enabled && (
        <p className="cc-callout">
          Machine learning is disabled. Enable it in the ML connection settings
          before changing endpoints.
        </p>
      )}
      <p className="cc-subtle">
        A configured address does not prove model support or GPU availability.
        Video restoration chooses a compatible local endpoint when available;
        moving a job to the cloud requires an explicit choice.
      </p>
      {error && !form && (
        <p role="alert" className="worker-error">
          {error}
        </p>
      )}
      <p role="status" className="worker-notice">
        {notice}
      </p>
      <div className="worker-list">
        {urls.map((url, index) => (
          <article key={`${index}:${url}`}>
            <div className="worker-endpoint">
              <Icon name="mdiServerOutline" size={22} />
              <div>
                <h3>ML endpoint {index + 1}</h3>
                <code>{url}</code>
              </div>
              <span>Not checked</span>
            </div>
            <dl>
              <div>
                <dt>Type</dt>
                <dd>ML inference</dd>
              </div>
              <div>
                <dt>Capabilities</dt>
                <dd>Not reported</dd>
              </div>
              <div>
                <dt>GPU memory</dt>
                <dd>Unknown</dd>
              </div>
              <div>
                <dt>Credentials</dt>
                <dd>No credentials in the URL</dd>
              </div>
            </dl>
            <div className="worker-actions">
              <Button
                disabled={!enabled}
                onClick={() => open({ kind: "edit", original: url, url })}
              >
                Edit endpoint
              </Button>
              <Button onClick={() => preview(url, "ml")}>
                Preview capability check
              </Button>
              <Button
                disabled={!enabled || index === 0}
                aria-label={`Move ML endpoint ${index + 1} earlier`}
                onClick={() =>
                  change({ kind: "move", original: url, direction: -1 })
                }
              >
                Move earlier
              </Button>
              <Button
                disabled={!enabled || index === urls.length - 1}
                aria-label={`Move ML endpoint ${index + 1} later`}
                onClick={() =>
                  change({ kind: "move", original: url, direction: 1 })
                }
              >
                Move later
              </Button>
              <Button
                disabled={!enabled || urls.length <= 1}
                onClick={() => open({ kind: "remove", original: url, url })}
              >
                Remove
              </Button>
            </div>
          </article>
        ))}
      </div>
      {!urls.length && (
        <p role="alert">
          Add at least one endpoint to configure machine learning.
        </p>
      )}
      <section className="worker-video">
        <h2>Persistent video worker</h2>
        <p>
          Long-running video restoration uses a separately managed destination
          with its own credentials and runtime limit.
        </p>
        <dl>
          <div>
            <dt>Name</dt>
            <dd>{values.advancedVideoProfileName || "Not configured"}</dd>
          </div>
          <div>
            <dt>Endpoint</dt>
            <dd>
              <code>{values.advancedVideoProfileUrl || "Not configured"}</code>
            </dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>Persistent video</dd>
          </div>
          <div>
            <dt>Credential status</dt>
            <dd>Managed in the video workload profile</dd>
          </div>
        </dl>
        <div className="worker-actions">
          <Button
            onClick={() => onNavigate("processing", "advanced-video-profile")}
          >
            Open video workload profile
          </Button>
          <Button
            disabled={!values.advancedVideoProfileUrl}
            onClick={() =>
              preview(values.advancedVideoProfileUrl, "persistent-video")
            }
          >
            Preview capability check
          </Button>
          <Button
            onClick={() => onNavigate("processing", "advanced-runpod-ordinary")}
          >
            Manage library analysis workers
          </Button>
        </div>
      </section>
      {form && (
        <Dialog
          title={
            form.kind === "remove"
              ? "Remove ML endpoint"
              : form.kind === "edit"
                ? "Edit ML endpoint"
                : "Add ML endpoint"
          }
          close={() => {
            setForm(null);
            setError("");
          }}
          actions={
            <>
              <Button
                onClick={() => {
                  setForm(null);
                  setError("");
                }}
              >
                Cancel
              </Button>
              <Button primary onClick={() => change(form)}>
                {form.kind === "remove"
                  ? "Remove from draft"
                  : "Apply to draft"}
              </Button>
            </>
          }
        >
          {form.kind === "remove" ? (
            <>
              <p>Remove this endpoint from new machine-learning requests?</p>
              <code>{form.url}</code>
              <p>
                Existing video jobs retain their selected destination. Removing
                an address does not stop or delete a remote worker.
              </p>
            </>
          ) : (
            <>
              <label className="worker-form-label">
                Endpoint URL
                <input
                  autoFocus
                  type="url"
                  value={form.url}
                  maxLength={2048}
                  placeholder="http://machine-learning:3003"
                  onChange={(event) =>
                    setForm({ ...form, url: event.target.value })
                  }
                />
              </label>
              <p className="cc-subtle">
                Use the worker base URL. Credentials, query parameters and
                fragments are excluded. Persistent video destinations are
                configured in their separate profile.
              </p>
            </>
          )}
          {error && (
            <p role="alert" className="worker-error">
              {error}
            </p>
          )}
        </Dialog>
      )}
      {report && (
        <Dialog
          title="Capability check preview"
          close={() => setReport(null)}
          actions={<Button onClick={() => setReport(null)}>Done</Button>}
        >
          <p>{report.result}</p>
          <dl>
            <div>
              <dt>Destination</dt>
              <dd>
                <code>{report.endpoint}</code>
              </dd>
            </div>
            <div>
              <dt>Workload type</dt>
              <dd>
                {report.kind === "ml" ? "ML inference" : "Persistent video"}
              </dd>
            </div>
            <div>
              <dt>Network activity</dt>
              <dd>None</dd>
            </div>
          </dl>
          <p>
            Model support, available GPU memory and endpoint health must be read
            from the worker before it can be qualified for a job.
          </p>
        </Dialog>
      )}
    </div>
  );
}
