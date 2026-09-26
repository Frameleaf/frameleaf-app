import React, { useState } from "react";
import { Button, Dialog } from "./App";
import { SearchableSelect } from "./SearchableSelect";
import { tags, media } from "./media";
import {
  workflowMethods,
  workflowTemplates,
  workflowTriggers,
  methodByKey,
  schemaDefaults,
  parseWorkflowDefinition,
  migrateLegacyWorkflow,
  workflowExecutionErrors,
  workflowPersistenceError,
  exportWorkflowDefinition,
  updateWorkflowParameter,
} from "./workflow-schema.mjs";
import { previewWorkflow } from "./utilities-data.mjs";
import "./workflow-designer.css";
const referenceOptions = {
  TagId: tags,
  AlbumId: [...new Set(media.flatMap((asset) => asset.albumIds ?? []))].map(
    (id) => ({
      id,
      label:
        { "summer-rockies": "Summer in the Rockies", family: "Family" }[id] ??
        id,
    }),
  ),
};

function Parameter({
  schema,
  value,
  onChange,
  label,
  required = false,
  disabled = false,
}) {
  const isArray = schema.array || schema.type === "array";
  if (schema.properties || schema.type === "object")
    return (
      <fieldset className="wd-object" disabled={disabled}>
        <legend>
          {label}
          {required ? " *" : ""}
        </legend>
        {schema.description && <p>{schema.description}</p>}
        {Object.entries(schema.properties ?? {})
          .sort(
            (a, b) => (a[1].uiHint?.order ?? 99) - (b[1].uiHint?.order ?? 99),
          )
          .map(([key, child]) => (
            <Parameter
              key={key}
              label={child.title ?? key}
              schema={child}
              required={schema.required?.includes(key)}
              value={value?.[key]}
              disabled={disabled}
              onChange={(next) =>
                onChange(updateWorkflowParameter(value ?? {}, [key], next))
              }
            />
          ))}
      </fieldset>
    );
  if (isArray) {
    const entries = Array.isArray(value) ? value : [];
    const references = referenceOptions[schema.uiHint?.type];
    if (references)
      return (
        <fieldset className="wd-object" disabled={disabled}>
          <legend>
            {label}
            {required ? " *" : ""}
          </legend>
          <div className="wd-reference-values">
            {entries.map((id, index) => (
              <span key={`${index}:${id}`}>
                {references.find((item) => item.id === id)?.label ??
                  `Unavailable selection: ${id}`}
                <Button
                  disabled={disabled}
                  aria-label={`Remove ${references.find((item) => item.id === id)?.label ?? id}`}
                  onClick={() =>
                    onChange(entries.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </Button>
              </span>
            ))}
          </div>
          <SearchableSelect
            disabled={disabled}
            label={
              schema.uiHint.type === "TagId" ? "Find a tag" : "Find an album"
            }
            value=""
            options={[
              { value: "", label: "Choose to add" },
              ...references
                .filter((item) => !entries.includes(item.id))
                .map((item) => ({ value: item.id, label: item.label })),
            ]}
            onChange={(id) => {
              if (id) onChange([...entries, id]);
            }}
          />
          <details>
            <summary>Advanced identifiers</summary>
            <textarea
              aria-label={`${label} identifiers`}
              disabled={disabled}
              value={entries.join("\n")}
              rows={3}
              onChange={(event) =>
                onChange(
                  event.target.value
                    .split("\n")
                    .map((item) => item.trim())
                    .filter(Boolean),
                )
              }
            />
            <small>
              Unresolved imported references remain selected until you remove or
              replace them.
            </small>
          </details>
        </fieldset>
      );
    return (
      <fieldset className="wd-object" disabled={disabled}>
        <legend>
          {label}
          {required ? " *" : ""}
        </legend>
        {schema.description && <p>{schema.description}</p>}
        {schema.enum ? (
          <div className="wd-enum-list">
            {[...new Set([...schema.enum, ...entries])].map((option) => (
              <label key={option}>
                <input
                  type="checkbox"
                  checked={entries.includes(option)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...entries, option]
                        : entries.filter((entry) => entry !== option),
                    )
                  }
                />
                {option}
                {!schema.enum.includes(option) ? " (unavailable)" : ""}
              </label>
            ))}
          </div>
        ) : (
          <label className="wd-field">
            {schema.uiHint?.type === "TagId"
              ? "Tag identifiers"
              : schema.uiHint?.type === "AlbumId"
                ? "Album identifiers"
                : "Values, one per line"}
            <textarea
              value={entries.join("\n")}
              rows={3}
              onChange={(event) =>
                onChange(
                  event.target.value
                    .split("\n")
                    .map((item) => item.trim())
                    .filter(Boolean),
                )
              }
            />
          </label>
        )}
        {schema.uiHint?.type && (
          <small>
            Use exact identifiers from accessible{" "}
            {schema.uiHint.type === "TagId" ? "tags" : "albums"}. Names do not
            replace identifiers.
          </small>
        )}
      </fieldset>
    );
  }
  if (schema.type === "boolean")
    return (
      <label className="wd-check">
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          {label}
          <small>{schema.description}</small>
        </span>
      </label>
    );
  if (schema.enum)
    return (
      <label className="wd-field">
        {label}
        {required ? " *" : ""}
        <select
          disabled={disabled}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
        >
          {!required && <option value="">Not set</option>}
          {value !== undefined && !schema.enum.includes(value) && (
            <option value={value}>Current: {String(value)}</option>
          )}
          {schema.enum.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <small>{schema.description}</small>
      </label>
    );
  return (
    <label className="wd-field">
      {label}
      {required ? " *" : ""}
      <input
        disabled={disabled}
        type={
          ["number", "integer"].includes(schema.type)
            ? "number"
            : label.toLowerCase().includes("header value")
              ? "password"
              : "text"
        }
        value={value ?? ""}
        min={schema.minimum}
        max={schema.maximum}
        step={schema.precision ?? (schema.type === "integer" ? 1 : "any")}
        autoComplete="off"
        onChange={(event) =>
          onChange(
            event.target.value === ""
              ? undefined
              : ["number", "integer"].includes(schema.type)
                ? Number(event.target.value)
                : event.target.value,
          )
        }
      />
      <small>{schema.description}</small>
    </label>
  );
}

export function WorkflowDesigner({ value, close, onSave, onRemove }) {
  const [draft, setDraft] = useState(() => migrateLegacyWorkflow(value));
  const [tab, setTab] = useState("Steps");
  const [active, setActive] = useState(0);
  const [method, setMethod] = useState(workflowMethods[0].key);
  const [template, setTemplate] = useState("");
  const [error, setError] = useState("");
  const [raw, setRaw] = useState(() =>
    JSON.stringify(migrateLegacyWorkflow(value), null, 2),
  );
  const [parameterJson, setParameterJson] = useState(null);
  const [validation, setValidation] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const readOnly = value.ownerId !== "taylor";
  const selected = draft.steps[active];
  const definition = selected && methodByKey(selected.method);
  const problems = workflowExecutionErrors(draft);
  const persistError = workflowPersistenceError(draft);
  function update(next) {
    setDraft(next);
    setRaw(JSON.stringify(next, null, 2));
    setError("");
    setValidation(null);
  }
  function stepUpdate(next) {
    update({
      ...draft,
      steps: draft.steps.map((step, index) => (index === active ? next : step)),
    });
  }
  function move(index, offset) {
    const steps = [...draft.steps];
    const target = index + offset;
    if (target < 0 || target >= steps.length) return;
    [steps[index], steps[target]] = [steps[target], steps[index]];
    update({ ...draft, steps });
    setActive(target);
  }
  function save() {
    if (readOnly) return;
    const message = workflowPersistenceError(draft);
    if (message) {
      setError(message);
      return;
    }
    if (onSave({ ...draft, id: value.id, ownerId: value.ownerId }) === false)
      setError("Changes could not be saved. Your draft is still open.");
  }
  function download() {
    try {
      const data = exportWorkflowDefinition(draft);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "frameleaf-workflow.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setError(error.message);
    }
  }
  function chooseTab(next) {
    setError("");
    if (next === "JSON") setRaw(JSON.stringify(draft, null, 2));
    setTab(next);
    setParameterJson(null);
  }
  return (
    <Dialog
      title={draft.name || "New workflow"}
      close={close}
      wide
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            primary
            disabled={
              readOnly ||
              !!persistError ||
              parameterJson !== null ||
              (tab === "JSON" && raw !== JSON.stringify(draft, null, 2))
            }
            onClick={save}
          >
            Save workflow
          </Button>
        </>
      }
    >
      <div className="workflow-designer">
        <div className="wd-tabs" aria-label="Workflow sections">
          {["Steps", "Validation", "History", "JSON"].map((name) => (
            <Button
              key={name}
              aria-pressed={tab === name}
              onClick={() => chooseTab(name)}
            >
              {name}
            </Button>
          ))}
        </div>
        {readOnly && (
          <p className="wd-message">
            Only the workflow owner can change this definition.
          </p>
        )}
        {draft.legacyDefinition && (
          <p className="wd-message">
            An earlier sample definition was adapted to current workflow
            methods. Its original values remain included in the file.
          </p>
        )}
        {error && (
          <p role="alert" className="wd-error">
            {error}
          </p>
        )}
        {persistError && <p className="wd-message">{persistError}</p>}
        {tab === "Steps" && (
          <>
            <div className="wd-meta">
              <label className="wd-field">
                Name
                <input
                  value={draft.name ?? ""}
                  disabled={readOnly}
                  maxLength={300}
                  onChange={(event) =>
                    update({ ...draft, name: event.target.value || null })
                  }
                />
              </label>
              <label className="wd-field">
                Trigger
                <select
                  value={draft.trigger}
                  disabled={readOnly}
                  onChange={(event) =>
                    update({ ...draft, trigger: event.target.value })
                  }
                >
                  {!workflowTriggers.some(
                    (trigger) => trigger.value === draft.trigger,
                  ) && (
                    <option value={draft.trigger}>
                      {draft.trigger} (unavailable)
                    </option>
                  )}
                  {workflowTriggers.map((trigger) => (
                    <option key={trigger.value} value={trigger.value}>
                      {trigger.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wd-field wd-description">
                Description
                <textarea
                  value={draft.description ?? ""}
                  disabled={readOnly}
                  rows={2}
                  onChange={(event) =>
                    update({
                      ...draft,
                      description: event.target.value || null,
                    })
                  }
                />
              </label>
            </div>
            <div className="wd-switches">
              <label>
                <input
                  type="checkbox"
                  disabled={readOnly || (!draft.enabled && problems.length > 0)}
                  checked={draft.enabled === true}
                  onChange={(event) =>
                    update({ ...draft, enabled: event.target.checked })
                  }
                />
                Enable workflow
              </label>
              <label>
                <input
                  type="checkbox"
                  disabled={readOnly}
                  checked={draft.logging !== false}
                  onChange={(event) =>
                    update({ ...draft, logging: event.target.checked })
                  }
                />
                Keep run history
              </label>
            </div>
            <div className="wd-template">
              <label>
                Start from a template
                <select
                  disabled={readOnly}
                  value={template}
                  onChange={(event) => setTemplate(event.target.value)}
                >
                  <option value="">Choose a template</option>
                  {workflowTemplates.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </label>
              {template && (
                <>
                  <p>
                    {
                      workflowTemplates.find((item) => item.name === template)
                        ?.description
                    }
                  </p>
                  <Button
                    disabled={readOnly}
                    onClick={() => {
                      const chosen = workflowTemplates.find(
                        (item) => item.name === template,
                      );
                      update({
                        ...draft,
                        trigger: chosen.trigger,
                        steps: structuredClone(chosen.steps),
                        name: draft.name || chosen.title,
                        description: draft.description || chosen.description,
                        enabled: false,
                      });
                      setActive(0);
                      setTemplate("");
                    }}
                  >
                    Replace current steps with template
                  </Button>
                </>
              )}
            </div>
            <div className="wd-workspace">
              <div className="wd-steps">
                <h3>Ordered steps</h3>
                <ol>
                  {draft.steps.map((step, index) => (
                    <li
                      key={index}
                      className={index === active ? "selected" : ""}
                    >
                      <button
                        className="wd-step-select"
                        onClick={() => {
                          setActive(index);
                          setParameterJson(null);
                        }}
                        aria-current={index === active ? "step" : undefined}
                      >
                        <strong>
                          {index + 1}.{" "}
                          {methodByKey(step.method)?.title ??
                            "Unavailable plugin method"}
                        </strong>
                        <small>
                          {step.enabled === false
                            ? "Disabled step"
                            : methodByKey(step.method)?.uiHints?.includes(
                                  "Filter",
                                )
                              ? "Filter"
                              : "Action"}
                        </small>
                      </button>
                      <div className="wd-step-actions">
                        <Button
                          disabled={readOnly || index === 0}
                          aria-label={`Move step ${index + 1} earlier`}
                          onClick={() => move(index, -1)}
                        >
                          ↑
                        </Button>
                        <Button
                          disabled={
                            readOnly || index === draft.steps.length - 1
                          }
                          aria-label={`Move step ${index + 1} later`}
                          onClick={() => move(index, 1)}
                        >
                          ↓
                        </Button>
                        <Button
                          disabled={readOnly}
                          aria-label={`Remove step ${index + 1}`}
                          onClick={() => {
                            update({
                              ...draft,
                              steps: draft.steps.filter((_, i) => i !== index),
                            });
                            setActive(
                              Math.max(
                                0,
                                Math.min(active, draft.steps.length - 2),
                              ),
                            );
                          }}
                        >
                          Remove
                        </Button>
                      </div>
                    </li>
                  ))}
                </ol>
                {!draft.steps.length && (
                  <p>Add a filter or an action to get started.</p>
                )}
                <SearchableSelect
                  label="Available method"
                  disabled={readOnly}
                  value={method}
                  options={workflowMethods.map((item) => ({
                    value: item.key,
                    label: item.title,
                  }))}
                  onChange={setMethod}
                />
                <Button
                  disabled={readOnly || !method || draft.steps.length >= 100}
                  onClick={() => {
                    const selected = methodByKey(method);
                    update({
                      ...draft,
                      steps: [
                        ...draft.steps,
                        {
                          method,
                          config: schemaDefaults(selected.schema ?? {}),
                          enabled: true,
                        },
                      ],
                    });
                    setActive(draft.steps.length);
                  }}
                >
                  Add step
                </Button>
              </div>
              <section className="wd-parameters">
                <h3>
                  {definition?.title ??
                    (selected ? "Unavailable method" : "Step details")}
                </h3>
                {definition?.description && <p>{definition.description}</p>}
                {selected && (
                  <>
                    <label className="wd-check">
                      <input
                        type="checkbox"
                        disabled={readOnly}
                        checked={selected.enabled !== false}
                        onChange={(event) =>
                          stepUpdate({
                            ...selected,
                            enabled: event.target.checked,
                          })
                        }
                      />
                      Enable this step
                    </label>
                    {definition ? (
                      <Parameter
                        schema={definition.schema ?? {}}
                        value={selected.config ?? {}}
                        label="Parameters"
                        disabled={readOnly}
                        onChange={(config) =>
                          stepUpdate({ ...selected, config })
                        }
                      />
                    ) : (
                      <p>
                        This method is not installed in the available catalog.
                        Its name, parameters and additional fields are retained.
                        It cannot be enabled or validated here.
                      </p>
                    )}
                    <details>
                      <summary>Method and parameter JSON</summary>
                      <code>{selected.method}</code>
                      <p>
                        Editing visible controls preserves other parameter
                        fields. Change the JSON only when you intend to replace
                        those values.
                      </p>
                      {parameterJson === null ? (
                        <>
                          <pre>
                            {JSON.stringify(selected.config ?? null, null, 2)}
                          </pre>
                          <Button
                            disabled={readOnly}
                            onClick={() =>
                              setParameterJson(
                                JSON.stringify(
                                  selected.config ?? null,
                                  null,
                                  2,
                                ),
                              )
                            }
                          >
                            Edit parameter JSON
                          </Button>
                        </>
                      ) : (
                        <>
                          <textarea
                            aria-label="Step parameter JSON"
                            value={parameterJson}
                            onChange={(event) =>
                              setParameterJson(event.target.value)
                            }
                            rows={12}
                          />
                          <Button onClick={() => setParameterJson(null)}>
                            Cancel parameter edits
                          </Button>
                          <Button
                            disabled={readOnly}
                            onClick={() => {
                              try {
                                const config = JSON.parse(parameterJson);
                                const next = { ...selected, config };
                                parseWorkflowDefinition({
                                  ...draft,
                                  steps: draft.steps.map((step, i) =>
                                    i === active ? next : step,
                                  ),
                                });
                                stepUpdate(next);
                                setParameterJson(null);
                              } catch (error) {
                                setError(error.message);
                              }
                            }}
                          >
                            Apply parameters
                          </Button>
                        </>
                      )}
                    </details>
                  </>
                )}
              </section>
            </div>
            <div className="wd-danger">
              <Button
                disabled={readOnly}
                onClick={() => setDeleting(!deleting)}
              >
                Delete workflow
              </Button>
              {deleting && (
                <>
                  <p>
                    Delete this definition? Previously changed photo metadata is
                    retained.
                  </p>
                  <Button
                    disabled={readOnly}
                    onClick={() => onRemove(value.id)}
                  >
                    Confirm workflow deletion
                  </Button>
                </>
              )}
            </div>
          </>
        )}
        {tab === "Validation" && (
          <>
            <h3>Check the definition</h3>
            <p>
              Validate method availability, required values, choices and ranges
              against the available plugin schemas. No photo is changed and no
              webhook is sent.
            </p>
            <Button
              onClick={() => setValidation(workflowExecutionErrors(draft))}
            >
              Check and preview
            </Button>
            {validation && (
              <div role="status">
                {validation.length ? (
                  <ul>
                    {validation.map((message, index) => (
                      <li key={index}>{message}</li>
                    ))}
                  </ul>
                ) : (
                  <>
                    <p>
                      The definition matches the available schemas. This is
                      what a run would do, step by step:
                    </p>
                    <ol className="wd-preview">
                      {previewWorkflow(draft).map((step, index) => (
                        <li key={index}>
                          <strong>
                            {methodByKey(step.method)?.title || step.method}
                          </strong>
                          <span>{step.result}</span>
                        </li>
                      ))}
                    </ol>
                    <p>
                      Running it still needs the server workflow service and
                      access to its selected albums and tags.
                    </p>
                  </>
                )}
              </div>
            )}
          </>
        )}
        {tab === "History" && (
          <>
            <h3>Workflow history</h3>
            <p>
              No server run history is available on this device. Definition
              validation does not create a completed run.
            </p>
          </>
        )}
        {tab === "JSON" && (
          <>
            <h3>Complete definition</h3>
            <p>
              Unknown plugin parameters and additional fields are kept.
              Unsupported definitions can be saved paused; enabling them
              requires a compatible plugin and trigger.
            </p>
            <textarea
              className="wd-json"
              aria-label="Workflow JSON"
              spellCheck={false}
              readOnly={readOnly}
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
              rows={20}
            />
            <div className="wd-switches">
              <Button
                disabled={readOnly}
                onClick={() => {
                  try {
                    const next = parseWorkflowDefinition(raw);
                    update({ ...next, id: value.id, ownerId: value.ownerId });
                  } catch (error) {
                    setError(error.message);
                  }
                }}
              >
                Apply JSON to draft
              </Button>
              <Button
                disabled={raw !== JSON.stringify(draft, null, 2)}
                onClick={download}
              >
                Export complete definition
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
