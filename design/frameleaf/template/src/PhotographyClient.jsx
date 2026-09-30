import React, { useEffect, useState } from "react";
import { Button, Dialog } from "./Controls";
import { Icon } from "./Icon";
import {
  changeProofSelection,
  proofAccess,
  publicPhoto,
} from "./photography-client.mjs";
import "./photography-client.css";

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
  const [opened, setOpened] = useState(null);
  const [comments, setComments] = useState(
    Array.isArray(context.gallery?.comments) ? context.gallery.comments : [],
  );
  const [comment, setComment] = useState("");
  const [dialog, setDialog] = useState(null);
  const [page, setPage] = useState("Portfolio");
  const [layout, setLayout] = useState(context.layout || "editorial");
  const [phone, setPhone] = useState(false);
  const [slide, setSlide] = useState(0);
  const access = website ? "open" : proofAccess(gallery, unlocked);
  const shown =
    filter === "selected"
      ? photos.filter((photo) => selection.includes(photo.id))
      : photos;
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
    ? !!gallery.export?.watermark
    : gallery.watermark;
  const renderPhoto = (photo, large = false) =>
    !photo ? (
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
        {!website && watermark && (
          <span
            className={`pc-watermark pc-watermark-${brand.watermarkPosition || "center"}`}
            style={{
              color: brand.watermarkColor || "#fff",
              opacity: (brand.watermarkOpacity ?? 70) / 100,
              fontSize: `${brand.watermarkSize || 6}cqw`,
            }}
            aria-label="Watermarked preview"
          >
            {brand.logoImage ? (
              <img src={brand.logoImage} alt="" />
            ) : (
              brand.logo || brand.name
            )}
            {!gallery.delivered && <small>PROOF</small>}
          </span>
        )}
      </div>
    );
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
        className="pc-site"
        style={{
          "--pc-ink": brand.color || "#33483f",
          "--pc-paper": brand.background || "#fafbf9",
          "--pc-text": brand.textColor || "#292e2a",
          "--pc-gap":
            context.spacing === "compact"
              ? "14px"
              : context.spacing === "airy"
                ? "44px"
                : "28px",
          "--pc-font": ["editorial", "classic"].includes(brand.font)
            ? "Georgia, serif"
            : "inherit",
        }}
      >
        <header className="pc-header">
          <button className="pc-brand" onClick={() => setPage("Portfolio")}>
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
                  : "Please try again shortly. Your photographs are still with the studio."}
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
              <section className="pc-gallery-intro">
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
                  {gallery.delivered
                    ? "Your photographs are ready to keep, print, and share."
                    : `Choose your ${gallery.selectionLimit} favourite photographs. We’ll take care of the finishing touches.`}
                </p>
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
                <span className="grow" />
                {gallery.downloadAllowed && (
                  <Button
                    icon="mdiDownload"
                    onClick={() => setDialog("download")}
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
            {!website && gallery.submitted && (
              <p className="pc-confirmation" role="status">
                <Icon name="mdiCheckCircleOutline" />
                Your selections have been sent to your photographer. We’ll be in
                touch about the finished photographs.
              </p>
            )}
            <section
              id="pc-portfolio"
              className={`pc-grid pc-grid-${website ? layout : "proof"}`}
              aria-label={
                website ? "Portfolio photographs" : "Gallery photographs"
              }
            >
              {shown.map((photo, index) => (
                <article
                  key={photo.id}
                  className={selection.includes(photo.id) ? "pc-selected" : ""}
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
                        : String(index + 1).padStart(2, "0")}
                    </span>
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
              ))}
            </section>
            {!shown.length && (
              <p className="pc-empty">
                Your favourites will appear here when you choose photographs.
              </p>
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
      {dialog === "download" && (
        <Dialog
          title={
            gallery.delivered
              ? "Your finished photographs"
              : "Your preview photographs"
          }
          close={() => setDialog(null)}
        >
          <p>
            {photos.length}{" "}
            {gallery.delivered
              ? `approved photographs · ${gallery.export?.format || "JPEG"} · ${gallery.export?.longEdge === "original" ? "Original size" : `${gallery.export?.longEdge || "3840"} px`} · ${gallery.export?.colorSpace || "sRGB"}`
              : `web-sized proofs${watermark ? " · Watermarked" : ""}`}
          </p>
          <p>Camera originals remain with your photographer.</p>
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
