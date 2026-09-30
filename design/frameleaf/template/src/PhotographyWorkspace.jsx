import React, { useEffect, useState } from "react";
import { Button, Dialog } from "./Controls";
import { Icon } from "./Icon";
import {
  createProofGallery,
  demoPhotos,
  photosForShoot,
  proofPhotos,
  readStudioState,
  saveStudioState,
  shootStages,
  toggleClientSelection,
} from "./photography-data.mjs";
import {
  defaultEdit,
  photographyStorageKey as editorStorageKey,
  previewFor,
  readSession,
} from "./photography-edit.mjs";
import "./photography-workspace.css";

const sections = [
  ["shoots", "Shoots", "mdiCameraOutline"],
  ["galleries", "Galleries", "mdiImageMultipleOutline"],
  ["website", "Website", "mdiWeb"],
  ["branding", "Branding", "mdiPaletteOutline"],
  ["publishing", "Publishing", "mdiCloudUploadOutline"],
];
const photoTabs = ["All", "Selected", "Edited", "Deliverables"];
const dateLabel = (date) =>
  new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

function Field({ label, children, hint }) {
  return (
    <label className="phw-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Toggle({ label, checked, onChange, hint, disabled }) {
  return (
    <label className="phw-toggle">
      <span>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
      />
    </label>
  );
}

function Watermark({ brand, enabled = true }) {
  if (!enabled) return null;
  return (
    <span
      className={`phw-watermark at-${brand.watermarkPosition}`}
      style={{
        color: brand.watermarkColor,
        opacity: brand.watermarkOpacity / 100,
        fontSize: `${brand.watermarkSize}cqw`,
      }}
    >
      {brand.logoImage ? (
        <img src={brand.logoImage} alt={brand.name} />
      ) : (
        brand.logo || brand.name
      )}
    </span>
  );
}

// This workspace is a local design simulation: invitations, publication and
// ZIP exports change preview state only. All original media stays untouched.
export function PhotographyWorkspace({
  onOpenEditor,
  onPreviewGallery,
  onPreviewWebsite,
  onOpenRaw,
  onBack,
  notify,
}) {
  const [state, setState] = useState(() => {
    try {
      return readStudioState(window.localStorage);
    } catch {
      return readStudioState(null);
    }
  });
  const [editSessions] = useState(() => {
    try {
      return Object.fromEntries(
        state.shoots.map((shoot) => [
          shoot.id,
          readSession(
            photosForShoot(state, shoot.id),
            window.localStorage,
            editorStorageKey(shoot),
          ),
        ]),
      );
    } catch {
      return {};
    }
  });
  const [section, setSection] = useState("shoots");
  const [shootId, setShootId] = useState(state.shoots[0].id);
  const [detail, setDetail] = useState(false);
  const [tab, setTab] = useState("All");
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("date");
  const [dialog, setDialog] = useState(null);
  const [saving, setSaving] = useState(true);
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState({
    name: "",
    client: "",
    type: "Family portrait",
    date: new Date().toISOString().slice(0, 10),
  });
  const [comment, setComment] = useState("");
  const [commentPhoto, setCommentPhoto] = useState("");
  const [logoError, setLogoError] = useState("");

  useEffect(() => {
    // Restore mock adjustments from the editor on returning to the workspace.
    // Filter previews do not replace or claim to render the original RAW file.
    setState((current) => ({
      ...current,
      photos: current.photos.map((photo) => {
        const record = editSessions[photo.shootId]?.records[photo.id];
        return record
          ? {
              ...photo,
              edited:
                photo.edited ||
                JSON.stringify(record.history.present) !==
                  JSON.stringify(defaultEdit()),
            }
          : photo;
      }),
    }));
  }, [editSessions]);

  useEffect(() => {
    try {
      setSaving(saveStudioState(window.localStorage, state));
    } catch {
      setSaving(false);
    }
  }, [state]);

  const shoot =
    state.shoots.find((item) => item.id === shootId) || state.shoots[0];
  const photos = photosForShoot(state, shoot.id);
  const proofs = proofPhotos(state, shoot.id);
  const gallery = state.galleries[shoot.id];
  const brand = state.brand;
  const website = state.website;
  const publishing = state.publishing;
  const visible = photos.filter(
    (photo) =>
      tab === "All" ||
      (tab === "Selected" && photo.selected && !photo.rejected) ||
      (tab === "Edited" && photo.edited && !photo.rejected) ||
      (tab === "Deliverables" && photo.deliverable && !photo.rejected),
  );
  const chosen = photos.filter((photo) => selected.includes(photo.id));
  const portfolio = website.order
    .map((id) => state.photos.find((photo) => photo.id === id))
    .filter((photo) => photo && !photo.rejected);
  const cover =
    portfolio.find((photo) => photo.id === website.coverId) || portfolio[0];
  const expired =
    gallery?.expired ||
    !!(
      gallery?.expires &&
      gallery.expires < new Date().toISOString().slice(0, 10)
    );
  const clientPhotos = proofs.filter((photo) =>
    gallery?.clientSelected.includes(photo.id),
  );

  function say(text) {
    setMessage(text);
    notify?.(text);
  }
  function changeBrand(patch) {
    setState((current) => ({
      ...current,
      brand: { ...current.brand, ...patch },
    }));
  }
  function changeWebsite(patch) {
    setState((current) => {
      const next = { ...current.website, ...patch, published: false };
      if (!next.order.includes(next.coverId))
        next.coverId = next.order[0] || "";
      return { ...current, website: next };
    });
  }
  function changePublishing(patch) {
    setState((current) => ({
      ...current,
      publishing: { ...current.publishing, ...patch, published: false },
    }));
  }
  function changeShoot(patch) {
    setState((current) => ({
      ...current,
      shoots: current.shoots.map((item) =>
        item.id === shoot.id ? { ...item, ...patch } : item,
      ),
    }));
  }
  function changeGallery(patch) {
    setState((current) => ({
      ...current,
      galleries: {
        ...current.galleries,
        [shoot.id]: { ...current.galleries[shoot.id], ...patch },
      },
    }));
  }
  function changeExport(patch) {
    changeGallery({ export: { ...gallery.export, ...patch }, zipReady: false });
  }
  function selectShoot(id) {
    setShootId(id);
    setSelected([]);
    setTab("All");
  }

  function changePhotos(ids, patch) {
    setState((current) => {
      const next = current.photos.map((photo) =>
        ids.includes(photo.id) ? { ...photo, ...patch } : photo,
      );
      const allowed = next
        .filter(
          (photo) =>
            photo.shootId === shoot.id && photo.selected && !photo.rejected,
        )
        .map((photo) => photo.id);
      const previous = current.galleries[shoot.id];
      return {
        ...current,
        photos: next,
        galleries: previous
          ? {
              ...current.galleries,
              [shoot.id]: {
                ...previous,
                clientSelected: previous.clientSelected.filter((id) =>
                  allowed.includes(id),
                ),
                submitted:
                  previous.clientSelected.every((id) => allowed.includes(id)) &&
                  previous.submitted,
                approved: false,
                zipReady: false,
              },
            }
          : current.galleries,
      };
    });
  }

  function openEditor(
    items = chosen.length ? chosen : photos.filter((photo) => !photo.rejected),
  ) {
    if (items.length) onOpenEditor?.({ photos: items, shoot });
  }

  function createGallery() {
    if (!proofs.length) {
      say("Select at least one photo for your proof gallery.");
      return;
    }
    setState((current) => ({
      ...current,
      shoots: current.shoots.map((item) =>
        item.id === shoot.id ? { ...item, status: "Proofing" } : item,
      ),
      galleries: {
        ...current.galleries,
        [shoot.id]: createProofGallery(shoot.id),
      },
    }));
    setSection("galleries");
    say("Proof gallery created. Downloads are off and your watermark is on.");
  }

  function previewGallery() {
    onPreviewGallery?.({
      photos: gallery?.delivered ? clientPhotos : proofs,
      shoot,
      brand,
      gallery: { ...gallery, expired, delivered: !!gallery?.delivered },
    });
  }

  function createShoot(event) {
    event.preventDefault();
    if (!draft.name.trim() || !draft.client.trim() || !draft.date) return;
    const id = `shoot-${Date.now()}`;
    setState((current) => ({
      ...current,
      shoots: [
        {
          ...draft,
          name: draft.name.trim(),
          client: draft.client.trim(),
          id,
          status: "Imported",
          cover: "/media/portrait.png",
        },
        ...current.shoots,
      ],
    }));
    selectShoot(id);
    setDetail(true);
    setSection("shoots");
    setDialog(null);
    setDraft({
      name: "",
      client: "",
      type: "Family portrait",
      date: new Date().toISOString().slice(0, 10),
    });
    say("Shoot created. Add a sample set to try the culling workflow.");
  }

  function importSamples() {
    const imported = demoPhotos.slice(0, 6).map((photo, index) => ({
      ...photo,
      id: `${shoot.id}-${Date.now()}-${index}`,
      shootId: shoot.id,
      selected: false,
      rejected: false,
      edited: false,
      deliverable: false,
      rating: 0,
    }));
    setState((current) => ({
      ...current,
      photos: [...current.photos, ...imported],
    }));
    say("Six sample RAW previews added. Your originals stay untouched.");
  }

  function chooseClientPhoto(id) {
    const allowed = proofs.map((photo) => photo.id);
    const next = toggleClientSelection({ ...gallery, expired }, id, allowed);
    if (
      next.clientSelected === gallery.clientSelected &&
      !gallery.clientSelected.includes(id)
    )
      say(`Choose up to ${gallery.selectionLimit} photos.`);
    changeGallery(next);
  }

  function uploadLogo(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 512_000
    ) {
      setLogoError("Choose a PNG, JPEG or WebP smaller than 500 KB.");
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      changeBrand({ logoImage: String(reader.result) });
      setLogoError("");
      say("Logo added to your local brand preview.");
    };
    reader.onerror = () =>
      setLogoError("That image could not be read. Try another file.");
    reader.readAsDataURL(file);
  }

  function movePortfolio(id, direction) {
    const order = [...website.order];
    const index = order.indexOf(id);
    const next = index + direction;
    if (next < 0 || next >= order.length) return;
    [order[index], order[next]] = [order[next], order[index]];
    changeWebsite({ order });
  }

  function prepareZip() {
    if (!gallery.approved || !clientPhotos.length) return;
    changeGallery({ zipReady: true });
    say(
      `${clientPhotos.length} ${gallery.export.format} files prepared in the ZIP preview. No files were downloaded.`,
    );
  }

  function deliverFinals() {
    if (!gallery.approved || !gallery.zipReady || !clientPhotos.length) return;
    const ids = clientPhotos.map((photo) => photo.id);
    setState((current) => ({
      ...current,
      photos: current.photos.map((photo) =>
        ids.includes(photo.id) ? { ...photo, deliverable: true } : photo,
      ),
      shoots: current.shoots.map((item) =>
        item.id === shoot.id ? { ...item, status: "Delivered" } : item,
      ),
      galleries: {
        ...current.galleries,
        [shoot.id]: {
          ...current.galleries[shoot.id],
          delivered: true,
          downloadAllowed: true,
          watermark: gallery.export.watermark,
        },
      },
    }));
    say("Final gallery delivered in the preview. Client downloads are now on.");
  }

  const title =
    section === "shoots" && detail
      ? shoot.name
      : sections.find(([id]) => id === section)[1];
  const subtitle =
    section === "shoots"
      ? detail
        ? `${shoot.client} · ${shoot.type} · ${dateLabel(shoot.date)}`
        : "From the first frame to the final delivery."
      : section === "galleries"
        ? "A thoughtful handoff, with your clients in the loop."
        : section === "website"
          ? "Your work, in your own space."
          : section === "branding"
            ? "Keep every gallery and delivery recognisably yours."
            : "Publish when you are ready. Keep working anywhere.";
  const listing = state.shoots
    .filter((item) =>
      `${item.name} ${item.client} ${item.type}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : b.date.localeCompare(a.date),
    );

  return (
    <div className="phw" data-section={section}>
      <aside className="phw-rail">
        <button className="phw-return" onClick={onBack}>
          <Icon name="mdiArrowLeft" />
          <span>Back to library</span>
        </button>
        <div className="phw-studio-brand">
          <span className="phw-brand-mark">
            {brand.logoImage ? (
              <img src={brand.logoImage} alt="" />
            ) : (
              brand.logo || "CL"
            )}
          </span>
          <div>
            <strong>{brand.name}</strong>
            <small>Photography workspace</small>
          </div>
        </div>
        <nav aria-label="Photography workspace">
          {sections.map(([id, label, icon]) => (
            <button
              key={id}
              aria-current={section === id ? "page" : undefined}
              onClick={() => {
                setSection(id);
                setMessage("");
              }}
            >
              <Icon name={icon} />
              <span>{label}</span>
              {id === "galleries" && (
                <small>{Object.keys(state.galleries).length}</small>
              )}
            </button>
          ))}
        </nav>
        <div className="phw-rail-bottom">
          <Icon name="mdiShieldCheckOutline" />
          <p>
            Your originals stay local.
            <small>
              Shoots, editing and galleries are yours on every plan.
            </small>
          </p>
          <button onClick={onOpenRaw}>
            RAW compatibility <Icon name="mdiChevronRight" size={14} />
          </button>
        </div>
      </aside>
      <div className="phw-workspace">
        <header className="phw-header">
          <div>
            <span className="phw-breadcrumb">
              Photography <span className="phw-prototype">Prototype</span>
            </span>
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
          <div className="phw-header-actions">
            <span className="phw-save">
              <Icon
                name={
                  saving ? "mdiCheckCircleOutline" : "mdiInformationOutline"
                }
                size={14}
              />
              {saving ? "Saved on this device" : "Session only"}
            </span>
            {section === "shoots" && (
              <Button
                icon="mdiPlus"
                primary
                onClick={() => setDialog("new-shoot")}
              >
                New shoot
              </Button>
            )}
            {section === "galleries" && gallery && (
              <Button icon="mdiEyeOutline" primary onClick={previewGallery}>
                Client preview
              </Button>
            )}
            {section === "website" && (
              <Button
                icon="mdiEyeOutline"
                primary
                disabled={!portfolio.length}
                onClick={() =>
                  onPreviewWebsite?.({
                    photos: [
                      cover,
                      ...portfolio.filter((photo) => photo.id !== cover?.id),
                    ].filter(Boolean),
                    brand: {
                      ...brand,
                      about: website.about,
                      contact: website.contact,
                    },
                    layout: website.layout,
                  })
                }
              >
                Preview website
              </Button>
            )}
          </div>
        </header>
        {message && (
          <div className="phw-notice" role="status">
            <Icon name="mdiCheckCircleOutline" size={16} />
            <span>{message}</span>
            <button aria-label="Dismiss message" onClick={() => setMessage("")}>
              <Icon name="mdiClose" size={16} />
            </button>
          </div>
        )}
        <main className="phw-scroll">
          {section === "shoots" && !detail && (
            <>
              <div className="phw-list-tools">
                <label className="phw-search">
                  <Icon name="mdiMagnify" />
                  <input
                    aria-label="Search shoots"
                    placeholder="Search shoots or clients"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <select
                  aria-label="Sort shoots"
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                >
                  <option value="date">Newest first</option>
                  <option value="name">Shoot name</option>
                </select>
                <span>{listing.length} shoots</span>
              </div>
              <div className="phw-shoot-grid">
                {listing.map((item) => (
                  <button
                    className="phw-shoot-card"
                    key={item.id}
                    onClick={() => {
                      selectShoot(item.id);
                      setDetail(true);
                    }}
                  >
                    <div className="phw-shoot-image">
                      <img src={item.cover} alt={item.name} />
                      <span className="phw-status">{item.status}</span>
                    </div>
                    <div className="phw-shoot-text">
                      <strong>{item.name}</strong>
                      <span>{item.client}</span>
                      <footer>
                        <time>{dateLabel(item.date)}</time>
                        <span>
                          {photosForShoot(state, item.id).length} photos{" "}
                          <Icon name="mdiChevronRight" size={14} />
                        </span>
                      </footer>
                    </div>
                  </button>
                ))}
              </div>
              {!listing.length && (
                <div className="phw-empty">
                  <Icon name="mdiFolderSearchOutline" size={36} />
                  <h2>No shoots match that search</h2>
                  <p>Try a client name, or start a new shoot.</p>
                  <Button onClick={() => setSearch("")}>Clear search</Button>
                </div>
              )}
              <div className="phw-list-footer">
                <Icon name="mdiHarddisk" size={18} />
                <span>One place to cull, edit, proof and deliver.</span>
                <span className="muted">Fictional sample studio</span>
              </div>
            </>
          )}

          {section === "shoots" && detail && (
            <>
              <div className="phw-shoot-top">
                <Button
                  icon="mdiArrowLeft"
                  onClick={() => {
                    setDetail(false);
                    setSelected([]);
                  }}
                >
                  All shoots
                </Button>
                <div className="phw-stages" aria-label="Shoot workflow">
                  {shootStages.map((stage, index) => (
                    <span
                      key={stage}
                      className={
                        index <= shootStages.indexOf(shoot.status) ? "done" : ""
                      }
                    >
                      <i>
                        {index < shootStages.indexOf(shoot.status) ? (
                          <Icon name="mdiCheck" size={12} />
                        ) : (
                          index + 1
                        )}
                      </i>
                      {stage}
                    </span>
                  ))}
                </div>
              </div>
              <div className="phw-detail-layout">
                <section className="phw-contact-sheet">
                  <div className="phw-contact-toolbar">
                    <div className="phw-tabs" aria-label="Photo filter">
                      {photoTabs.map((name) => (
                        <button
                          key={name}
                          aria-pressed={tab === name}
                          onClick={() => {
                            setTab(name);
                            setSelected([]);
                          }}
                        >
                          {name}
                          <small>
                            {
                              photos.filter(
                                (photo) =>
                                  name === "All" ||
                                  (name === "Selected" &&
                                    photo.selected &&
                                    !photo.rejected) ||
                                  (name === "Edited" &&
                                    photo.edited &&
                                    !photo.rejected) ||
                                  (name === "Deliverables" &&
                                    photo.deliverable &&
                                    !photo.rejected),
                              ).length
                            }
                          </small>
                        </button>
                      ))}
                    </div>
                    <Button icon="mdiImport" onClick={importSamples}>
                      Add sample set
                    </Button>
                  </div>
                  <div className="phw-selection-tools">
                    <label>
                      <input
                        type="checkbox"
                        aria-label="Select all visible photos"
                        checked={
                          !!visible.length &&
                          visible.every((photo) => selected.includes(photo.id))
                        }
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? visible.map((photo) => photo.id)
                              : [],
                          )
                        }
                      />
                      {selected.length
                        ? `${selected.length} selected`
                        : "Select photos"}
                    </label>
                    {selected.length > 0 && (
                      <>
                        <Button
                          icon="mdiCheck"
                          onClick={() =>
                            changePhotos(selected, {
                              selected: true,
                              rejected: false,
                            })
                          }
                        >
                          Keep
                        </Button>
                        <Button
                          icon="mdiClose"
                          onClick={() =>
                            changePhotos(selected, {
                              rejected: true,
                              selected: false,
                              deliverable: false,
                            })
                          }
                        >
                          Reject
                        </Button>
                        <Button
                          icon="mdiImageEditOutline"
                          onClick={() => {
                            changePhotos(selected, { edited: true });
                            changeShoot({ status: "Edited" });
                            say("Selected previews marked as edited.");
                          }}
                        >
                          Mark edited
                        </Button>
                      </>
                    )}
                  </div>
                  <div className="phw-photo-grid">
                    {visible.map((photo) => (
                      <article
                        className={`phw-photo ${selected.includes(photo.id) ? "is-selected" : ""} ${photo.rejected ? "is-rejected" : ""}`}
                        key={photo.id}
                      >
                        <div className="phw-photo-image">
                          <button
                            className="phw-open-photo"
                            aria-label={`Open ${photo.name} in RAW editor`}
                            onClick={() => openEditor([photo])}
                          >
                            <img
                              src={photo.image}
                              alt={photo.name}
                              loading="lazy"
                              style={{
                                filter: editSessions[photo.shootId]?.records[
                                  photo.id
                                ]
                                  ? previewFor(
                                      editSessions[photo.shootId].records[
                                        photo.id
                                      ].history.present,
                                    ).filter
                                  : undefined,
                              }}
                            />
                          </button>
                          <input
                            className="phw-photo-select"
                            type="checkbox"
                            aria-label={`Select ${photo.name}`}
                            checked={selected.includes(photo.id)}
                            onChange={(event) =>
                              setSelected(
                                event.target.checked
                                  ? [...selected, photo.id]
                                  : selected.filter((id) => id !== photo.id),
                              )
                            }
                          />
                          <span className="phw-raw">
                            RAW <span>{photo.extension}</span>
                          </span>
                          {photo.edited && (
                            <span className="phw-edited" title="Edited preview">
                              <Icon name="mdiTune" size={13} />
                            </span>
                          )}
                        </div>
                        <div className="phw-photo-meta">
                          <span title={photo.name}>{photo.fileName}</span>
                          <div
                            className="phw-stars"
                            aria-label={`Rating for ${photo.name}`}
                          >
                            <select
                              className="phw-rating-select"
                              aria-label={`Rating for ${photo.name}`}
                              value={photo.rating}
                              onChange={(event) =>
                                changePhotos([photo.id], {
                                  rating: Number(event.target.value),
                                  selected: Number(event.target.value) >= 4,
                                  rejected: false,
                                })
                              }
                            >
                              <option value="0">Unrated</option>
                              {[1, 2, 3, 4, 5].map((rating) => (
                                <option key={rating} value={rating}>
                                  {rating} {rating === 1 ? "star" : "stars"}
                                </option>
                              ))}
                            </select>
                            {[1, 2, 3, 4, 5].map((rating) => (
                              <button
                                key={rating}
                                aria-label={`${rating} star rating for ${photo.name}`}
                                aria-pressed={photo.rating === rating}
                                onClick={() =>
                                  changePhotos([photo.id], {
                                    rating:
                                      photo.rating === rating ? 0 : rating,
                                    selected:
                                      rating >= 4 && photo.rating !== rating,
                                    rejected: false,
                                  })
                                }
                              >
                                <Icon
                                  name={
                                    photo.rating >= rating
                                      ? "mdiStar"
                                      : "mdiStarOutline"
                                  }
                                  size={14}
                                />
                              </button>
                            ))}
                            <button
                              className="phw-reject"
                              aria-label={`${photo.rejected ? "Restore" : "Reject"} ${photo.name}`}
                              aria-pressed={photo.rejected}
                              onClick={() =>
                                changePhotos([photo.id], {
                                  rejected: !photo.rejected,
                                  selected: false,
                                  deliverable: false,
                                })
                              }
                            >
                              <Icon
                                name={photo.rejected ? "mdiUndo" : "mdiClose"}
                                size={14}
                              />
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                  {!visible.length && (
                    <div className="phw-empty">
                      <Icon name="mdiCameraOutline" size={36} />
                      <h2>
                        {photos.length
                          ? `No ${tab.toLowerCase()} photos yet`
                          : "Your new shoot is ready"}
                      </h2>
                      <p>
                        {photos.length
                          ? "Keep your favourites, then continue into the editor."
                          : "Add a sample set to try culling and delivery."}
                      </p>
                      <Button
                        onClick={
                          photos.length ? () => setTab("All") : importSamples
                        }
                      >
                        {photos.length ? "Show all photos" : "Add sample set"}
                      </Button>
                    </div>
                  )}
                </section>
                <aside className="phw-inspector">
                  <div className="phw-inspector-cover">
                    <img
                      src={
                        photos.find((photo) => selected.includes(photo.id))
                          ?.image || shoot.cover
                      }
                      alt={shoot.name}
                    />
                  </div>
                  <div className="phw-inspector-body">
                    <h2>Shoot details</h2>
                    <Field label="Shoot name">
                      <input
                        value={shoot.name}
                        onChange={(event) =>
                          changeShoot({ name: event.target.value })
                        }
                      />
                    </Field>
                    <Field label="Client">
                      <input
                        value={shoot.client}
                        onChange={(event) =>
                          changeShoot({ client: event.target.value })
                        }
                      />
                    </Field>
                    <Field label="Stage">
                      <select
                        value={shoot.status}
                        onChange={(event) =>
                          changeShoot({ status: event.target.value })
                        }
                      >
                        {shootStages.map((stage) => (
                          <option key={stage}>{stage}</option>
                        ))}
                      </select>
                    </Field>
                    <dl className="phw-stats">
                      <div>
                        <dt>Originals</dt>
                        <dd>{photos.length} RAW</dd>
                      </div>
                      <div>
                        <dt>Kept for proofing</dt>
                        <dd>{proofs.length}</dd>
                      </div>
                      <div>
                        <dt>Edited</dt>
                        <dd>
                          {
                            photos.filter(
                              (photo) => photo.edited && !photo.rejected,
                            ).length
                          }
                        </dd>
                      </div>
                      <div>
                        <dt>Rejected</dt>
                        <dd>
                          {photos.filter((photo) => photo.rejected).length}
                        </dd>
                      </div>
                    </dl>
                    <Button
                      primary
                      icon="mdiTune"
                      disabled={!photos.length}
                      onClick={() => openEditor()}
                    >
                      Open in RAW editor
                      {chosen.length ? ` (${chosen.length})` : ""}
                    </Button>
                    <Button
                      icon="mdiImageMultipleOutline"
                      disabled={!proofs.length}
                      onClick={
                        gallery ? () => setSection("galleries") : createGallery
                      }
                    >
                      {gallery ? "Open proof gallery" : "Create proof gallery"}
                    </Button>
                    {selected.length > 0 && (
                      <Button
                        icon="mdiCheckAll"
                        onClick={() => {
                          changePhotos(selected, {
                            deliverable: true,
                            edited: true,
                            selected: true,
                            rejected: false,
                          });
                          say("Selected previews added to deliverables.");
                        }}
                      >
                        Add to deliverables
                      </Button>
                    )}
                    <p className="phw-small">
                      Star your favourites, reject the rest. Original RAW files
                      stay untouched.
                    </p>
                  </div>
                </aside>
              </div>
            </>
          )}

          {section === "galleries" && (
            <>
              <div className="phw-list-tools">
                <Field label="Shoot">
                  <select
                    value={shoot.id}
                    onChange={(event) => selectShoot(event.target.value)}
                  >
                    {state.shoots.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <span>
                  {gallery ? `${proofs.length} proof photos` : "No gallery yet"}
                </span>
                {gallery && (
                  <span className={`phw-status ${expired ? "is-expired" : ""}`}>
                    {expired
                      ? "Expired"
                      : gallery.delivered
                        ? "Delivered"
                        : gallery.submitted
                          ? "Selection submitted"
                          : "Proofing"}
                  </span>
                )}
              </div>
              {!gallery ? (
                <div className="phw-empty">
                  <img src={shoot.cover} alt={shoot.name} />
                  <h2>A gallery for {shoot.client}</h2>
                  <p>
                    {proofs.length
                      ? `${proofs.length} selected photos are ready to share for proofing.`
                      : "Select photos in your shoot first, then create a proof gallery."}
                  </p>
                  <Button
                    primary
                    onClick={
                      proofs.length
                        ? createGallery
                        : () => {
                            setDetail(true);
                            setSection("shoots");
                          }
                    }
                  >
                    {proofs.length
                      ? "Create proof gallery"
                      : "Choose proof photos"}
                  </Button>
                </div>
              ) : (
                <div className="phw-detail-layout">
                  <section className="phw-gallery-main">
                    <div className="phw-gallery-cover">
                      <img src={shoot.cover} alt={shoot.name} />
                      <div className="phw-gallery-cover-text">
                        <span>{brand.name}</span>
                        <h2>{shoot.name}</h2>
                        <p>
                          {gallery.delivered
                            ? "Your final photographs"
                            : "A first look, just for you."}
                        </p>
                      </div>
                      <Watermark
                        brand={brand}
                        enabled={gallery.watermark && !gallery.delivered}
                      />
                    </div>
                    <div className="phw-gallery-summary">
                      <span>
                        <Icon name="mdiLockOutline" size={16} />
                        {gallery.password
                          ? "Password protected"
                          : "Anyone with the preview link"}
                      </span>
                      <span>
                        <Icon name="mdiDownloadOutline" size={16} />
                        Downloads {gallery.downloadAllowed ? "on" : "off"}
                      </span>
                      <span>
                        <Icon name="mdiShieldCheckOutline" size={16} />
                        Watermark {gallery.watermark ? "on" : "off"}
                      </span>
                    </div>
                    <div className="phw-section-heading">
                      <div>
                        <h2>Client selections</h2>
                        <p>
                          {clientPhotos.length} of {gallery.selectionLimit}{" "}
                          selected
                          {gallery.submitted ? " · submitted for approval" : ""}
                        </p>
                      </div>
                      <Button
                        icon="mdiAccountOutline"
                        disabled={expired}
                        onClick={() => {
                          setDialog("client");
                          setCommentPhoto(proofs[0]?.id || "");
                        }}
                      >
                        Try as client
                      </Button>
                    </div>
                    <div className="phw-client-picks">
                      {(clientPhotos.length
                        ? clientPhotos
                        : proofs.slice(0, 3)
                      ).map((photo) => (
                        <figure key={photo.id}>
                          <img src={photo.image} alt={photo.name} />
                          <figcaption>
                            {clientPhotos.length ? (
                              <Icon name="mdiHeart" size={14} />
                            ) : (
                              <Icon name="mdiHeartOutline" size={14} />
                            )}
                            {photo.name}
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                    <div className="phw-section-heading">
                      <h2>Conversation</h2>
                      <span>{gallery.comments.length} comments</span>
                    </div>
                    <div className="phw-comments">
                      {gallery.comments.map((item) => (
                        <div key={item.id}>
                          <span className="phw-comment-avatar">
                            {item.author.slice(0, 1)}
                          </span>
                          <div>
                            <strong>
                              {item.author}
                              <small>
                                {
                                  state.photos.find(
                                    (photo) => photo.id === item.photoId,
                                  )?.name
                                }
                              </small>
                            </strong>
                            <p>{item.text}</p>
                          </div>
                        </div>
                      ))}
                      {!gallery.comments.length && (
                        <p className="phw-small">
                          Your client's notes will appear here. Try the client
                          view to leave a sample comment.
                        </p>
                      )}
                    </div>
                    <div className="phw-delivery">
                      <div className="phw-section-heading">
                        <div>
                          <h2>Final delivery</h2>
                          <p>
                            {gallery.approved
                              ? "Selection approved. Your export choices are ready."
                              : "Review the client's submitted selection before preparing the finals."}
                          </p>
                        </div>
                        <Button
                          disabled={
                            !gallery.submitted ||
                            !clientPhotos.length ||
                            gallery.approved
                          }
                          icon="mdiCheckCircleOutline"
                          onClick={() => {
                            changeGallery({ approved: true });
                            say(
                              "Client selection approved for final delivery.",
                            );
                          }}
                        >
                          {gallery.approved ? "Approved" : "Approve selection"}
                        </Button>
                      </div>
                      <div className="phw-export-fields">
                        <Field label="Format">
                          <select
                            value={gallery.export.format}
                            onChange={(event) =>
                              changeExport({ format: event.target.value })
                            }
                          >
                            <option>JPEG</option>
                            <option>TIFF</option>
                            <option>PNG</option>
                          </select>
                        </Field>
                        <Field label="Long edge">
                          <select
                            value={gallery.export.longEdge}
                            onChange={(event) =>
                              changeExport({ longEdge: event.target.value })
                            }
                          >
                            <option value="2048">2048 px · web</option>
                            <option value="3840">3840 px · large</option>
                            <option value="original">Original size</option>
                          </select>
                        </Field>
                        <Field label="Colour space">
                          <select
                            value={gallery.export.colorSpace}
                            onChange={(event) =>
                              changeExport({ colorSpace: event.target.value })
                            }
                          >
                            <option>sRGB</option>
                            <option>Adobe RGB</option>
                          </select>
                        </Field>
                        <Field label={`Quality · ${gallery.export.quality}%`}>
                          <input
                            type="range"
                            min="60"
                            max="100"
                            value={gallery.export.quality}
                            disabled={gallery.export.format !== "JPEG"}
                            onChange={(event) =>
                              changeExport({
                                quality: Number(event.target.value),
                              })
                            }
                          />
                        </Field>
                      </div>
                      <Toggle
                        label="Include watermark in final files"
                        checked={gallery.export.watermark}
                        onChange={(value) => changeExport({ watermark: value })}
                      />
                      <div className="phw-delivery-actions">
                        <Button
                          icon="mdiPackageVariant"
                          primary
                          disabled={!gallery.approved || !clientPhotos.length}
                          onClick={prepareZip}
                        >
                          {gallery.zipReady
                            ? "ZIP preview ready"
                            : "Prepare ZIP preview"}
                        </Button>
                        <Button
                          icon="mdiCheckAll"
                          disabled={!gallery.zipReady || gallery.delivered}
                          onClick={deliverFinals}
                        >
                          Deliver finals
                        </Button>
                      </div>
                      <p className="phw-small">
                        Export settings and ZIP delivery are a preview. No files
                        are downloaded.
                      </p>
                    </div>
                  </section>
                  <aside className="phw-inspector">
                    <div className="phw-inspector-body">
                      <h2>Gallery settings</h2>
                      <Field label="Invite client">
                        <input
                          type="email"
                          value={gallery.invite}
                          onChange={(event) =>
                            changeGallery({
                              invite: event.target.value,
                              invited: false,
                            })
                          }
                        />
                      </Field>
                      <Button
                        icon="mdiEmailOutline"
                        disabled={
                          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gallery.invite) ||
                          expired
                        }
                        onClick={() => {
                          changeGallery({ invited: true });
                          say(
                            "Client invitation prepared in the preview. No email was sent.",
                          );
                        }}
                      >
                        {gallery.invited
                          ? "Invitation prepared"
                          : "Prepare invitation"}
                      </Button>
                      <Field
                        label="Gallery password"
                        hint="Used in the local client preview."
                      >
                        <input
                          type="text"
                          autoComplete="off"
                          value={gallery.password}
                          onChange={(event) =>
                            changeGallery({ password: event.target.value })
                          }
                        />
                      </Field>
                      <Field label="Expires">
                        <input
                          type="date"
                          value={gallery.expires}
                          onChange={(event) =>
                            changeGallery({ expires: event.target.value })
                          }
                        />
                      </Field>
                      <Field label="Selection limit">
                        <input
                          type="number"
                          min="1"
                          max="50"
                          value={gallery.selectionLimit}
                          onChange={(event) =>
                            changeGallery({
                              selectionLimit: Math.max(
                                1,
                                Math.min(50, Number(event.target.value) || 1),
                              ),
                              submitted: false,
                              approved: false,
                              zipReady: false,
                              clientSelected: gallery.clientSelected.slice(
                                0,
                                Math.max(
                                  1,
                                  Math.min(50, Number(event.target.value) || 1),
                                ),
                              ),
                            })
                          }
                        />
                      </Field>
                      <Toggle
                        label="Allow downloads"
                        checked={gallery.downloadAllowed}
                        onChange={(value) =>
                          changeGallery({ downloadAllowed: value })
                        }
                        hint="Off by default for proofing."
                      />
                      <Toggle
                        label="Show watermark"
                        checked={gallery.watermark}
                        onChange={(value) =>
                          changeGallery({ watermark: value })
                        }
                        hint="On by default for proofing."
                      />
                      <Toggle
                        label="Preview expired link"
                        checked={gallery.expired}
                        onChange={(value) => changeGallery({ expired: value })}
                      />
                      <Button icon="mdiEyeOutline" onClick={previewGallery}>
                        Open client preview
                      </Button>
                      <Button
                        icon="mdiCameraOutline"
                        onClick={() => {
                          setSection("shoots");
                          setDetail(true);
                        }}
                      >
                        Edit proof selection
                      </Button>
                      <p className="phw-small">
                        Only selected, kept photos enter a proof gallery.
                        Originals are never shared by these previews.
                      </p>
                    </div>
                  </aside>
                </div>
              )}
            </>
          )}

          {section === "website" && (
            <div className="phw-detail-layout">
              <section className="phw-website-main">
                <div
                  className={`phw-site-preview is-${website.layout} font-${brand.font}`}
                  style={{
                    background: brand.background,
                    color: brand.textColor,
                    "--phw-brand-color": brand.color,
                  }}
                >
                  <header>
                    <strong>
                      {brand.logoImage ? (
                        <img src={brand.logoImage} alt={brand.name} />
                      ) : (
                        brand.name
                      )}
                    </strong>
                    <span>
                      Work <span>About</span> Contact
                    </span>
                  </header>
                  <div className="phw-site-cover">
                    <img
                      src={cover?.image || "/media/portrait.png"}
                      alt={cover?.name || "Portfolio cover"}
                    />
                    <div>
                      <h2>{brand.tagline}</h2>
                      <span>{brand.name}</span>
                    </div>
                  </div>
                  <div className="phw-site-strip">
                    {portfolio.slice(1, 4).map((photo) => (
                      <img key={photo.id} src={photo.image} alt={photo.name} />
                    ))}
                  </div>
                  <div className="phw-site-about">
                    <h3>About</h3>
                    <p>{website.about}</p>
                    <h3>Let's make something together.</h3>
                    <p>{website.contact}</p>
                    <span>{brand.email}</span>
                  </div>
                </div>
                <div className="phw-section-heading">
                  <div>
                    <h2>Portfolio order</h2>
                    <p>Choose the first impression, then arrange the story.</p>
                  </div>
                  <span>{portfolio.length} photos</span>
                </div>
                <div className="phw-portfolio-order">
                  {portfolio.map((photo, index) => (
                    <div key={photo.id}>
                      <img src={photo.image} alt={photo.name} />
                      <span>
                        <strong>{photo.name}</strong>
                        <small>
                          {photo.id === website.coverId
                            ? "Cover photo"
                            : `Position ${index + 1}`}
                        </small>
                      </span>
                      <Button
                        icon="mdiImageOutline"
                        aria-label={`Use ${photo.name} as cover`}
                        active={photo.id === website.coverId}
                        onClick={() => changeWebsite({ coverId: photo.id })}
                      />
                      <Button
                        icon="mdiArrowUp"
                        aria-label={`Move ${photo.name} earlier`}
                        disabled={index === 0}
                        onClick={() => movePortfolio(photo.id, -1)}
                      />
                      <Button
                        icon="mdiArrowDown"
                        aria-label={`Move ${photo.name} later`}
                        disabled={index === portfolio.length - 1}
                        onClick={() => movePortfolio(photo.id, 1)}
                      />
                      <Button
                        icon="mdiClose"
                        aria-label={`Remove ${photo.name} from portfolio`}
                        onClick={() =>
                          changeWebsite({
                            order: website.order.filter(
                              (id) => id !== photo.id,
                            ),
                            coverId:
                              website.coverId === photo.id
                                ? portfolio.find((item) => item.id !== photo.id)
                                    ?.id || ""
                                : website.coverId,
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
                <Button icon="mdiPlus" onClick={() => setDialog("portfolio")}>
                  Add portfolio photos
                </Button>
              </section>
              <aside className="phw-inspector">
                <div className="phw-inspector-body">
                  <h2>Website settings</h2>
                  <Field label="Layout">
                    <select
                      value={website.layout}
                      onChange={(event) =>
                        changeWebsite({ layout: event.target.value })
                      }
                    >
                      <option value="editorial">Editorial</option>
                      <option value="grid">Gallery grid</option>
                      <option value="slideshow">Full-screen slideshow</option>
                    </select>
                  </Field>
                  <Field label="Typography">
                    <select
                      value={brand.font}
                      onChange={(event) =>
                        changeBrand({ font: event.target.value })
                      }
                    >
                      <option value="editorial">Editorial serif</option>
                      <option value="modern">Modern sans</option>
                      <option value="classic">Classic serif</option>
                    </select>
                  </Field>
                  <Field label="Accent colour">
                    <input
                      type="color"
                      value={brand.color}
                      onChange={(event) =>
                        changeBrand({ color: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Page colour">
                    <input
                      type="color"
                      value={brand.background}
                      onChange={(event) =>
                        changeBrand({ background: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Text colour">
                    <input
                      type="color"
                      value={brand.textColor}
                      onChange={(event) =>
                        changeBrand({ textColor: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="About">
                    <textarea
                      value={website.about}
                      onChange={(event) =>
                        changeWebsite({ about: event.target.value })
                      }
                      rows="5"
                    />
                  </Field>
                  <Field label="Contact introduction">
                    <textarea
                      value={website.contact}
                      onChange={(event) =>
                        changeWebsite({ contact: event.target.value })
                      }
                    />
                  </Field>
                  <Button
                    icon="mdiPaletteOutline"
                    onClick={() => setSection("branding")}
                  >
                    Edit studio brand
                  </Button>
                  <Button
                    primary
                    icon="mdiCloudUploadOutline"
                    onClick={() => setSection("publishing")}
                  >
                    Publishing options
                  </Button>
                </div>
              </aside>
            </div>
          )}

          {section === "branding" && (
            <div className="phw-detail-layout">
              <section className="phw-brand-main">
                <div className="phw-brand-preview">
                  <span className="phw-brand-mark large">
                    {brand.logoImage ? (
                      <img src={brand.logoImage} alt={brand.name} />
                    ) : (
                      brand.logo
                    )}
                  </span>
                  <h2>{brand.name}</h2>
                  <p>{brand.tagline}</p>
                  <span>{brand.email}</span>
                </div>
                <div className="phw-section-heading">
                  <div>
                    <h2>Your watermark</h2>
                    <p>A consistent signature, on every proof.</p>
                  </div>
                  <span>{brand.watermarkOpacity}% opacity</span>
                </div>
                <div className="phw-watermark-preview">
                  <img
                    src={cover?.image || "/media/portrait.png"}
                    alt="Watermarked sample photograph"
                  />
                  <Watermark brand={brand} />
                </div>
                <p className="phw-small">
                  This overlay shows placement and opacity. Your original
                  photographs stay unchanged.
                </p>
                <div className="phw-brand-swatches">
                  <span style={{ background: brand.color }} />
                  <span style={{ background: brand.background }} />
                  <span style={{ background: brand.textColor }} />
                  <p>Shared across your portfolio and client galleries.</p>
                </div>
              </section>
              <aside className="phw-inspector">
                <div className="phw-inspector-body">
                  <h2>Studio identity</h2>
                  <Field label="Studio name">
                    <input
                      value={brand.name}
                      onChange={(event) =>
                        changeBrand({ name: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Tagline">
                    <input
                      value={brand.tagline}
                      onChange={(event) =>
                        changeBrand({ tagline: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Email">
                    <input
                      type="email"
                      value={brand.email}
                      onChange={(event) =>
                        changeBrand({ email: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Phone">
                    <input
                      type="tel"
                      value={brand.phone}
                      onChange={(event) =>
                        changeBrand({ phone: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Logo initials">
                    <input
                      value={brand.logo}
                      maxLength="12"
                      onChange={(event) =>
                        changeBrand({ logo: event.target.value })
                      }
                    />
                  </Field>
                  <Field
                    label="Custom logo"
                    hint="PNG, JPEG or WebP · up to 500 KB"
                  >
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={uploadLogo}
                    />
                  </Field>
                  {logoError && (
                    <p className="phw-error" role="alert">
                      {logoError}
                    </p>
                  )}
                  {brand.logoImage && (
                    <Button
                      icon="mdiClose"
                      onClick={() => changeBrand({ logoImage: "" })}
                    >
                      Use initials instead
                    </Button>
                  )}
                  <div className="phw-divider" />
                  <h2>Watermark</h2>
                  <Field label="Colour">
                    <input
                      type="color"
                      value={brand.watermarkColor}
                      onChange={(event) =>
                        changeBrand({ watermarkColor: event.target.value })
                      }
                    />
                  </Field>
                  <Field label={`Opacity · ${brand.watermarkOpacity}%`}>
                    <input
                      type="range"
                      min="10"
                      max="100"
                      value={brand.watermarkOpacity}
                      onChange={(event) =>
                        changeBrand({
                          watermarkOpacity: Number(event.target.value),
                        })
                      }
                    />
                  </Field>
                  <Field label="Placement">
                    <select
                      value={brand.watermarkPosition}
                      onChange={(event) =>
                        changeBrand({ watermarkPosition: event.target.value })
                      }
                    >
                      <option value="bottom-right">Bottom right</option>
                      <option value="bottom-left">Bottom left</option>
                      <option value="center">Centre</option>
                      <option value="top-right">Top right</option>
                    </select>
                  </Field>
                  <Field label={`Size · ${brand.watermarkSize}%`}>
                    <input
                      type="range"
                      min="3"
                      max="12"
                      value={brand.watermarkSize}
                      onChange={(event) =>
                        changeBrand({
                          watermarkSize: Number(event.target.value),
                        })
                      }
                    />
                  </Field>
                </div>
              </aside>
            </div>
          )}

          {section === "publishing" && (
            <div className="phw-publishing">
              <div className="phw-publish-paths">
                <button
                  aria-pressed={publishing.mode === "self-hosted"}
                  onClick={() => changePublishing({ mode: "self-hosted" })}
                >
                  <Icon name="mdiServerOutline" size={26} />
                  <strong>Self-hosted</strong>
                  <span>
                    Your server, your photographs.
                    <br />
                    Publish galleries and your portfolio.
                  </span>
                  <small>Local features included · hosting is yours</small>
                  <Icon
                    name={
                      publishing.mode === "self-hosted"
                        ? "mdiCheckCircleOutline"
                        : "mdiCheckboxBlankCircleOutline"
                    }
                  />
                </button>
                <button
                  aria-pressed={publishing.mode === "cloud"}
                  onClick={() => changePublishing({ mode: "cloud" })}
                >
                  <Icon name="mdiCloudOutline" size={26} />
                  <strong>Cloud Pro</strong>
                  <span>
                    A managed home for your public work.
                    <br />
                    One studio, one domain, one server.
                  </span>
                  <small>
                    {publishing.billing === "monthly"
                      ? "$29.99 / month"
                      : "$299.90 / year"}
                  </small>
                  <Icon
                    name={
                      publishing.mode === "cloud"
                        ? "mdiCheckCircleOutline"
                        : "mdiCheckboxBlankCircleOutline"
                    }
                  />
                </button>
              </div>
              <div className="phw-publish-layout">
                <section className="phw-publishing-form">
                  <div className="phw-section-heading">
                    <div>
                      <h2>
                        {publishing.mode === "cloud"
                          ? "Managed publishing"
                          : "Your publishing space"}
                      </h2>
                      <p>
                        {publishing.mode === "cloud"
                          ? "A single managed server for this studio."
                          : "Connect your own server when you are ready to share."}
                      </p>
                    </div>
                    <span className="phw-status">
                      {publishing.online ? "Online preview" : "Offline preview"}
                    </span>
                  </div>
                  <Field
                    label="Domain"
                    hint="One domain for this studio. This example is reserved for previews."
                  >
                    <input
                      value={publishing.domain}
                      placeholder="yourstudio.example"
                      onChange={(event) =>
                        changePublishing({ domain: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Server name">
                    <input
                      value={publishing.server}
                      onChange={(event) =>
                        changePublishing({ server: event.target.value })
                      }
                    />
                  </Field>
                  {publishing.mode === "cloud" && (
                    <>
                      <Field label="Billing">
                        <select
                          value={publishing.billing}
                          onChange={(event) =>
                            changePublishing({ billing: event.target.value })
                          }
                        >
                          <option value="monthly">
                            Monthly · $29.99 / month
                          </option>
                          <option value="yearly">
                            Yearly · $299.90 / year
                          </option>
                        </select>
                      </Field>
                      <dl className="phw-stats">
                        <div>
                          <dt>Storage included</dt>
                          <dd>500 GB</dd>
                        </div>
                        <div>
                          <dt>Connection</dt>
                          <dd>50 Mbps</dd>
                        </div>
                        <div>
                          <dt>Monthly bandwidth</dt>
                          <dd>1 TB</dd>
                        </div>
                        <div>
                          <dt>Domains / servers</dt>
                          <dd>1 / 1</dd>
                        </div>
                      </dl>
                      <Toggle
                        label="Encrypted backup"
                        checked={publishing.backup}
                        onChange={(value) =>
                          changePublishing({ backup: value })
                        }
                        hint="Optional. Choose what to back up before enabling."
                      />
                    </>
                  )}
                  <Toggle
                    label="Preview offline"
                    checked={!publishing.online}
                    onChange={(value) => changePublishing({ online: !value })}
                    hint="Try the workspace without a connection."
                  />
                  {!publishing.online && (
                    <div className="phw-offline">
                      <Icon name="mdiWifiOff" />
                      <div>
                        <strong>You can keep working offline.</strong>
                        <p>
                          Culling, edits and local previews remain available.
                          Reconnect to publish.
                        </p>
                      </div>
                    </div>
                  )}
                  <Button
                    primary
                    icon="mdiCloudUploadOutline"
                    disabled={
                      !publishing.online ||
                      !publishing.server.trim() ||
                      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(
                        publishing.domain,
                      )
                    }
                    onClick={() => {
                      setState((current) => ({
                        ...current,
                        publishing: { ...current.publishing, published: true },
                        website: { ...current.website, published: true },
                      }));
                      say(
                        `Publishing preview ready at ${publishing.domain}. Nothing has been uploaded or purchased.`,
                      );
                    }}
                  >
                    {publishing.published
                      ? "Publishing preview ready"
                      : "Prepare publishing preview"}
                  </Button>
                  <p className="phw-small">
                    This is a design preview. No server is provisioned, payment
                    collected or photograph uploaded.
                  </p>
                </section>
                <aside className="phw-privacy">
                  <Icon name="mdiShieldCheckOutline" size={30} />
                  <h2>Made for a local workflow</h2>
                  <p>
                    Your studio tools work on every plan. Managed publishing is
                    an optional place to host your public portfolio and client
                    galleries.
                  </p>
                  <ul>
                    <li>Original RAW files stay on your device.</li>
                    <li>Proof downloads start off; watermarks start on.</li>
                    <li>You choose which photographs become public.</li>
                    <li>Encrypted backup is opt-in.</li>
                  </ul>
                  <Button
                    icon="mdiCameraOutline"
                    onClick={() => setSection("shoots")}
                  >
                    Back to your shoots
                  </Button>
                </aside>
              </div>
            </div>
          )}
        </main>
      </div>

      {dialog === "new-shoot" && (
        <Dialog
          title="New shoot"
          close={() => setDialog(null)}
          actions={
            <>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
              <Button primary type="submit" form="phw-new-shoot">
                Create shoot
              </Button>
            </>
          }
        >
          <form id="phw-new-shoot" onSubmit={createShoot}>
            <Field label="Shoot name">
              <input
                required
                data-initial-focus
                value={draft.name}
                placeholder="An afternoon together"
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </Field>
            <Field label="Client">
              <input
                required
                value={draft.client}
                placeholder="Client or publication"
                onChange={(event) =>
                  setDraft({ ...draft, client: event.target.value })
                }
              />
            </Field>
            <Field label="Shoot type">
              <select
                value={draft.type}
                onChange={(event) =>
                  setDraft({ ...draft, type: event.target.value })
                }
              >
                {[
                  "Family portrait",
                  "Wedding",
                  "Portrait",
                  "Editorial",
                  "Commercial",
                  "Event",
                  "Personal",
                ].map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </Field>
            <Field label="Shoot date">
              <input
                required
                type="date"
                value={draft.date}
                onChange={(event) =>
                  setDraft({ ...draft, date: event.target.value })
                }
              />
            </Field>
            <p className="phw-small">
              Start with an empty shoot, then add a sample set to explore the
              workflow.
            </p>
          </form>
        </Dialog>
      )}

      {dialog === "client" && gallery && (
        <Dialog
          title={`${shoot.client}'s proof selection`}
          close={() => setDialog(null)}
          wide
          actions={
            <>
              <span className="phw-small">
                {clientPhotos.length} of {gallery.selectionLimit} selected
              </span>
              <Button onClick={() => setDialog(null)}>Close</Button>
              <Button
                primary
                disabled={!clientPhotos.length || expired || gallery.submitted}
                onClick={() => {
                  changeGallery({
                    submitted: true,
                    approved: false,
                    zipReady: false,
                  });
                  setDialog(null);
                  say("Client selection submitted in the preview.");
                }}
              >
                {gallery.submitted ? "Selection submitted" : "Submit selection"}
              </Button>
            </>
          }
        >
          <div className="phw-client-dialog">
            <p>
              {gallery.submitted
                ? "Selection submitted. The studio can now review your choices."
                : `Choose up to ${gallery.selectionLimit} favourites for your final delivery.`}
            </p>
            <div className="phw-client-grid">
              {proofs.map((photo) => (
                <button
                  key={photo.id}
                  className={
                    gallery.clientSelected.includes(photo.id) ? "chosen" : ""
                  }
                  aria-pressed={gallery.clientSelected.includes(photo.id)}
                  disabled={expired || gallery.submitted}
                  onClick={() => chooseClientPhoto(photo.id)}
                >
                  <div>
                    <img src={photo.image} alt={photo.name} />
                    <Watermark brand={brand} enabled={gallery.watermark} />
                    <span>
                      <Icon
                        name={
                          gallery.clientSelected.includes(photo.id)
                            ? "mdiHeart"
                            : "mdiHeartOutline"
                        }
                      />
                    </span>
                  </div>
                  <strong>{photo.name}</strong>
                </button>
              ))}
            </div>
            {gallery.submitted && !gallery.delivered && (
              <Button
                onClick={() =>
                  changeGallery({
                    submitted: false,
                    approved: false,
                    zipReady: false,
                  })
                }
              >
                Reopen selection in preview
              </Button>
            )}
            <form
              className="phw-client-comment"
              onSubmit={(event) => {
                event.preventDefault();
                if (!comment.trim() || !commentPhoto || expired) return;
                changeGallery({
                  comments: [
                    ...gallery.comments,
                    {
                      id: `comment-${Date.now()}`,
                      photoId: commentPhoto,
                      author: shoot.client,
                      text: comment.trim(),
                    },
                  ],
                });
                setComment("");
                say("Client comment added to the preview.");
              }}
            >
              <Field label="Leave a note on">
                <select
                  value={commentPhoto}
                  onChange={(event) => setCommentPhoto(event.target.value)}
                >
                  {proofs.map((photo) => (
                    <option key={photo.id} value={photo.id}>
                      {photo.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Comment">
                <textarea
                  value={comment}
                  placeholder="What do you love about this frame?"
                  onChange={(event) => setComment(event.target.value)}
                />
              </Field>
              <Button
                type="submit"
                icon="mdiCommentOutline"
                disabled={!comment.trim() || !commentPhoto || expired}
              >
                Add comment
              </Button>
            </form>
          </div>
        </Dialog>
      )}

      {dialog === "portfolio" && (
        <Dialog
          title="Add portfolio photos"
          close={() => setDialog(null)}
          wide
          actions={
            <Button primary onClick={() => setDialog(null)}>
              Done
            </Button>
          }
        >
          <div className="phw-client-grid phw-portfolio-choose">
            {state.photos
              .filter((photo) => !photo.rejected)
              .map((photo) => (
                <button
                  key={photo.id}
                  aria-pressed={website.order.includes(photo.id)}
                  className={website.order.includes(photo.id) ? "chosen" : ""}
                  onClick={() =>
                    changeWebsite({
                      order: website.order.includes(photo.id)
                        ? website.order.filter((id) => id !== photo.id)
                        : [...website.order, photo.id],
                    })
                  }
                >
                  <div>
                    <img src={photo.image} alt={photo.name} />
                    <span>
                      <Icon
                        name={
                          website.order.includes(photo.id)
                            ? "mdiCheckCircleOutline"
                            : "mdiCheckboxBlankCircleOutline"
                        }
                      />
                    </span>
                  </div>
                  <strong>{photo.name}</strong>
                </button>
              ))}
          </div>
        </Dialog>
      )}
    </div>
  );
}

export default PhotographyWorkspace;
