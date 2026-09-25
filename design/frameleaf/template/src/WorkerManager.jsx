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
          "This change couldn't be added. Try again.",
        );
      setForm(null);
      setError("");
      setNotice("Updated. Review changes to save.");
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
          <h2>Computers for AI features</h2>
          <p>
            This server and other computers at home that run search, faces and
            captions. The first one that answers is used.
          </p>
        </div>
        <Button
          icon="mdiPlus"
          disabled={!enabled}
          onClick={() => open({ kind: "add", url: "" })}
        >
          Add a computer
        </Button>
      </div>
      {!enabled && (
        <p className="cc-callout">
          AI features are turned off. Turn them on in AI helper computers
          before changing this list.
        </p>
      )}
      <p className="cc-subtle">
        An address that answers may still lack the models or GPU memory a job
        needs. Work never moves to the cloud unless you choose it.
        {onNavigate && (
          <>
            {" "}
            <button type="button" className="fc-link" onClick={() => onNavigate("processing", "hardware")}>
              Check this server's GPU
            </button>
          </>
        )}
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
                <h3>Computer {index + 1}</h3>
                <code>{url}</code>
              </div>
              <span>Not checked</span>
            </div>
            <dl>
              <div>
                <dt>Type</dt>
                <dd>AI features</dd>
              </div>
              <div>
                <dt>Can run</dt>
                <dd>Not reported</dd>
              </div>
              <div>
                <dt>GPU memory</dt>
                <dd>Unknown</dd>
              </div>
              <div>
                <dt>Credentials</dt>
                <dd>None in the address</dd>
              </div>
            </dl>
            <div className="worker-actions">
              <Button
                disabled={!enabled}
                onClick={() => open({ kind: "edit", original: url, url })}
              >
                Edit address
              </Button>
              <Button onClick={() => preview(url, "ml")}>
                Check what it can run
              </Button>
              <Button
                disabled={!enabled || index === 0}
                aria-label={`Move computer ${index + 1} earlier`}
                onClick={() =>
                  change({ kind: "move", original: url, direction: -1 })
                }
              >
                Move earlier
              </Button>
              <Button
                disabled={!enabled || index === urls.length - 1}
                aria-label={`Move computer ${index + 1} later`}
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
          Add at least one computer to use AI features.
        </p>
      )}
      <section className="worker-video">
        <h2>Computer for long videos</h2>
        <p>
          Long video jobs can go to a computer at home that stays on and
          resumes them if interrupted.
        </p>
        <dl>
          <div>
            <dt>Name</dt>
            <dd>{values.advancedVideoProfileName || "Not configured"}</dd>
          </div>
          <div>
            <dt>Address</dt>
            <dd>
              <code>{values.advancedVideoProfileUrl || "Not configured"}</code>
            </dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>Long videos</dd>
          </div>
          <div>
            <dt>Password</dt>
            <dd>Set in Computer for long videos</dd>
          </div>
        </dl>
        <div className="worker-actions">
          <Button
            onClick={() => onNavigate("processing", "advanced-video-profile")}
          >
            Set up the long-video computer
          </Button>
          <Button
            disabled={!values.advancedVideoProfileUrl}
            onClick={() =>
              preview(values.advancedVideoProfileUrl, "persistent-video")
            }
          >
            Check what it can run
          </Button>
          <Button
            icon="mdiCloudOutline"
            onClick={() => onNavigate("cloud", "cloud-processing")}
          >
            Frameleaf Cloud processing
          </Button>
        </div>
      </section>
      {form && (
        <Dialog
          title={
            form.kind === "remove"
              ? "Remove computer"
              : form.kind === "edit"
                ? "Edit computer"
                : "Add a computer"
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
                  ? "Remove"
                  : "Add to changes"}
              </Button>
            </>
          }
        >
          {form.kind === "remove" ? (
            <>
              <p>Stop sending new AI work to this computer?</p>
              <code>{form.url}</code>
              <p>
                Jobs already sent there stay there. This doesn't turn the
                computer off.
              </p>
            </>
          ) : (
            <>
              <label className="worker-form-label">
                Address
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
                The computer's address, such as http://machine-learning:3003.
                Leave out passwords; the long-video computer is set up
                separately.
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
          title="What this computer can run"
          close={() => setReport(null)}
          actions={<Button onClick={() => setReport(null)}>Done</Button>}
        >
          <p>{report.result}</p>
          <dl>
            <div>
              <dt>Address</dt>
              <dd>
                <code>{report.endpoint}</code>
              </dd>
            </div>
            <div>
              <dt>Used for</dt>
              <dd>
                {report.kind === "ml" ? "AI features" : "Long videos"}
              </dd>
            </div>
            <div>
              <dt>Network activity</dt>
              <dd>None</dd>
            </div>
          </dl>
          <p>
            Frameleaf still needs to ask the computer which models and how much
            GPU memory it has before sending it work.
          </p>
        </Dialog>
      )}
    </div>
  );
}
