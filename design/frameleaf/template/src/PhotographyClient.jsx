import React, { useEffect, useState } from "react";
import { Button, Dialog } from "./Controls";
import { Icon } from "./Icon";
import {
  changeProofSelection,
  proofAccess,
  publicPhoto,
} from "./photography-client.mjs";
import "./photography-client.css";
import { Watermark } from "./PhotographyWatermark";
import {
  selectionPrice,
  money,
  downloadablePhotos,
} from "./photography-workflow.mjs";

const fallbackPhotos = [
  "portrait",
  "hiking",
  "lake",
  "campfire",
  "flowers",
  "cabin",
  "dog",
  "summit",
].map((scene, index) => ({
  id: `client-${index}`,
  image: `/media/${scene}.png`,
  name: `Lake portraits ${String(index + 1).padStart(2, "0")}`,
}));
const fallbackBrand = {
  name: "Cedar & Light",
  tagline: "Photographs that feel like you.",
  email: "hello@cedarandlight.example",
  phone: "+1 (780) 555-0142",
  color: "#33483f",
};

/** Interactive client-facing design reference; media and access controls use fictional local data. */
export function PhotographyClient({
  context = {},
  website = false,
  onBack,
  onFeedback,
  notify,
}) {
  const brand = { ...fallbackBrand, ...context.brand };
  const photos = (
    Array.isArray(context.photos) ? context.photos : fallbackPhotos
  ).map(publicPhoto);
  const shoot = context.shoot || {
    name: "A morning at the lake",
    client: "The Bennett family",
    date: "September 21, 2026",
  };
  const [gallery, setGallery] = useState({
    selectionLimit: 6,
    watermark: true,
    downloadAllowed: false,
    ...(context.gallery || {}),
  });
  const [selection, setSelection] = useState(
    (context.gallery?.clientSelected || []).filter((id) =>
      photos.some((photo) => photo.id === id),
    ),
  );
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [chapter, setChapter] = useState("all");
  const [compare, setCompare] = useState([]);
  const [opened, setOpened] = useState(null);
  const [comments, setComments] = useState(
    Array.isArray(context.gallery?.comments) ? context.gallery.comments : [],
  );
  const [comment, setComment] = useState("");
  const [dialog, setDialog] = useState(null);
  const [downloadPhotoId, setDownloadPhotoId] = useState(null);
  const [page, setPage] = useState(website ? "Portfolio" : "Gallery");
  const [layout, setLayout] = useState(context.layout || "editorial");
  const [phone, setPhone] = useState(false);
  const [slide, setSlide] = useState(0);
  const access = website ? "open" : proofAccess(gallery, unlocked);
  const shown = photos.filter(
    (photo) =>
      (filter !== "selected" || selection.includes(photo.id)) &&
      (chapter === "all" || gallery.photoChapters?.[photo.id] === chapter),
  );
  const price = selectionPrice(gallery, selection);
  const downloadable = gallery.workflowEnabled
    ? downloadablePhotos(gallery, context.photos || []).map(publicPhoto)
    : gallery.downloadAllowed
      ? photos
      : [];
  const downloadSelection = downloadPhotoId
    ? downloadable.filter((photo) => photo.id === downloadPhotoId)
    : downloadable;
  const chapters = gallery.chapters || [
    ...new Set(Object.values(gallery.photoChapters || {})),
  ];
  const cover =
    photos.find((photo) => photo.id === gallery.coverId) ||
    photos.find((photo) => photo.image === shoot.cover) ||
    photos[0];
  const current = photos.find((photo) => photo.id === opened);
  useEffect(() => {
    if (
      layout !== "slideshow" ||
      !website ||
      photos.length < 2 ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const timer = setInterval(
      () => setSlide((value) => (value + 1) % photos.length),
      5000,
    );
    return () => clearInterval(timer);
  }, [layout, website, photos.length]);
  const choose = (id) => {
    const result = changeProofSelection(selection, id, gallery);
    setSelection(result.selection);
    setError(result.error || "");
  };
  const watermark = gallery.delivered
    ? (gallery.webWatermark ?? gallery.watermark)
    : gallery.watermark;
  const renderPhoto = (
    photo,
    large = false,
    marked = true,
    finalExport = false,
  ) => {
    const finished =
      gallery.delivered &&
      (!gallery.workflowEnabled ||
        downloadable.some((item) => item.id === photo?.id));
    return !photo ? (
      <div className="pc-empty">
        Your published photographs will appear here.
      </div>
    ) : (
      <div className={`pc-image ${large ? "pc-image-large" : ""}`}>
        <img
          src={photo.image}
          alt={photo.name}
          style={{ filter: photo.previewFilter }}
          loading={large ? "eager" : "lazy"}
        />
        {!website && marked && (
          <Watermark
            brand={brand}
            enabled={
              finalExport
                ? !!gallery.export?.watermark
                : finished
                  ? (gallery.webWatermark ?? gallery.watermark)
                  : gallery.watermark
            }
            variant={finished || finalExport ? "web" : "proof"}
            pattern={finished || finalExport ? undefined : gallery.proofPattern}
          />
        )}
      </div>
    );
  };
  return (
    <main className={`pc-preview ${phone ? "pc-phone-preview" : ""}`}>
      <div className="pc-preview-bar">
        <Button
          icon="mdiArrowLeft"
          onClick={() => {
            if (
              !website &&
              onFeedback?.({
                clientSelected: selection,
                comments,
                submitted: Boolean(gallery.submitted),
              }) === false
            ) {
              setError(
                "This device couldn’t save your sample choices. Keep this preview open.",
              );
              return;
            }
            onBack?.();
          }}
        >
          Back to Photography
        </Button>
        <span>{website ? "Studio website" : "Client gallery"} preview</span>
        <span className="grow" />
        {access === "locked" && (
          <small>Sample password: {gallery.password}</small>
        )}
        <Button
          active={!phone}
          icon="mdiMonitor"
          aria-label="Desktop preview"
          onClick={() => setPhone(false)}
        />
        <Button
          active={phone}
          icon="mdiCellphone"
          aria-label="Phone preview"
          onClick={() => setPhone(true)}
        />
        {website ? (
          <select
            aria-label="Website layout"
            value={layout}
            onChange={(event) => setLayout(event.target.value)}
          >
            <option value="editorial">Editorial</option>
            <option value="grid">Grid</option>
            <option value="slideshow">Slideshow</option>
            <option value="wedding">Wedding story</option>
            <option value="portrait">Family & portrait</option>
            <option value="fine-art">Editorial & fine art</option>
            <option value="proofing">Proofing & sales</option>
          </select>
        ) : (
          <select
            aria-label="Gallery preview state"
            value={
              access === "expired"
                ? "expired"
                : access === "offline"
                  ? "offline"
                  : gallery.delivered
                    ? "delivery"
                    : "proof"
            }
            onChange={(event) => {
              const value = event.target.value;
              setGallery({
                ...gallery,
                expired: value === "expired",
                offline: value === "offline",
                delivered: value === "delivery",
                downloadAllowed: value === "delivery",
              });
              setError("");
            }}
          >
            <option value="proof">Watermarked proofs</option>
            <option value="delivery">Final delivery</option>
            <option value="expired">Expired link</option>
            <option value="offline">Studio offline</option>
          </select>
        )}
      </div>
      <section
        className={`pc-site pc-family-${layout} pc-theme-${gallery.theme || "studio"} pc-type-${gallery.typography || "editorial"}`}
        style={{
          "--pc-ink": brand.color || "#33483f",
          "--pc-paper": brand.background || "#fafbf9",
          "--pc-text": brand.textColor || "#292e2a",
          "--pc-gap":
            (gallery.spacing || context.spacing) === "compact"
              ? "14px"
              : (gallery.spacing || context.spacing) === "airy"
                ? "44px"
                : "28px",
          "--pc-font": ["editorial", "classic"].includes(brand.font)
            ? "Georgia, serif"
            : "inherit",
        }}
      >
        <header className="pc-header">
          <button
            className="pc-brand"
            onClick={() => setPage(website ? "Portfolio" : "Gallery")}
          >
            {brand.logoImage ? (
              <img className="pc-logo" src={brand.logoImage} alt="" />
            ) : (
              <span className="pc-monogram">{brand.logo || "c&l"}</span>
            )}
            {brand.name}
          </button>
          <nav aria-label="Studio website">
            {(website
              ? ["Portfolio", "About", "Contact"]
              : ["Gallery", "Contact"]
            ).map((label) => (
              <button
                key={label}
                aria-current={page === label ? "page" : undefined}
                onClick={() => setPage(label)}
              >
                {label}
              </button>
            ))}
          </nav>
        </header>
        {page === "Contact" ? (
          <section className="pc-copy">
            <p className="pc-kicker">LET’S MAKE SOMETHING PERSONAL</p>
            <h1>Tell us your story.</h1>
            <p>
              {brand.contact ||
                "Family photographs, wedding days, and portraits. We’d love to hear what you have in mind."}
            </p>
            <a href={`mailto:${brand.email}`}>{brand.email}</a>
            <a href={`tel:${String(brand.phone).replace(/[^+0-9]/g, "")}`}>
              {brand.phone}
            </a>
            <p>Edmonton, Alberta · Available throughout the Rockies</p>
          </section>
        ) : page === "About" ? (
          <section className="pc-about">
            <img
              src="/media/hiking.png"
              alt="An outdoor portrait session in the Canadian Rockies"
            />
            <div>
              <p className="pc-kicker">CEDAR & LIGHT STUDIO</p>
              <h1>
                A little less posing.
                <br />A little more you.
              </h1>
              <p>
                {brand.about ||
                  "We photograph the people you love and the moments you want to remember. Quiet portraits, big celebrations, and everything in between."}
              </p>
              <Button onClick={() => setPage("Contact")}>Let’s talk</Button>
            </div>
          </section>
        ) : access !== "open" ? (
          <section className="pc-access">
            <Icon
              name={
                access === "locked"
                  ? "mdiLockOutline"
                  : access === "offline"
                    ? "mdiCloudOffOutline"
                    : "mdiClockOutline"
              }
              size={32}
            />
            <h1>
              {access === "locked"
                ? "Your photographs are ready."
                : access === "expired"
                  ? "This gallery link has expired."
                  : "The studio is temporarily offline."}
            </h1>
            <p>
              {access === "locked"
                ? "Enter the password your photographer shared with you."
                : access === "expired"
                  ? "Contact your photographer to request a new link."
                  : "Please try again shortly."}
            </p>
            {access === "locked" && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (password === gallery.password) {
                    setUnlocked(true);
                    setError("");
                  } else
                    setError("That password didn’t match. Please try again.");
                }}
              >
                <label>
                  Gallery password
                  <input
                    type="password"
                    autoComplete="off"
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
                <Button primary type="submit">
                  Open gallery
                </Button>
              </form>
            )}
            <a href={`mailto:${brand.email}`}>Contact {brand.name}</a>
            {error && <p role="alert">{error}</p>}
          </section>
        ) : (
          <>
            {website ? (
              <section className={`pc-hero pc-hero-${layout}`}>
                <div>
                  <p className="pc-kicker">WEDDINGS · FAMILIES · PORTRAITS</p>
                  <h1>{brand.tagline || "Photographs that feel like you."}</h1>
                  <p>
                    Honest moments. People you love.
                    <br />
                    Beautifully kept, for years to come.
                  </p>
                  <button
                    className="pc-text-link"
                    onClick={() =>
                      document.getElementById("pc-portfolio")?.scrollIntoView({
                        behavior: matchMedia("(prefers-reduced-motion: reduce)")
                          .matches
                          ? "auto"
                          : "smooth",
                      })
                    }
                  >
                    Explore the photographs{" "}
                    <Icon name="mdiArrowDown" size={17} />
                  </button>
                </div>
                {renderPhoto(photos[layout === "slideshow" ? slide : 0], true)}
              </section>
            ) : (
              <section
                className={`pc-gallery-cover pc-cover-${gallery.coverStyle || "split"}`}
                style={{ "--pc-focal": `${gallery.focalPoint ?? 50}%` }}
              >
                {renderPhoto(cover, true)}
                <div className="pc-gallery-intro">
                  <p className="pc-kicker">
                    {gallery.delivered
                      ? "YOUR FINISHED COLLECTION"
                      : "YOUR PRIVATE GALLERY"}
                  </p>
                  <h1>{shoot.name}</h1>
                  <p>
                    {shoot.client} · {shoot.date || "September 21, 2026"}
                  </p>
                  <p>
                    {gallery.introduction ||
                      (gallery.delivered
                        ? "Your photographs are ready to keep, print, and share."
                        : gallery.workflowEnabled
                          ? `Take your time. Choose the photographs you love; we’ll finish your favourites.`
                          : `Choose your ${gallery.selectionLimit} favourite photographs. We’ll take care of the finishing touches.`)}
                  </p>
                  {gallery.workflowEnabled && !gallery.delivered && (
                    <p className="pc-package-line">
                      {gallery.includedCount} finished photographs included
                      {gallery.extraPriceCents > 0 &&
                        ` · ${money(gallery.extraPriceCents, gallery.currency)} per additional photograph`}
                    </p>
                  )}
                </div>
              </section>
            )}
            {!website && (
              <div className="pc-gallery-actions">
                <div>
                  <button
                    aria-pressed={filter === "all"}
                    onClick={() => setFilter("all")}
                  >
                    All photographs <small>{photos.length}</small>
                  </button>
                  <button
                    aria-pressed={filter === "selected"}
                    onClick={() => setFilter("selected")}
                  >
                    Your favourites <small>{selection.length}</small>
                  </button>
                </div>
                {chapters.length > 1 && (
                  <select
                    aria-label="Gallery chapter"
                    value={chapter}
                    onChange={(e) => setChapter(e.target.value)}
                  >
                    <option value="all">Every chapter</option>
                    {chapters.map((name) => (
                      <option key={name}>{name}</option>
                    ))}
                  </select>
                )}
                <span className="grow" />
                {compare.length > 0 && (
                  <Button
                    disabled={compare.length !== 2}
                    onClick={() => setDialog("compare")}
                  >
                    Compare {compare.length} photographs
                  </Button>
                )}
                {downloadable.length > 0 && (
                  <Button
                    icon="mdiDownload"
                    onClick={() => {
                      setDownloadPhotoId(null);
                      setDialog("download");
                    }}
                  >
                    {gallery.delivered
                      ? "Download photographs"
                      : "Download proofs"}
                  </Button>
                )}
                {!gallery.delivered && (
                  <Button
                    primary
                    disabled={!selection.length || gallery.submitted}
                    onClick={() => setDialog("submit")}
                  >
                    {gallery.submitted
                      ? "Selections submitted"
                      : `Submit ${selection.length} selections`}
                  </Button>
                )}
              </div>
            )}
            {error && (
              <p className="pc-inline-error" role="alert">
                {error}
              </p>
            )}
            {!website && gallery.submitted && !gallery.delivered && (
              <p className="pc-confirmation" role="status">
                <Icon name="mdiCheckCircleOutline" />
                Your selections have been sent to your photographer. We’ll be in
                touch about the finished photographs.
              </p>
            )}
            <section
              id="pc-portfolio"
              className={`pc-grid pc-grid-${layout}`}
              aria-label={
                website ? "Portfolio photographs" : "Gallery photographs"
              }
            >
              {shown.map((photo, index) => (
                <React.Fragment key={photo.id}>
                  {!website &&
                    (gallery.showChapters ?? true) &&
                    gallery.photoChapters?.[photo.id] &&
                    (index === 0 ||
                      gallery.photoChapters[shown[index - 1].id] !==
                        gallery.photoChapters[photo.id]) && (
                      <div className="pc-chapter-title">
                        <small>
                          {String(
                            chapters.indexOf(gallery.photoChapters[photo.id]) +
                              1,
                          ).padStart(2, "0")}
                        </small>
                        <h2>{gallery.photoChapters[photo.id]}</h2>
                      </div>
                    )}
                  <article
                    key={photo.id}
                    className={
                      selection.includes(photo.id) ? "pc-selected" : ""
                    }
                  >
                    <button
                      className="pc-photo-button"
                      aria-label={`View ${photo.name}`}
                      onClick={() => {
                        setOpened(photo.id);
                        setComment("");
                      }}
                    >
                      {renderPhoto(photo)}
                    </button>
                    <div className="pc-caption">
                      <span>
                        {website
                          ? [
                              "Quiet moments",
                              "Together, outside",
                              "A place to remember",
                            ][index % 3]
                          : (gallery.showNumbers ?? true)
                            ? `No. ${gallery.photoNumbers?.[photo.id] || String(photos.indexOf(photo) + 1).padStart(3, "0")}`
                            : photo.name}
                      </span>
                      {!website && gallery.delivered && (
                        <small className="pc-photo-rights">
                          {downloadable.some((item) => item.id === photo.id)
                            ? "Finished"
                            : "Proof only"}
                        </small>
                      )}
                      {!website && !gallery.delivered && (
                        <button
                          aria-label={`Compare ${photo.name}`}
                          aria-pressed={compare.includes(photo.id)}
                          onClick={() =>
                            setCompare(
                              compare.includes(photo.id)
                                ? compare.filter((id) => id !== photo.id)
                                : [...compare.slice(-1), photo.id],
                            )
                          }
                        >
                          <Icon name="mdiCompare" size={18} />
                        </button>
                      )}
                      {!website && !gallery.delivered && (
                        <button
                          aria-label={`${selection.includes(photo.id) ? "Remove favourite" : "Favourite"} ${photo.name}`}
                          aria-pressed={selection.includes(photo.id)}
                          disabled={gallery.submitted}
                          onClick={() => choose(photo.id)}
                        >
                          <Icon
                            name={
                              selection.includes(photo.id)
                                ? "mdiHeart"
                                : "mdiHeartOutline"
                            }
                            size={21}
                          />
                        </button>
                      )}
                    </div>
                  </article>
                </React.Fragment>
              ))}
            </section>
            {!shown.length && (
              <p className="pc-empty">
                Your favourites will appear here when you choose photographs.
              </p>
            )}
            {!website && gallery.workflowEnabled && (
              <div className="pc-selection-tray">
                <span>
                  <Icon
                    name={
                      gallery.delivered
                        ? "mdiImageCheckOutline"
                        : "mdiHeartOutline"
                    }
                  />
                  <strong>
                    {gallery.delivered
                      ? `${downloadable.length} finished photographs ready`
                      : `${selection.length} photographs chosen`}
                  </strong>
                  <small>
                    {gallery.delivered
                      ? "Ready to download"
                      : `${price.included} included · ${price.extra} additional`}
                  </small>
                </span>
                <div>
                  <strong>
                    {money(
                      gallery.order?.totalCents ?? price.totalCents,
                      gallery.currency,
                    )}
                  </strong>
                  <small>
                    {gallery.delivered
                      ? gallery.order?.totalCents > 0
                        ? "Paid"
                        : "Included in your package"
                      : gallery.submitted
                        ? "Submitted for photographer review"
                        : "Additional photographs · estimate"}
                  </small>
                </div>
                {gallery.delivered ? (
                  <Button
                    disabled={!downloadable.length}
                    onClick={() => {
                      setDownloadPhotoId(null);
                      setDialog("download");
                    }}
                    icon="mdiDownload"
                  >
                    Download finished collection
                  </Button>
                ) : (
                  <Button
                    primary
                    disabled={!selection.length || gallery.submitted}
                    onClick={() => setDialog("submit")}
                  >
                    {gallery.submitted
                      ? "Selections submitted"
                      : "Review selections"}
                  </Button>
                )}
              </div>
            )}
            {website && (
              <section className="pc-site-contact">
                <h2>Your people. Your story.</h2>
                <p>Let’s make photographs you’ll always come back to.</p>
                <button onClick={() => setPage("Contact")}>
                  Get in touch <Icon name="mdiArrowRight" size={18} />
                </button>
              </section>
            )}
          </>
        )}
        <footer className="pc-footer">
          <span>© 2026 {brand.name}</span>
          <span>
            {website
              ? "Weddings, families & portraits"
              : "Private photographs · Shared by your studio"}
          </span>
          <button onClick={() => setPage("Contact")}>Contact</button>
        </footer>
      </section>
      {current && access === "open" && (
        <Dialog wide title={current.name} close={() => setOpened(null)}>
          {renderPhoto(current, true)}
          {!website &&
            downloadable.some((photo) => photo.id === current.id) && (
              <div className="pc-dialog-actions">
                <Button
                  icon="mdiDownload"
                  onClick={() => {
                    setDownloadPhotoId(current.id);
                    setOpened(null);
                    setDialog("download");
                  }}
                >
                  Download this photograph
                </Button>
              </div>
            )}
          {!gallery.delivered && !website && (
            <div className="pc-detail">
              <Button
                active={selection.includes(current.id)}
                icon="mdiHeartOutline"
                disabled={gallery.submitted}
                onClick={() => choose(current.id)}
              >
                {selection.includes(current.id)
                  ? "Selected"
                  : "Add to favourites"}
              </Button>
              <label>
                Note for your photographer
                <textarea
                  value={comment}
                  disabled={gallery.submitted}
                  maxLength={2000}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="A finishing touch or a question…"
                />
              </label>
              <Button
                disabled={!comment.trim() || gallery.submitted}
                onClick={() => {
                  setComments([
                    ...comments,
                    {
                      id: crypto.randomUUID(),
                      photoId: current.id,
                      author: shoot.client,
                      text: comment.trim(),
                    },
                  ]);
                  setComment("");
                }}
              >
                Add note
              </Button>
              {comments
                .filter((note) => note.photoId === current.id)
                .map((note) => (
                  <p key={note.id}>{note.text}</p>
                ))}
            </div>
          )}
        </Dialog>
      )}
      {dialog === "submit" && (
        <Dialog title="Send your selections?" close={() => setDialog(null)}>
          <p>
            You’ve chosen {selection.length} photographs from {shoot.name}. Your
            photographer will use these for your finished collection.
          </p>
          {gallery.workflowEnabled && (
            <div className="pc-order-review">
              <p>
                <span>Included photographs</span>
                <strong>{price.included}</strong>
              </p>
              <p>
                <span>Additional photographs</span>
                <strong>
                  {price.extra} ×{" "}
                  {money(price.unitPriceCents, gallery.currency)}
                </strong>
              </p>
              <p>
                <span>Additional total</span>
                <strong>{money(price.totalCents, gallery.currency)}</strong>
              </p>
              <small>
                Your photographer will confirm the scope and price, edit your
                choices and arrange payment before final delivery. No payment is
                taken here.
              </small>
            </div>
          )}
          <div className="pc-dialog-actions">
            <Button onClick={() => setDialog(null)}>Keep choosing</Button>
            <Button
              primary
              onClick={() => {
                if (
                  onFeedback?.({
                    clientSelected: selection,
                    comments,
                    submitted: true,
                  }) === false
                ) {
                  setError(
                    "This device couldn’t save the sample submission. Please try again.",
                  );
                  setDialog(null);
                  return;
                }
                setGallery({ ...gallery, submitted: true });
                setDialog(null);
                notify?.("Sample client selections submitted.");
              }}
            >
              Send selections
            </Button>
          </div>
        </Dialog>
      )}
      {dialog === "compare" && access === "open" && (
        <Dialog wide title="Find your favourite" close={() => setDialog(null)}>
          <div className="pc-compare">
            {compare.map((id) => {
              const p = photos.find((photo) => photo.id === id);
              return (
                <div key={id}>
                  {renderPhoto(p, true)}
                  <p>{p.name}</p>
                  <Button
                    active={selection.includes(id)}
                    disabled={gallery.submitted}
                    onClick={() => choose(id)}
                    icon="mdiHeartOutline"
                  >
                    {selection.includes(id)
                      ? "Selected"
                      : "Choose this photograph"}
                  </Button>
                </div>
              );
            })}
          </div>
        </Dialog>
      )}
      {dialog === "download" &&
        access === "open" &&
        downloadable.length > 0 && (
          <Dialog
            title={
              gallery.delivered
                ? "Your finished photographs"
                : "Your preview photographs"
            }
            close={() => setDialog(null)}
          >
            <p>
              {downloadSelection.length}{" "}
              {gallery.delivered
                ? `${downloadSelection.length === 1 ? "photograph" : "photographs"} · ${gallery.export?.format || "JPEG"} · ${gallery.export?.longEdge === "original" ? "Full resolution" : `${gallery.export?.longEdge || "3840"} px`}`
                : `web-sized proofs${watermark ? " · Watermarked" : ""}`}
            </p>
            <div className="pc-download-preview">
              {renderPhoto(
                downloadSelection[0],
                false,
                !gallery.delivered || gallery.export?.watermark,
                gallery.delivered,
              )}
              <span>
                <strong>
                  {!gallery.delivered
                    ? "Watermarked proof"
                    : gallery.export?.watermark
                      ? "Branded finished export"
                      : "Clean finished export"}
                </strong>
                <small>Includes the finished photographs you selected.</small>
              </span>
            </div>
            <p className="muted">
              Design preview: download preparation is simulated.
            </p>
            <Button
              primary
              icon="mdiDownload"
              onClick={() => {
                setDialog(null);
                notify?.(
                  "Sample photo package prepared. No real media was downloaded.",
                );
              }}
            >
              Prepare download
            </Button>
          </Dialog>
        )}
    </main>
  );
}
