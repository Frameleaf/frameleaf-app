import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Dialog } from "./App";
import { Icon } from "./Icon";
import { QrCode, copyText } from "./QrCode";
import {
  EXPIRY_PRESETS,
  absoluteLinkUrl,
  expiryFromPreset,
  expiryLabel,
  fromLocalInputValue,
  linkAssets,
  linkBadges,
  linkUrl,
  normalizeSlug,
  slugAvailability,
  toLocalInputValue,
} from "./shared-links-data.mjs";
import "./sharing.css";

/** Current time that refreshes on an interval, for countdowns. */
export function useNow(interval = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(id);
  }, [interval]);
  return now;
}

/** Cover collage of up to four items; placeholders render as icon tiles. */
export function AssetCollage({ items = [], previews = {}, className = "" }) {
  const shown = items.slice(0, 4);
  return (
    <div className={`sl-collage ${className}`} data-count={shown.length} aria-hidden="true">
      {shown.length ? (
        shown.map((item) => {
          const src = item.placeholder ? previews[item.name] : item.image;
          return src ? (
            <img key={item.id} src={src} alt="" loading="lazy" />
          ) : (
            <span key={item.id} className="sl-collage-blank">
              <Icon name={item.type === "video" ? "mdiVideoOutline" : "mdiImageOutline"} />
            </span>
          );
        })
      ) : (
        <span className="sl-collage-blank">
          <Icon name="mdiImageMultipleOutline" />
        </span>
      )}
      {items.length > 4 && <span className="sl-collage-more">+{items.length - 4}</span>}
    </div>
  );
}

export function Badges({ badges, className = "" }) {
  return (
    <ul className={`sl-badges ${className}`} aria-label="Link details">
      {badges.map((badge) => (
        <li key={badge.id} className="sl-badge" data-tone={badge.tone || "neutral"}>
          {badge.icon && <Icon name={badge.icon} size={14} />}
          {badge.label}
        </li>
      ))}
    </ul>
  );
}

const typingSlug = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);

function originBase() {
  return typeof location === "object" && location
    ? `${location.origin}${location.pathname}`
    : "https://frameleaf.local/";
}

/**
 * Create or edit a shared link.
 * props: { link|null, target {type, albumId|assetIds, name}, links, assets,
 *          onSave(input) -> saved link, onClose(), onOpen(link) }
 */
export function SharedLinkForm({
  link = null,
  target,
  links = [],
  assets = [],
  onSave,
  onClose,
  onOpen,
}) {
  const editing = !!link;
  const now = useNow();
  const ids = useId();
  const formId = `${ids}-form`;
  const [description, setDescription] = useState(link?.description ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [removePassword, setRemovePassword] = useState(false);
  const [slug, setSlug] = useState(link?.slug ?? "");
  const [allowDownload, setAllowDownload] = useState(link ? link.allowDownload : true);
  const [allowUpload, setAllowUpload] = useState(link ? link.allowUpload : false);
  const [showMetadata, setShowMetadata] = useState(link ? link.showMetadata : false);
  const [preset, setPreset] = useState(link?.expiresAt ? "custom" : "never");
  const [customAt, setCustomAt] = useState(
    link?.expiresAt ? toLocalInputValue(link.expiresAt) : "",
  );
  const [error, setError] = useState("");
  const [created, setCreated] = useState(null);
  const [showQr, setShowQr] = useState(false);
  const [status, setStatus] = useState("");
  const statusTimer = useRef(null);
  useEffect(() => () => clearTimeout(statusTimer.current), []);

  const type = link?.type ?? target?.type ?? "album";
  const albumId = link?.albumId ?? target?.albumId ?? null;
  const assetIds = link?.assetIds ?? target?.assetIds ?? [];
  const name =
    target?.name ||
    (type === "album" ? albumId : `${assetIds.length} ${assetIds.length === 1 ? "item" : "items"}`);
  const availability = slugAvailability(slug, links, link?.id);
  const slugChanged = editing && (slug.trim() || null) !== (link.slug || null);
  const expiresAt =
    preset === "custom" ? fromLocalInputValue(customAt) : expiryFromPreset(preset, now);
  const hasPassword = editing
    ? removePassword
      ? false
      : password
        ? true
        : link.hasPassword
    : !!password;
  const preview = useMemo(
    () => ({
      id: link?.id ?? "new-link",
      type,
      albumId,
      assetIds,
      description: description.trim(),
      slug: availability.status === "available" ? slug.trim() : null,
      hasPassword,
      allowDownload,
      allowUpload,
      showMetadata,
      expiresAt,
      views: link?.views ?? 0,
      uploads: link?.uploads ?? [],
    }),
    [
      link,
      type,
      albumId,
      assetIds,
      description,
      availability.status,
      slug,
      hasPassword,
      allowDownload,
      allowUpload,
      showMetadata,
      expiresAt,
    ],
  );
  const items = useMemo(() => linkAssets(preview, assets), [preview, assets]);
  const key = created
    ? created.slug || created.id
    : preview.slug || (editing ? link.id : null);
  const url = key ? `${originBase()}?screen=public&link=${encodeURIComponent(key)}` : null;
  const announce = (message) => {
    setStatus(message);
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(""), 2500);
  };

  function submit(event) {
    event?.preventDefault();
    if (slug.trim() && availability.status !== "available") {
      setError(availability.message);
      return;
    }
    if (preset === "custom") {
      if (!expiresAt) {
        setError("Choose a date and time for the link to expire.");
        return;
      }
      if (Date.parse(expiresAt) <= now) {
        setError("Choose an expiry in the future.");
        return;
      }
    }
    const input = {
      type,
      albumId,
      assetIds,
      description: description.trim(),
      slug: slug.trim() || null,
      allowDownload,
      allowUpload,
      showMetadata,
      expiresAt,
    };
    if (editing) {
      if (removePassword) input.password = null;
      else if (password) input.password = password;
    } else input.password = password || null;
    let saved;
    try {
      saved = onSave?.(input);
    } catch (failure) {
      setError(failure?.message || "The link could not be saved.");
      return;
    }
    setError("");
    if (editing) {
      onClose?.();
      return;
    }
    setCreated(saved && typeof saved === "object" ? saved : { ...preview, id: "new-link" });
  }

  const viewerSummary = [
    `Viewers see ${items.length} ${items.length === 1 ? "item" : "items"}${
      showMetadata ? " with camera and location details" : " without camera or location details"
    }.`,
    allowDownload ? "They can download originals" : "Downloads are off",
    allowUpload ? "and can add their own photos." : ".",
    hasPassword ? "A password is required." : "No password is needed.",
    expiresAt ? `${expiryLabel(preview, now)}.` : "The link never expires.",
  ]
    .join(" ")
    .replace(/ \./g, ".");

  if (created)
    return (
      <Dialog
        title="Link ready"
        close={onClose}
        actions={
          <Button primary onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="slf-created">
          <p>
            Anyone with this address can view <strong>{created.description || name}</strong>
            {created.hasPassword ? " after entering the password" : ""}.
          </p>
          <label>
            Link address
            <input
              readOnly
              value={url}
              data-initial-focus
              onFocus={(event) => event.target.select()}
              aria-describedby={`${ids}-created-status`}
            />
          </label>
          <div className="slf-created-actions">
            <Button
              icon="mdiContentCopy"
              onClick={async () => {
                announce((await copyText(url)) ? "Link copied." : "Copying is not available here.");
              }}
            >
              Copy
            </Button>
            <Button
              icon="mdiQrcode"
              active={showQr}
              aria-pressed={showQr}
              onClick={() => setShowQr(!showQr)}
            >
              QR code
            </Button>
            <Button
              icon="mdiOpenInNew"
              onClick={() =>
                onOpen ? onOpen(created) : window.open(linkUrl(created), "_blank", "noopener")
              }
            >
              Open
            </Button>
          </div>
          {showQr && (
            <QrCode
              value={url}
              label="Shared link QR code"
              fileName={created.slug || created.id}
              showActions={false}
            />
          )}
          <Badges badges={linkBadges(created, now)} />
          <span id={`${ids}-created-status`} className="slf-status" role="status" aria-live="polite">
            {status}
          </span>
        </div>
      </Dialog>
    );

  return (
    <Dialog
      title={editing ? "Edit shared link" : "Create shared link"}
      close={onClose}
      wide
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button primary type="submit" form={formId}>
            {editing ? "Save" : "Create link"}
          </Button>
        </>
      }
    >
      <div className="slf-grid">
        <form id={formId} className="slf-fields" onSubmit={submit} noValidate>
          <label>
            Description
            <input
              data-initial-focus
              value={description}
              maxLength={500}
              placeholder="Add a title viewers will see"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>

          <div className="slf-field">
            <label htmlFor={`${ids}-password`}>Password</label>
            <div className="slf-password">
              <input
                id={`${ids}-password`}
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={password}
                maxLength={120}
                disabled={removePassword}
                placeholder={
                  editing && link.hasPassword && !removePassword
                    ? "Password set · enter a new one to replace it"
                    : "Optional"
                }
                onChange={(event) => setPassword(event.target.value)}
                aria-describedby={`${ids}-password-hint`}
              />
              <Button
                type="button"
                icon={showPassword ? "mdiEyeOffOutline" : "mdiEyeOutline"}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                onClick={() => setShowPassword(!showPassword)}
              />
            </div>
            {editing && link.hasPassword && (
              <label className="slf-inline">
                <input
                  type="checkbox"
                  checked={removePassword}
                  onChange={(event) => setRemovePassword(event.target.checked)}
                />
                Remove password
              </label>
            )}
            <small id={`${ids}-password-hint`} className="slf-hint">
              Viewers enter this before seeing anything.
            </small>
          </div>

          <div className="slf-field">
            <label htmlFor={`${ids}-slug`}>Custom address</label>
            <div className="slf-slug">
              <span aria-hidden="true">?link=</span>
              <input
                id={`${ids}-slug`}
                value={slug}
                maxLength={48}
                spellCheck={false}
                autoCapitalize="off"
                placeholder="summer-trip"
                onChange={(event) => setSlug(typingSlug(event.target.value))}
                onBlur={() => setSlug(normalizeSlug(slug))}
                aria-describedby={`${ids}-slug-hint`}
                aria-invalid={["invalid", "taken"].includes(availability.status)}
              />
            </div>
            <small
              id={`${ids}-slug-hint`}
              className="slf-hint"
              data-status={availability.status}
              role="status"
            >
              {availability.message}
            </small>
            {slugChanged && (
              <p className="slf-warning" role="status">
                <Icon name="mdiAlertOutline" size={16} />
                Changing the address breaks the previous link. Anyone using the old
                address will see “This link is not available”.
              </p>
            )}
          </div>

          <div className="slf-toggles">
            <label className="slf-toggle">
              <span>
                <strong>Allow download</strong>
                <small>Viewers can save originals, one at a time or as an archive.</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="slf-switch"
                checked={allowDownload}
                onChange={(event) => setAllowDownload(event.target.checked)}
              />
            </label>
            <label className="slf-toggle">
              <span>
                <strong>Allow upload</strong>
                <small>Viewers can add photos and videos to this share.</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="slf-switch"
                checked={allowUpload}
                onChange={(event) => setAllowUpload(event.target.checked)}
              />
            </label>
            <label className="slf-toggle">
              <span>
                <strong>Show metadata</strong>
                <small>Camera, exposure, capture time and location (EXIF).</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="slf-switch"
                checked={showMetadata}
                onChange={(event) => setShowMetadata(event.target.checked)}
              />
            </label>
          </div>

          <div className="field-pair slf-expiry">
            <label>
              Expires
              <select value={preset} onChange={(event) => setPreset(event.target.value)}>
                {EXPIRY_PRESETS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.id === "never" ? "Never" : `In ${entry.label}`}
                  </option>
                ))}
                <option value="custom">Custom date and time</option>
              </select>
            </label>
            {preset === "custom" && (
              <label>
                Expiry date and time
                <input
                  type="datetime-local"
                  value={customAt}
                  min={toLocalInputValue(new Date(now).toISOString())}
                  onChange={(event) => setCustomAt(event.target.value)}
                />
              </label>
            )}
          </div>
          <small className="slf-hint">
            {expiresAt
              ? `${expiryLabel(preview, now)} · ${new Date(expiresAt).toLocaleString()}`
              : "The link stays open until you delete it."}
          </small>
          {error && (
            <p className="slf-error" role="alert">
              <Icon name="mdiAlertCircleOutline" size={16} />
              {error}
            </p>
          )}
        </form>

        <aside className="slf-preview" aria-label="Link preview">
          <AssetCollage items={items} />
          <div className="slf-preview-body">
            <strong>{description.trim() || name}</strong>
            <small>
              {type === "album" ? `Album · ${name}` : "Individual items"} · {items.length}{" "}
              {items.length === 1 ? "item" : "items"}
            </small>
            <p className="slf-url">
              <Icon name="mdiLinkVariant" size={16} />
              {url ? (
                <span>{url}</span>
              ) : (
                <span className="muted">Address is generated when you create the link</span>
              )}
            </p>
            <Badges badges={linkBadges(preview, now)} />
            <p className="slf-summary">{viewerSummary}</p>
          </div>
        </aside>
      </div>
    </Dialog>
  );
}
