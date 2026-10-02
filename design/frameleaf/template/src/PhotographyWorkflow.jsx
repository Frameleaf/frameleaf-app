import React, { useState } from "react";
import { Button, Dialog } from "./Controls";
import { Icon } from "./Icon";
import { Watermark } from "./PhotographyWatermark";
import {
  WORKFLOW_MODES,
  GALLERY_TEMPLATES,
  eligiblePhoto,
  selectionPrice,
  money,
  deliveryBlockers,
  projectNextAction,
  orderProjectPhotos,
} from "./photography-workflow.mjs";
import "./photography-workflow.css";

const projectSections = [
  ["shoots", "Photographs"],
  ["intake", "Intake & assembly"],
  ["workflow", "Client workflow"],
  ["orders", "Orders & delivery"],
  ["templates", "Presentation"],
];
const Field = ({ label, children, hint }) => (
  <label className="phw-field">
    <span>{label}</span>
    {children}
    {hint && <small>{hint}</small>}
  </label>
);
const Switch = ({ label, checked, onChange, hint, disabled }) => (
  <label className="phw-toggle">
    <span>
      <strong>{label}</strong>
      {hint && <small>{hint}</small>}
    </span>
    <input
      type="checkbox"
      checked={!!checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  </label>
);

export function PhotographyProjectNav({ section, onSection }) {
  return (
    <nav className="phx-project-nav" aria-label="Project workspace">
      {projectSections.map(([id, label]) => (
        <button
          key={id}
          aria-current={section === id ? "page" : undefined}
          onClick={() => onSection(id)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

export function PhotographyProjectsSummary({ state, onOpen }) {
  const active = state.shoots.filter((s) => s.status !== "Delivered");
  const orders = Object.values(state.galleries)
    .map((g) => g.order)
    .filter(Boolean);
  const outstanding = orders
    .filter((o) => o.payment !== "paid")
    .reduce((sum, o) => sum + o.totalCents, 0);
  const actions = active.slice(0, 3).map((shoot) => ({
    shoot,
    action: projectNextAction(
      state.galleries[shoot.id],
      state.photos.filter((p) => p.shootId === shoot.id),
    ),
  }));
  return (
    <div className="phx-overview">
      <div className="phx-metrics">
        <div>
          <small>Active projects</small>
          <strong>{active.length}</strong>
        </div>
        <div>
          <small>Awaiting selections</small>
          <strong>
            {
              Object.values(state.galleries).filter(
                (g) => !g.submitted && !g.delivered,
              ).length
            }
          </strong>
        </div>
        <div>
          <small>In the editing queue</small>
          <strong>{orders.filter((o) => !o.finalsApproved).length}</strong>
        </div>
        <div>
          <small>Outstanding · CAD</small>
          <strong>{money(outstanding)}</strong>
        </div>
      </div>
      <div className="phx-action-list">
        <div>
          <span className="phx-eyebrow">Your next steps</span>
          <h2>Keep the story moving.</h2>
        </div>
        <div>
          {actions.map(({ shoot, action }) => (
            <button
              key={shoot.id}
              onClick={() => onOpen(shoot.id, action.section)}
            >
              <Icon name={action.icon} size={19} />
              <span>
                <strong>{shoot.name}</strong>
                <small>{action.label}</small>
              </span>
              <Icon name="mdiChevronRight" size={16} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Local, fictional workflows. Payment, mail and publication controls simulate state only. */
export function PhotographyWorkflow({
  section,
  shoot,
  photos,
  gallery,
  brand,
  onGalleryChange: changeGallery,
  onBrandChange: changeBrand,
  onShootChange: changeShoot,
  onPhotoChange: changePhotos,
  onSection,
  onImport,
  onIngest,
  onEdit,
  onPreview,
  onPrepare,
  onDeliver,
  uploadLogo,
  logoError,
  notify,
}) {
  const [picked, setPicked] = useState([]);
  const [chapter, setChapter] = useState("");
  const [filter, setFilter] = useState("all");
  const [dialog, setDialog] = useState(null);
  const [preview, setPreview] = useState("proof");
  const [orientation, setOrientation] = useState("landscape");
  const [presetName, setPresetName] = useState("");
  const proofs = photos.filter(eligiblePhoto);
  const order = gallery.order;
  const price = order || selectionPrice(gallery);
  const orderPhotos = photos.filter((p) => order?.photoIds.includes(p.id));
  const blockers = deliveryBlockers(gallery, photos);
  const chapters = gallery.chapters || [
    ...new Set(photos.map((p) => p.chapter).filter(Boolean)),
  ];
  const orderedPhotos = orderProjectPhotos(photos, gallery);
  const updateOrder = (patch) =>
    changeGallery({ order: { ...order, ...patch }, zipReady: false });
  const upload = (
    <Field label="Studio logo" hint="PNG, JPEG or WebP · up to 500 KB">
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={uploadLogo}
      />
      {logoError && <span role="alert">{logoError}</span>}
      {brand.logoImage && (
        <Button onClick={() => changeBrand({ logoImage: "" })}>
          Remove uploaded logo
        </Button>
      )}
    </Field>
  );
  const exportOrder = () => {
    const cell = (value) => {
      const text = String(value ?? "");
      return `"${/^[=+@\-\t\r]/.test(text) ? "'" : ""}${text.replaceAll('"', '""')}"`;
    };
    const lines = [
      [
        "Order",
        "Client",
        "Photo",
        "File",
        "Chapter",
        "Retouch notes",
        "Payment",
      ],
      ...orderPhotos.map((p) => [
        order.id,
        shoot.client,
        p.name,
        p.fileName,
        p.chapter,
        gallery.comments
          .filter((c) => c.photoId === p.id)
          .map((c) => c.text)
          .join("; "),
        order.payment,
      ]),
    ];
    const url = URL.createObjectURL(
      new Blob([lines.map((row) => row.map(cell).join(",")).join("\r\n")], {
        type: "text/csv;charset=utf-8",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${order.id}-selections.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("Selection and retouch brief exported as a CSV.");
  };
  return (
    <div className="phx">
      {section !== "watermarks" && (
        <>
          <div className="phx-project-context">
            <img src={shoot.cover} alt="" />
            <span>
              <strong>{shoot.name}</strong>
              <small>
                {shoot.client} · {photos.length} captures · {proofs.length}{" "}
                eligible proofs
              </small>
            </span>
            <Button
              icon="mdiEyeOutline"
              onClick={onPreview}
              disabled={!proofs.length}
            >
              Client preview
            </Button>
          </div>
          <PhotographyProjectNav section={section} onSection={onSection} />
        </>
      )}

      {section === "intake" && (
        <>
          <div className="phx-two-column">
            <section className="phx-panel">
              <span className="phx-eyebrow">01 / Bring the shoot together</span>
              <h2>Every camera. One collection.</h2>
              <p>
                Pair RAW and JPEG captures, review import problems and decide
                what your client will see.
              </p>
              <label
                className="phx-drop-zone"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  onIngest(Array.from(e.dataTransfer.files));
                }}
              >
                <Icon name="mdiCameraPlusOutline" size={30} />
                <strong>Add photographs or a camera folder</strong>
                <span>Choose files, or drop them here</span>
                <input
                  type="file"
                  multiple
                  accept="image/*,.cr2,.cr3,.nef,.arw,.raf,.dng,.orf,.rw2"
                  onChange={(e) => {
                    onIngest(Array.from(e.target.files || []));
                    e.target.value = "";
                  }}
                />
                <small>
                  Prototype intake records filenames and pairs; it uses sample
                  previews.
                </small>
              </label>
              <Button icon="mdiPlus" onClick={() => onImport()}>
                Add six sample captures
              </Button>
            </section>
            <section className="phx-panel">
              <span className="phx-eyebrow">Project brief</span>
              <Field label="Client notes">
                <textarea
                  rows={3}
                  value={shoot.brief || ""}
                  onChange={(e) => changeShoot({ brief: e.target.value })}
                  placeholder="The moments, people and finishing touches that matter."
                />
              </Field>
              <Field label="Delivery target">
                <input
                  type="date"
                  value={shoot.due || ""}
                  onChange={(e) => changeShoot({ due: e.target.value })}
                />
              </Field>
              <div className="phx-import-stats">
                <span>
                  <strong>{photos.filter((p) => p.raw).length}</strong> RAW
                  sources
                </span>
                <span>
                  <strong>{photos.filter((p) => p.jpegFileName).length}</strong>{" "}
                  paired JPEGs
                </span>
                <span>
                  <strong>{photos.filter((p) => p.importFailed).length}</strong>{" "}
                  need attention
                </span>
                <span>
                  <strong>
                    {
                      photos.filter((p) => p.withheld || p.locked || p.rejected)
                        .length
                    }
                  </strong>{" "}
                  withheld
                </span>
              </div>
            </section>
          </div>
          <section className="phx-panel">
            <div className="phx-section-heading">
              <div>
                <h2>Assemble the story</h2>
                <p>
                  Chapters organise the client gallery. Withheld and failed
                  captures stay out of proofs.
                </p>
              </div>
              <Button onClick={() => onSection("shoots")} icon="mdiStarOutline">
                Cull & rate
              </Button>
            </div>
            <div className="phx-chapters">
              {chapters.map((name, index) => (
                <span key={name}>
                  {String(index + 1).padStart(2, "0")} · {name}
                  <button
                    aria-label={`Move ${name} earlier`}
                    disabled={!index}
                    onClick={() => {
                      const next = [...chapters];
                      [next[index - 1], next[index]] = [
                        next[index],
                        next[index - 1],
                      ];
                      changeGallery({ chapters: next, published: false });
                    }}
                  >
                    <Icon name="mdiArrowLeft" size={13} />
                  </button>
                </span>
              ))}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (chapter.trim() && !chapters.includes(chapter.trim()))
                    changeGallery({
                      chapters: [...chapters, chapter.trim()],
                      published: false,
                    });
                  setChapter("");
                }}
              >
                <input
                  aria-label="New chapter"
                  value={chapter}
                  onChange={(e) => setChapter(e.target.value)}
                  placeholder="New chapter…"
                  maxLength={80}
                />
                <Button type="submit" icon="mdiPlus" aria-label="Add chapter" />
              </form>
            </div>
            <div className="phx-table-tools">
              <select
                aria-label="Intake filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">All captures</option>
                <option value="ready">Ready for proofs</option>
                <option value="failed">Import problems</option>
                <option value="withheld">Withheld</option>
              </select>
              <span>{picked.length} selected</span>
              <select
                aria-label="Assign selected to chapter"
                value=""
                disabled={!picked.length}
                onChange={(e) => {
                  changePhotos(picked, { chapter: e.target.value });
                  setPicked([]);
                }}
              >
                <option value="">Assign to chapter…</option>
                {chapters.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
              <Button
                disabled={!picked.length}
                onClick={() => {
                  changePhotos(picked, { withheld: true });
                  setPicked([]);
                }}
              >
                Withhold
              </Button>
            </div>
            <div className="phx-capture-list">
              {orderedPhotos
                .filter(
                  (p) =>
                    filter === "all" ||
                    (filter === "ready" && eligiblePhoto(p)) ||
                    (filter === "failed" && p.importFailed) ||
                    (filter === "withheld" &&
                      (p.withheld || p.rejected || p.locked)),
                )
                .map((p, index) => (
                  <div key={p.id}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${p.name}`}
                      checked={picked.includes(p.id)}
                      onChange={(e) =>
                        setPicked(
                          e.target.checked
                            ? [...picked, p.id]
                            : picked.filter((id) => id !== p.id),
                        )
                      }
                    />
                    <img src={p.image} alt="" />
                    <span>
                      <strong>{p.fileName}</strong>
                      <small>
                        {p.jpegFileName
                          ? `RAW + JPEG pair · ${p.camera || "Camera"}`
                          : `${p.extension || "Image"} · ${p.camera || "Camera source"}`}
                      </small>
                    </span>
                    <select
                      aria-label={`Chapter for ${p.name}`}
                      value={p.chapter || ""}
                      onChange={(e) =>
                        changePhotos([p.id], { chapter: e.target.value })
                      }
                    >
                      <option value="">No chapter</option>
                      {chapters.map((name) => (
                        <option key={name}>{name}</option>
                      ))}
                    </select>
                    <Button
                      icon="mdiArrowUp"
                      aria-label={`Move ${p.name} earlier in the chapter`}
                      disabled={
                        orderedPhotos
                          .filter(
                            (item) =>
                              (item.chapter || "") === (p.chapter || ""),
                          )
                          .indexOf(p) === 0
                      }
                      onClick={() => {
                        const next = [
                          ...(gallery.photoOrder ||
                            photos.map((item) => item.id)),
                        ];
                        const index = next.indexOf(p.id);
                        const prior = next
                          .slice(0, index)
                          .findLast(
                            (id) =>
                              photos.find((item) => item.id === id)?.chapter ===
                              p.chapter,
                          );
                        if (!prior) return;
                        const before = next.indexOf(prior);
                        [next[before], next[index]] = [
                          next[index],
                          next[before],
                        ];
                        changeGallery({ photoOrder: next, published: false });
                      }}
                    />
                    <small
                      className={`phx-tag ${p.importFailed ? "warning" : ""}`}
                    >
                      {p.importFailed
                        ? "Preview failed"
                        : p.locked
                          ? "Locked"
                          : p.withheld || p.rejected
                            ? "Withheld"
                            : p.edited
                              ? "Edited"
                              : "Ready for proofs"}
                    </small>
                    {p.importFailed ? (
                      <Button
                        onClick={() => {
                          changePhotos([p.id], { importFailed: false });
                          notify(
                            "Sample preview retried. Original source unchanged.",
                          );
                        }}
                      >
                        Retry
                      </Button>
                    ) : p.withheld && !p.locked ? (
                      <Button
                        onClick={() =>
                          changePhotos([p.id], { withheld: false })
                        }
                      >
                        Restore
                      </Button>
                    ) : (
                      <small className="phx-capture-number">
                        {String(photos.indexOf(p) + 1).padStart(3, "0")}
                      </small>
                    )}
                  </div>
                ))}
            </div>
            {!photos.length && (
              <p>Add a sample set or choose files to start your project.</p>
            )}
          </section>
        </>
      )}

      {section === "workflow" && (
        <>
          <section className="phx-panel">
            <span className="phx-eyebrow">02 / Choose the client journey</span>
            <h2>Share now. Finish what matters.</h2>
            <p>
              Choose how selections, edits and delivery work for this project.
            </p>
            <div className="phx-mode-grid">
              {WORKFLOW_MODES.map((mode) => (
                <button
                  key={mode.id}
                  aria-pressed={gallery.workflowMode === mode.id}
                  disabled={gallery.submitted}
                  onClick={() =>
                    changeGallery({
                      workflowEnabled: true,
                      workflowMode: mode.id,
                      proofScope: mode.id === "delivery" ? "selected" : "all",
                      published: false,
                    })
                  }
                >
                  <Icon name={mode.icon} size={23} />
                  <strong>{mode.name}</strong>
                  <span>{mode.description}</span>
                  {gallery.workflowMode === mode.id && (
                    <small>
                      <Icon name="mdiCheck" size={14} /> Selected
                    </small>
                  )}
                </button>
              ))}
            </div>
            {gallery.submitted && (
              <p className="phx-caption">
                The submitted selection keeps its agreed package and price.
              </p>
            )}
          </section>
          <div className="phx-two-column">
            <section className="phx-panel">
              <h2>Selection & package</h2>
              <Field
                label="Proof collection"
                hint="RAW sources, Locked items and rejected captures are never downloadable here."
              >
                <select
                  value={gallery.proofScope || "selected"}
                  disabled={gallery.submitted}
                  onChange={(e) =>
                    changeGallery({
                      proofScope: e.target.value,
                      workflowEnabled: true,
                      published: false,
                    })
                  }
                >
                  <option value="all">Every eligible ingested capture</option>
                  <option value="selected">
                    Photographer-selected captures only
                  </option>
                </select>
              </Field>
              <div className="phx-fields">
                <Field label="Included finished photographs">
                  <input
                    type="number"
                    min="0"
                    max="5000"
                    value={gallery.includedCount ?? 10}
                    disabled={gallery.submitted}
                    onChange={(e) =>
                      changeGallery({
                        includedCount: Math.max(
                          0,
                          Math.min(5000, Number(e.target.value)),
                        ),
                        workflowEnabled: true,
                      })
                    }
                  />
                </Field>
                <Field label="Each additional photograph · CAD">
                  <input
                    type="number"
                    min="0"
                    max="10000"
                    step="0.01"
                    value={(gallery.extraPriceCents || 0) / 100}
                    disabled={gallery.submitted}
                    onChange={(e) =>
                      changeGallery({
                        extraPriceCents: Math.max(
                          0,
                          Math.min(
                            1000000,
                            Math.round(Number(e.target.value) * 100),
                          ),
                        ),
                        workflowEnabled: true,
                      })
                    }
                  />
                </Field>
              </div>
              <Field label="Maximum client selections">
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={gallery.selectionLimit}
                  disabled={gallery.submitted}
                  onChange={(e) =>
                    changeGallery({
                      selectionLimit: Math.max(
                        1,
                        Math.min(50, Number(e.target.value) || 1),
                      ),
                    })
                  }
                />
              </Field>
              <Button
                onClick={() => {
                  changeGallery({
                    workflowEnabled: true,
                    workflowMode: "sales",
                    includedCount: 10,
                    extraPriceCents: 2500,
                    proofScope: "all",
                    selectionLimit: 50,
                  });
                  notify(
                    "Portrait package applied: 10 included, $25 per extra photograph.",
                  );
                }}
                disabled={gallery.submitted}
              >
                Use portrait package · 10 + $25 extras
              </Button>
              <p className="phx-caption">
                A draft estimate appears as the client chooses. Submission
                creates the order for your review.
              </p>
            </section>
            <section className="phx-panel">
              <h2>Protection & delivery</h2>
              <Switch
                label="Watermark every proof"
                checked={gallery.watermark}
                onChange={(value) =>
                  changeGallery({ watermark: value, published: false })
                }
                hint="Includes contact-sheet previews and enlarged proofs."
              />
              <Field label="Proof watermark pattern">
                <select
                  value={gallery.proofPattern || "tile"}
                  onChange={(e) =>
                    changeGallery({
                      proofPattern: e.target.value,
                      published: false,
                    })
                  }
                >
                  <option value="tile">Repeated across the photograph</option>
                  <option value="diagonal">Prominent diagonal</option>
                  <option value="center">Centred studio mark</option>
                  <option value="signature">Corner signature</option>
                </select>
              </Field>
              <Switch
                label="Keep studio branding on web previews"
                checked={gallery.webWatermark ?? true}
                onChange={(value) =>
                  changeGallery({ webWatermark: value, published: false })
                }
                hint="The online gallery keeps your mark after final delivery."
              />
              <Switch
                label="Put the mark on downloaded finals"
                checked={gallery.export.watermark}
                onChange={(value) =>
                  changeGallery({
                    export: { ...gallery.export, watermark: value },
                    zipReady: false,
                  })
                }
                hint="Off by default. Permitted downloads contain the approved edit without the online logo."
              />
              <Button
                icon="mdiBrushOutline"
                onClick={() => onSection("watermarks")}
              >
                Design the watermark
              </Button>
              <div className="phx-flow-strip">
                <span>Proof all</span>
                <Icon name="mdiChevronRight" size={14} />
                <span>Client chooses</span>
                <Icon name="mdiChevronRight" size={14} />
                <span>Edit & pay</span>
                <Icon name="mdiChevronRight" size={14} />
                <span>Deliver</span>
              </div>
            </section>
          </div>
          <section className="phx-panel">
            <div className="phx-section-heading">
              <div>
                <h2>Ready to share?</h2>
                <p>
                  Prepare the current gallery, then review it as your client.
                </p>
              </div>
              <Button
                primary
                disabled={!proofs.length || gallery.submitted}
                onClick={() => {
                  changeGallery({ published: true, invited: true });
                  changeShoot({ status: "Proofing" });
                  notify(
                    "Sample proof gallery prepared. No invitation was sent.",
                  );
                }}
              >
                Prepare proof gallery
              </Button>
            </div>
            <div className="phx-fields">
              <Field label="Welcome message">
                <textarea
                  rows={3}
                  value={gallery.introduction || ""}
                  placeholder="Take your time. Choose the photographs you love and leave a note for me."
                  onChange={(e) =>
                    changeGallery({
                      introduction: e.target.value,
                      published: false,
                    })
                  }
                />
              </Field>
              <div>
                <Switch
                  label="Selection reminder"
                  checked={gallery.reminders?.selections}
                  onChange={(v) =>
                    changeGallery({
                      reminders: { ...gallery.reminders, selections: v },
                    })
                  }
                  hint="Preview only; no email is sent."
                />
                <Switch
                  label="Payment & expiry reminders"
                  checked={gallery.reminders?.payment}
                  onChange={(v) =>
                    changeGallery({
                      reminders: {
                        ...gallery.reminders,
                        payment: v,
                        expiry: v,
                      },
                    })
                  }
                />
                <Button
                  onClick={() => {
                    setDialog("reminder");
                  }}
                >
                  Preview reminder
                </Button>
              </div>
            </div>
            <Button
              onClick={() => onSection("galleries")}
              icon="mdiShieldLockOutline"
            >
              Passwords, invitations & expiry
            </Button>
          </section>
        </>
      )}

      {section === "orders" && (
        <>
          <div className="phx-order-header">
            <div>
              <span className="phx-eyebrow">
                03 / From favourites to finished photographs
              </span>
              <h2>
                {order
                  ? `Order ${order.id}`
                  : "Waiting for the first selection"}
              </h2>
              <p>
                {order
                  ? `${order.count} photographs · ${order.included} included · ${order.extra} additional`
                  : "Your client submits their favourites in the gallery. Their selection and retouch notes arrive here."}
              </p>
            </div>
            <strong>{money(price.totalCents, gallery.currency)}</strong>
          </div>
          {!order ? (
            <section className="phx-panel phx-order-empty">
              <Icon name="mdiHeartOutline" size={42} />
              <h2>Let your client make the shortlist.</h2>
              <p>
                All eligible proofs stay protected online. You only finish the
                photographs they choose.
              </p>
              <Button primary onClick={onPreview}>
                Open client preview
              </Button>
              <Button onClick={() => onSection("workflow")}>
                Configure the package
              </Button>
            </section>
          ) : (
            <>
              <div className="phx-two-column">
                <section className="phx-panel">
                  <h2>Selection & retouch brief</h2>
                  <div className="phx-order-photos">
                    {orderPhotos.map((p) => (
                      <div key={p.id}>
                        <img
                          src={p.image}
                          alt={p.name}
                          style={{ filter: p.previewFilter }}
                        />
                        <span>
                          <strong>{p.name}</strong>
                          <small>
                            {p.edited
                              ? "Edited version ready"
                              : "Waiting for your edit"}
                          </small>
                          {gallery.comments
                            .filter((c) => c.photoId === p.id)
                            .map((c) => (
                              <p key={c.id}>“{c.text}”</p>
                            ))}
                        </span>
                        <Icon
                          name={
                            p.edited
                              ? "mdiCheckCircleOutline"
                              : "mdiClockOutline"
                          }
                          size={18}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="phx-buttons">
                    <Button
                      icon="mdiTune"
                      primary
                      disabled={!orderPhotos.length}
                      onClick={() => onEdit(orderPhotos)}
                    >
                      Edit selected photographs
                    </Button>
                    <Button icon="mdiDownload" onClick={exportOrder}>
                      Export selection CSV
                    </Button>
                  </div>
                </section>
                <section className="phx-panel">
                  <h2>Release checklist</h2>
                  <ol className="phx-checklist">
                    <li className={order.confirmed ? "done" : ""}>
                      <Icon
                        name={
                          order.confirmed
                            ? "mdiCheckCircleOutline"
                            : "mdiNumeric1CircleOutline"
                        }
                      />
                      <span>
                        <strong>Confirm the selection & price</strong>
                        <small>
                          {order.included} included + {order.extra} ×{" "}
                          {money(order.unitPriceCents, order.currency)} ={" "}
                          {money(order.totalCents, order.currency)}
                        </small>
                      </span>
                      <Button
                        disabled={order.confirmed || gallery.delivered}
                        onClick={() => updateOrder({ confirmed: true })}
                      >
                        {order.confirmed ? "Confirmed" : "Confirm"}
                      </Button>
                    </li>
                    <li
                      className={
                        orderPhotos.every((p) => p.edited) ? "done" : ""
                      }
                    >
                      <Icon name="mdiImageEditOutline" />
                      <span>
                        <strong>Finish the chosen edits</strong>
                        <small>
                          {orderPhotos.filter((p) => p.edited).length} of{" "}
                          {orderPhotos.length} ready · original files preserved
                        </small>
                      </span>
                    </li>
                    <li className={order.finalsApproved ? "done" : ""}>
                      <Icon name="mdiImageCheckOutline" />
                      <span>
                        <strong>Approve the finished versions</strong>
                        <small>Review your work before releasing it.</small>
                      </span>
                      <Button
                        disabled={
                          !order.confirmed ||
                          !orderPhotos.length ||
                          orderPhotos.some(
                            (p) => !p.edited || !eligiblePhoto(p),
                          ) ||
                          gallery.delivered
                        }
                        onClick={() =>
                          changeGallery({
                            approved: true,
                            order: { ...order, finalsApproved: true },
                            zipReady: false,
                          })
                        }
                      >
                        {order.finalsApproved ? "Approved" : "Approve finals"}
                      </Button>
                    </li>
                    <li
                      className={
                        !order.totalCents || order.payment === "paid"
                          ? "done"
                          : ""
                      }
                    >
                      <Icon name="mdiCreditCardOutline" />
                      <span>
                        <strong>
                          {order.totalCents
                            ? "Record the payment"
                            : "No additional payment needed"}
                        </strong>
                        <small>
                          {order.payment === "paid"
                            ? `Paid · ${money(order.totalCents, order.currency)}`
                            : order.totalCents
                              ? `${money(order.totalCents, order.currency)} outstanding · simulated payment`
                              : "Included in the agreed package."}
                        </small>
                      </span>
                      {order.totalCents > 0 && (
                        <Button
                          disabled={
                            !order.confirmed || order.payment === "paid"
                          }
                          onClick={() => setDialog("payment")}
                        >
                          Record payment
                        </Button>
                      )}
                    </li>
                  </ol>
                  <div className="phx-delivery-status">
                    <Icon
                      name={
                        blockers.length
                          ? "mdiLockOutline"
                          : "mdiCheckCircleOutline"
                      }
                    />
                    <div>
                      <strong>
                        {gallery.delivered
                          ? "Finished collection delivered"
                          : blockers.length
                            ? "Delivery is held"
                            : "Ready for a beautiful handoff"}
                      </strong>
                      <small>
                        {blockers.length
                          ? blockers.join(" · ")
                          : `${order.count} approved photographs · ${gallery.export.watermark ? "branded" : "clean"} downloads`}
                      </small>
                    </div>
                  </div>
                  <div className="phx-buttons">
                    <Button
                      disabled={!!blockers.length || gallery.delivered}
                      onClick={onPrepare}
                      icon="mdiFolderZipOutline"
                    >
                      {gallery.zipReady ? "ZIP prepared" : "Prepare ZIP"}
                    </Button>
                    <Button
                      primary
                      disabled={
                        !!blockers.length ||
                        !gallery.zipReady ||
                        gallery.delivered
                      }
                      onClick={onDeliver}
                    >
                      {gallery.delivered
                        ? "Delivered"
                        : "Deliver approved finals"}
                    </Button>
                  </div>
                  <Button onClick={() => onSection("galleries")}>
                    Export size, format & colour profile
                  </Button>
                </section>
              </div>
              <section className="phx-panel">
                <div className="phx-fields">
                  <Switch
                    label="Client permits portfolio use"
                    checked={gallery.portfolioConsent}
                    onChange={(v) => changeGallery({ portfolioConsent: v })}
                    hint="Record consent separately from buying photographs. Portfolio inclusion still needs your explicit action."
                  />
                  <div>
                    <p className="phx-caption">
                      The complete proof collection remains online with your web
                      watermark. Download rights cover only the approved
                      photographs in this order.
                    </p>
                    <Button onClick={onPreview} icon="mdiEyeOutline">
                      Review the client handoff
                    </Button>
                  </div>
                </div>
              </section>
            </>
          )}
        </>
      )}

      {section === "templates" && (
        <>
          <section className="phx-panel">
            <span className="phx-eyebrow">
              04 / Give the collection its own atmosphere
            </span>
            <h2>A presentation worthy of the photographs.</h2>
            <p>
              Choose a starting point, then make the cover, chapters and pacing
              your own.
            </p>
            <div className="phx-template-grid">
              {GALLERY_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  aria-pressed={gallery.template === t.id}
                  onClick={() =>
                    changeGallery({
                      template: t.id,
                      coverStyle:
                        t.id === "wedding"
                          ? "full-bleed"
                          : t.id === "fine-art"
                            ? "minimal"
                            : "split",
                      published: false,
                    })
                  }
                >
                  <div
                    className={`phx-template-cover ${t.id}`}
                    style={{ background: t.color }}
                  >
                    <small>{brand.name}</small>
                    <img src={t.image} alt="" />
                    <span>{t.id === "wedding" ? "Maya & Theo" : t.name}</span>
                    <div>
                      {["lake", "portrait", "flowers"].map((scene) => (
                        <img key={scene} src={`/media/${scene}.png`} alt="" />
                      ))}
                    </div>
                  </div>
                  <strong>{t.name}</strong>
                  <span>{t.description}</span>
                  {gallery.template === t.id && (
                    <small className="phx-selected-label">
                      <Icon name="mdiCheck" size={14} /> Current presentation
                    </small>
                  )}
                </button>
              ))}
            </div>
          </section>
          <div className="phx-two-column">
            <section className="phx-panel">
              <h2>Cover & pacing</h2>
              <Field label="Cover photograph">
                <select
                  value={gallery.coverId || shoot.cover}
                  onChange={(e) => {
                    const p = photos.find((p) => p.id === e.target.value);
                    changeGallery({
                      coverId: e.target.value,
                      published: false,
                    });
                    if (p) changeShoot({ cover: p.image });
                  }}
                >
                  <option value={shoot.cover}>Project cover</option>
                  {proofs.map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="phx-fields">
                <Field label="Cover treatment">
                  <select
                    value={gallery.coverStyle || "split"}
                    onChange={(e) =>
                      changeGallery({
                        coverStyle: e.target.value,
                        published: false,
                      })
                    }
                  >
                    <option value="full-bleed">Full photograph</option>
                    <option value="split">Photograph & introduction</option>
                    <option value="minimal">Quiet editorial</option>
                  </select>
                </Field>
                <Field label="Image spacing">
                  <select
                    value={gallery.spacing || "comfortable"}
                    onChange={(e) =>
                      changeGallery({
                        spacing: e.target.value,
                        published: false,
                      })
                    }
                  >
                    <option value="compact">Compact</option>
                    <option value="comfortable">Comfortable</option>
                    <option value="airy">Airy</option>
                  </select>
                </Field>
              </div>
              <Field label="Cover focal point">
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={gallery.focalPoint ?? 50}
                  onChange={(e) =>
                    changeGallery({
                      focalPoint: Number(e.target.value),
                      published: false,
                    })
                  }
                />
              </Field>
              <Field label="Gallery introduction">
                <textarea
                  rows={3}
                  value={gallery.introduction || ""}
                  onChange={(e) =>
                    changeGallery({
                      introduction: e.target.value,
                      published: false,
                    })
                  }
                  placeholder="A small collection of moments to keep."
                />
              </Field>
            </section>
            <section className="phx-panel">
              <h2>Identity & finishing touches</h2>
              <Field label="Gallery typography">
                <select
                  value={gallery.typography || "editorial"}
                  onChange={(e) =>
                    changeGallery({
                      typography: e.target.value,
                      published: false,
                    })
                  }
                >
                  <option value="editorial">Editorial serif</option>
                  <option value="modern">Modern sans</option>
                  <option value="script">Wedding script headings</option>
                </select>
              </Field>
              <Field label="Gallery palette">
                <select
                  value={gallery.theme || "studio"}
                  onChange={(e) =>
                    changeGallery({ theme: e.target.value, published: false })
                  }
                >
                  <option value="studio">Studio colours</option>
                  <option value="ivory">Warm ivory</option>
                  <option value="charcoal">Quiet charcoal</option>
                </select>
              </Field>
              <Switch
                label="Show chapter headings"
                checked={gallery.showChapters ?? true}
                onChange={(v) =>
                  changeGallery({ showChapters: v, published: false })
                }
              />
              <Switch
                label="Show stable photograph numbers"
                checked={gallery.showNumbers ?? true}
                onChange={(v) =>
                  changeGallery({ showNumbers: v, published: false })
                }
                hint="Numbers stay with the same photograph when a client filters the collection."
              />
              <div className="phx-buttons">
                <Button primary onClick={onPreview} icon="mdiEyeOutline">
                  Preview presentation
                </Button>
                <Button onClick={() => onSection("website")}>
                  Portfolio, About & Contact
                </Button>
              </div>
              <p className="phx-caption">
                Use Intake & assembly to group and sequence chapters. Your
                existing website layouts and pages remain available.
              </p>
            </section>
          </div>
        </>
      )}

      {section === "watermarks" && (
        <>
          <div className="phx-watermark-layout">
            <section className="phx-panel">
              <span className="phx-eyebrow">Studio watermark</span>
              <h2>Your signature, your way.</h2>
              <Field label="Watermark content">
                <select
                  value={brand.watermarkType || "text"}
                  onChange={(e) =>
                    changeBrand({ watermarkType: e.target.value })
                  }
                >
                  <option value="text">Studio name</option>
                  <option value="logo">Uploaded logo</option>
                  <option value="both">Logo & studio name</option>
                </select>
              </Field>
              {brand.watermarkType !== "logo" && (
                <>
                  <Field label="Watermark text">
                    <input
                      value={brand.watermarkText ?? brand.name}
                      maxLength={100}
                      onChange={(e) =>
                        changeBrand({ watermarkText: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Watermark font">
                    <select
                      value={brand.watermarkFont || "script"}
                      onChange={(e) =>
                        changeBrand({ watermarkFont: e.target.value })
                      }
                    >
                      <option value="script">
                        Great Vibes · wedding script
                      </option>
                      <option value="serif">Classic serif</option>
                      <option value="sans">Modern sans</option>
                    </select>
                  </Field>
                </>
              )}
              {upload}
              <Field label="Proof pattern">
                <select
                  value={brand.watermarkPattern || "tile"}
                  onChange={(e) => {
                    changeBrand({ watermarkPattern: e.target.value });
                    changeGallery({ proofPattern: e.target.value });
                  }}
                >
                  <option value="tile">Repeated tile</option>
                  <option value="diagonal">Diagonal</option>
                  <option value="center">Centre</option>
                  <option value="signature">Corner signature</option>
                </select>
              </Field>
              <div className="phx-fields">
                <Field label="Position">
                  <select
                    value={brand.watermarkPosition}
                    onChange={(e) =>
                      changeBrand({ watermarkPosition: e.target.value })
                    }
                  >
                    <option value="bottom-right">Bottom right</option>
                    <option value="bottom-left">Bottom left</option>
                    <option value="top-right">Top right</option>
                    <option value="top-left">Top left</option>
                    <option value="center">Centre</option>
                  </select>
                </Field>
                <Field label="Colour">
                  <input
                    type="color"
                    value={brand.watermarkColor}
                    onChange={(e) =>
                      changeBrand({ watermarkColor: e.target.value })
                    }
                  />
                </Field>
              </div>
              {[
                ["Opacity", "watermarkOpacity", 10, 100, 45],
                ["Size", "watermarkSize", 3, 15, 6],
                ["Rotation", "watermarkAngle", -45, 45, -24],
                ["Tile spacing", "watermarkSpacing", 2, 12, 6],
              ].map(([label, key, min, max, fallback]) => (
                <Field
                  key={key}
                  label={`${label} · ${brand[key] ?? fallback}${key === "watermarkOpacity" ? "%" : key === "watermarkAngle" ? "°" : ""}`}
                >
                  <input
                    type="range"
                    min={min}
                    max={max}
                    value={brand[key] ?? fallback}
                    onChange={(e) =>
                      changeBrand({ [key]: Number(e.target.value) })
                    }
                  />
                </Field>
              ))}
              <Field label="Proof caption">
                <input
                  value={brand.watermarkSubline ?? "Proof · not retouched"}
                  maxLength={80}
                  onChange={(e) =>
                    changeBrand({ watermarkSubline: e.target.value })
                  }
                />
              </Field>
              <Button onClick={() => onSection("branding")}>
                Studio identity & contact details
              </Button>
            </section>
            <div>
              <section className="phx-panel">
                <div className="phx-section-heading">
                  <div>
                    <h2>See it on the photograph</h2>
                    <p>
                      {preview === "clean"
                        ? "Approved download · online branding removed"
                        : preview === "web"
                          ? "Delivered web preview · studio signature retained"
                          : "Unedited proof · prominent repeated protection"}
                    </p>
                  </div>
                  <select
                    aria-label="Watermark canvas orientation"
                    value={orientation}
                    onChange={(e) => setOrientation(e.target.value)}
                  >
                    <option value="landscape">Landscape</option>
                    <option value="portrait">Portrait</option>
                  </select>
                </div>
                <div className="phx-preview-tabs">
                  {[
                    ["proof", "Proof"],
                    ["web", "Web preview"],
                    ["clean", "Clean download"],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      aria-pressed={preview === id}
                      onClick={() => setPreview(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className={`phx-watermark-canvas ${orientation}`}>
                  <img
                    src={
                      orientation === "portrait"
                        ? "/media/portrait.png"
                        : "/media/wedding-elopement.png"
                    }
                    alt="Fictional photograph for watermark preview"
                  />
                  <Watermark
                    brand={brand}
                    enabled={preview !== "clean"}
                    variant={preview === "web" ? "web" : "proof"}
                    pattern={
                      preview === "proof"
                        ? brand.watermarkPattern || "tile"
                        : undefined
                    }
                  />
                </div>
                <p className="phx-caption">
                  Design overlay on sample photographs. Production proofs must
                  have the mark burned into every rendition.
                </p>
              </section>
              <section className="phx-panel">
                <h2>Start with a preset</h2>
                <div className="phx-buttons">
                  <Button
                    onClick={() => {
                      changeBrand({
                        watermarkType: "text",
                        watermarkFont: "script",
                        watermarkPattern: "tile",
                        watermarkOpacity: 45,
                        watermarkSize: 7,
                        watermarkAngle: -24,
                      });
                      changeGallery({ proofPattern: "tile" });
                      setPreview("proof");
                    }}
                  >
                    Wedding proofs
                  </Button>
                  <Button
                    onClick={() => {
                      changeBrand({
                        watermarkType: "logo",
                        watermarkPattern: "tile",
                        watermarkOpacity: 55,
                        watermarkSize: 7,
                      });
                      changeGallery({ proofPattern: "tile" });
                      setPreview("proof");
                    }}
                  >
                    Logo proofs
                  </Button>
                  <Button
                    onClick={() => {
                      changeBrand({
                        watermarkType: "text",
                        watermarkFont: "script",
                        watermarkPosition: "bottom-right",
                        watermarkSize: 6,
                      });
                      setPreview("web");
                    }}
                  >
                    Quiet signature
                  </Button>
                </div>
                <form
                  className="phx-preset-save"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!presetName.trim()) return;
                    const keys = Object.keys(brand).filter((k) =>
                      k.startsWith("watermark"),
                    );
                    const preset = Object.fromEntries(
                      keys.map((k) => [k, brand[k]]),
                    );
                    changeBrand({
                      watermarkPresets: [
                        ...(brand.watermarkPresets || []),
                        { name: presetName.trim(), values: preset },
                      ],
                    });
                    setPresetName("");
                    notify("Watermark preset saved locally.");
                  }}
                >
                  <input
                    aria-label="Watermark preset name"
                    placeholder="Name your preset…"
                    maxLength={60}
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                  />
                  <Button type="submit" disabled={!presetName.trim()}>
                    Save preset
                  </Button>
                </form>
                {(brand.watermarkPresets || []).map((p, index) => (
                  <Button
                    key={index}
                    onClick={() => {
                      changeBrand(p.values);
                      changeGallery({
                        proofPattern: p.values.watermarkPattern,
                      });
                    }}
                  >
                    {p.name}
                  </Button>
                ))}
              </section>
            </div>
          </div>
        </>
      )}
      {dialog === "payment" && (
        <Dialog title="Record a sample payment" close={() => setDialog(null)}>
          <p>
            {money(order.totalCents, order.currency)} for {order.extra}{" "}
            additional photographs.
          </p>
          <p>
            This marks the fictional order as paid. No card is charged and no
            payment service is connected.
          </p>
          <div className="phx-buttons">
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              primary
              onClick={() => {
                updateOrder({
                  payment: "paid",
                  paidAt: new Date().toISOString(),
                });
                setDialog(null);
                notify(
                  "Sample payment recorded. Delivery still requires approved finished edits.",
                );
              }}
            >
              Mark sample payment received
            </Button>
          </div>
        </Dialog>
      )}
      {dialog === "reminder" && (
        <Dialog
          title="Selection reminder preview"
          close={() => setDialog(null)}
        >
          <p>To: {gallery.invite || shoot.client}</p>
          <h3>Your photographs are ready to choose</h3>
          <p>
            Hello {shoot.client}, take another look through “{shoot.name}” and
            send me the photographs you love. Your collection includes{" "}
            {gallery.includedCount} finished photographs
            {gallery.extraPriceCents
              ? `, with additional choices at ${money(gallery.extraPriceCents, gallery.currency)} each`
              : ""}
            .
          </p>
          <p>
            Please submit your selections before {gallery.expires}. I’ll take
            care of the finishing touches.
          </p>
          <small className="phx-caption">
            Preview only · no message has been sent.
          </small>
        </Dialog>
      )}
    </div>
  );
}
