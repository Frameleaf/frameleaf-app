import React, { useEffect, useRef, useState } from "react";
import { Button, Dialog } from "./App";
import { Icon } from "./Icon";
import { PersonAvatar } from "./People";
import { QrCode, copyText } from "./QrCode";
import { AssetCollage, Badges, SharedLinkForm, useNow } from "./SharedLinkForm";
import {
  SHARED_LINKS_KEY,
  absoluteLinkUrl,
  collectionName,
  createLink,
  deleteLink,
  isExpired,
  linkAssets,
  linkBadges,
  linkTitle,
  loadSharedLinks,
  relativeDuration,
  saveSharedLinks,
  updateLink,
} from "./shared-links-data.mjs";
import "./sharing.css";

/** Load, persist and cross-tab sync the shared links list. */
export function useSharedLinks(options = {}) {
  const [state, setState] = useState(() =>
    loadSharedLinks(globalThis.localStorage, options),
  );
  useEffect(() => {
    const changed = (event) => {
      if (event.key === SHARED_LINKS_KEY || event.key === null)
        setState(loadSharedLinks(globalThis.localStorage, options));
    };
    addEventListener("storage", changed);
    return () => removeEventListener("storage", changed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setLinks = (links) => {
    const value = { version: 1, links };
    saveSharedLinks(value);
    setState(value);
  };
  return [state.links, setLinks];
}

const collectionList = (collections) =>
  Array.isArray(collections)
    ? collections
    : Object.entries(collections || {}).map(([id, name]) => ({ id, name }));

const TABS = [
  ["all", "All"],
  ["album", "Albums"],
  ["individual", "Individual shares"],
];

/**
 * Shared links screen.
 * props: { links, assets, collections, onChange(nextLinks), onOpenPublic(link), onOpenAlbum(id) }
 */
export function SharedLinks({
  links = [],
  assets = [],
  collections = [],
  onChange,
  onOpenPublic,
  onOpenAlbum,
}) {
  const now = useNow();
  const [tab, setTab] = useState("all");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState(null);
  const [status, setStatus] = useState("");
  const [pickId, setPickId] = useState("");
  const tabRefs = useRef([]);
  const statusTimer = useRef(null);
  useEffect(() => () => clearTimeout(statusTimer.current), []);
  const state = { version: 1, links };
  const announce = (message) => {
    setStatus(message);
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(""), 4000);
  };
  const titleOf = (link) => linkTitle(link, { collections, assets });
  const needle = query.trim().toLowerCase();
  const visible = links.filter(
    (link) =>
      (tab === "all" || link.type === tab) &&
      (!needle ||
        [titleOf(link), link.description, link.slug || "", link.id]
          .join(" ")
          .toLowerCase()
          .includes(needle)),
  );
  const counts = Object.fromEntries(
    TABS.map(([id]) => [
      id,
      links.filter((link) => id === "all" || link.type === id).length,
    ]),
  );
  const options = collectionList(collections);

  const copy = async (link) => {
    const ok = await copyText(absoluteLinkUrl(link));
    announce(
      ok
        ? `Link for ${titleOf(link)} copied.`
        : "Copying is not available here.",
    );
  };
  const remove = (link) => {
    onChange?.(deleteLink(state, link.id).links);
    setDialog(null);
    announce(`Deleted the link for ${titleOf(link)}.`);
  };
  const tabKeys = (event) => {
    const index = TABS.findIndex(([id]) => id === tab);
    const delta = {
      ArrowRight: 1,
      ArrowLeft: -1,
      Home: -index,
      End: TABS.length - 1 - index,
    }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const next = (index + delta + TABS.length) % TABS.length;
    setTab(TABS[next][0]);
    tabRefs.current[next]?.focus();
  };

  return (
    <section className="sl-screen" aria-labelledby="sl-heading">
      <header className="sl-head">
        <div>
          <h1 id="sl-heading">Shared links</h1>
          <p>
            Anyone with a link can view what you shared, even without an
            account. Passwords, expiry and permissions can be changed at any
            time.
          </p>
        </div>
        <Button
          primary
          icon="mdiPlus"
          disabled={!options.length}
          onClick={() => {
            setPickId(options[0]?.id || "");
            setDialog({ kind: "pick" });
          }}
        >
          New link
        </Button>
      </header>

      <div className="sl-toolbar">
        <div
          className="sl-tabs"
          role="tablist"
          aria-label="Link types"
          onKeyDown={tabKeys}
        >
          {TABS.map(([id, label], index) => (
            <button
              key={id}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`sl-tab-${id}`}
              className="sl-tab"
              aria-selected={tab === id}
              aria-controls="sl-panel"
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
            >
              {label}
              <span className="sl-count">{counts[id]}</span>
            </button>
          ))}
        </div>
        <label className="sl-search">
          <Icon name="mdiMagnify" size={18} />
          <input
            type="search"
            value={query}
            placeholder="Search links"
            aria-label="Search shared links"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>

      <div id="sl-panel" role="tabpanel" aria-labelledby={`sl-tab-${tab}`}>
        {visible.length ? (
          <ul className="sl-grid">
            {visible.map((link) => {
              const title = titleOf(link);
              const items = linkAssets(link, assets);
              const expired = isExpired(link, now);
              return (
                <li
                  key={link.id}
                  className="sl-card"
                  data-expired={expired || undefined}
                >
                  <button
                    type="button"
                    className="sl-cover"
                    aria-label={
                      link.type === "album"
                        ? `Open album ${title}`
                        : `Open shared page for ${title}`
                    }
                    onClick={() =>
                      link.type === "album" && onOpenAlbum
                        ? onOpenAlbum(link.albumId)
                        : onOpenPublic?.(link)
                    }
                  >
                    <AssetCollage items={items} />
                    {expired && <span className="sl-cover-flag">Expired</span>}
                  </button>
                  <div className="sl-body">
                    <div className="sl-heading">
                      <h2>{title}</h2>
                      <span className="sl-type">
                        {link.type === "album" ? "Album" : "Individual"}
                      </span>
                    </div>
                    <p className="sl-desc">
                      {link.description || "No description"}
                    </p>
                    <Badges badges={linkBadges(link, now)} />
                    <p className="sl-meta">
                      Created{" "}
                      {relativeDuration(now - Date.parse(link.createdAt))} ago ·{" "}
                      {link.slug ? `?link=${link.slug}` : link.id}
                      {link.uploads.length
                        ? ` · ${link.uploads.length} ${link.uploads.length === 1 ? "upload" : "uploads"}`
                        : ""}
                    </p>
                  </div>
                  <div className="sl-actions">
                    <Button
                      icon="mdiContentCopy"
                      aria-label={`Copy link for ${title}`}
                      title="Copy link"
                      onClick={() => copy(link)}
                    />
                    <Button
                      icon="mdiQrcode"
                      aria-label={`QR code for ${title}`}
                      title="QR code"
                      onClick={() => setDialog({ kind: "qr", link })}
                    />
                    <Button
                      icon="mdiOpenInNew"
                      aria-label={`Open public page for ${title}`}
                      title="Open public page"
                      onClick={() => onOpenPublic?.(link)}
                    />
                    <span className="grow" />
                    <Button
                      icon="mdiPencilOutline"
                      onClick={() => setDialog({ kind: "edit", link })}
                    >
                      Edit
                    </Button>
                    <Button
                      icon="mdiDeleteOutline"
                      className="sl-danger"
                      onClick={() => setDialog({ kind: "delete", link })}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="empty sl-empty">
            <Icon name="mdiLinkVariant" size={40} />
            <h2>{links.length ? "No links match" : "No shared links yet"}</h2>
            <p>
              {links.length
                ? "Try another search or switch tabs."
                : "Share an album or a selection to create a link anyone can open."}
            </p>
          </div>
        )}
      </div>
      <p className="muted sl-note">Preview · sample data</p>

      {dialog?.kind === "pick" && (
        <Dialog
          title="Share an album"
          close={() => setDialog(null)}
          actions={
            <>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
              <Button
                primary
                disabled={!pickId}
                onClick={() =>
                  setDialog({
                    kind: "create",
                    target: {
                      type: "album",
                      albumId: pickId,
                      name: collectionName(collections, pickId),
                    },
                  })
                }
              >
                Continue
              </Button>
            </>
          }
        >
          <label>
            Collection
            <select
              data-initial-focus
              value={pickId}
              onChange={(event) => setPickId(event.target.value)}
            >
              {options.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            To share a few items instead, select them in the library and choose
            Share.
          </p>
        </Dialog>
      )}
      {dialog?.kind === "create" && (
        <SharedLinkForm
          target={dialog.target}
          links={links}
          assets={assets}
          onSave={(input) => {
            const result = createLink(state, input, now);
            onChange?.(result.state.links);
            announce(`Link created for ${dialog.target.name}.`);
            return result.link;
          }}
          onOpen={(link) => onOpenPublic?.(link)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "edit" && (
        <SharedLinkForm
          link={dialog.link}
          target={{
            type: dialog.link.type,
            albumId: dialog.link.albumId,
            assetIds: dialog.link.assetIds,
            name: titleOf(dialog.link),
          }}
          links={links}
          assets={assets}
          onSave={(input) => {
            const result = updateLink(state, dialog.link.id, input, now);
            onChange?.(result.state.links);
            announce(`Saved changes to ${titleOf(dialog.link)}.`);
            return result.link;
          }}
          onOpen={(link) => onOpenPublic?.(link)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "qr" && (
        <Dialog
          title={`QR code · ${titleOf(dialog.link)}`}
          close={() => setDialog(null)}
        >
          <p className="muted">
            Scan to open the shared page on another device. The address is
            embedded in the code.
          </p>
          <QrCode
            value={absoluteLinkUrl(dialog.link)}
            label={`QR code for ${titleOf(dialog.link)}`}
            fileName={dialog.link.slug || dialog.link.id}
          />
        </Dialog>
      )}
      {dialog?.kind === "delete" && (
        <Dialog
          title="Delete shared link"
          close={() => setDialog(null)}
          actions={
            <>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
              <Button
                primary
                data-initial-focus
                onClick={() => remove(dialog.link)}
              >
                Delete link
              </Button>
            </>
          }
        >
          <p>
            Anyone using the link for <strong>{titleOf(dialog.link)}</strong>{" "}
            loses access immediately. Your photos and the album itself are not
            affected.
          </p>
          {dialog.link.uploads.length > 0 && (
            <p className="muted">
              {dialog.link.uploads.length} uploaded{" "}
              {dialog.link.uploads.length === 1 ? "item stays" : "items stay"}{" "}
              in your library.
            </p>
          )}
        </Dialog>
      )}
    </section>
  );
}

/**
 * Unified Share dialog for a selection or single asset.
 * props: { assets, people, recipients, onRecipients(ids), onCreateLink(target),
 *          onClose(), onAction(kind, payload) with kind "save" | "copy" | "download" }
 */
export function ShareSheet({
  assets = [],
  people = [],
  recipients = [],
  onRecipients,
  onCreateLink,
  onClose,
  onAction,
  onSendCopy,
  owner = "Taylor",
}) {
  const [mode, setMode] = useState("people");
  const count = assets.length;
  const subject = count === 1 ? assets[0]?.name || "item" : `${count} items`;
  const photos = assets.filter((asset) => asset.type !== "video").length;
  const videos = count - photos;
  const choices = people.filter(
    (person) =>
      person.id !== owner &&
      person.name !== owner &&
      person.id !== owner.toLowerCase(),
  );
  const modes = ["people", "link"];
  const modeKeys = (event) => {
    const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
      event.key
    ];
    if (!delta) return;
    event.preventDefault();
    const next =
      modes[(modes.indexOf(mode) + delta + modes.length) % modes.length];
    setMode(next);
    event.currentTarget.querySelector(`[data-mode="${next}"]`)?.focus();
  };
  return (
    <Dialog
      title={`Share ${subject}`}
      close={onClose}
      actions={
        <>
          {onSendCopy && typeof navigator.share === "function" && (
            <Button icon="mdiExportVariant" onClick={onSendCopy}>
              Send a copy…
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          {mode === "people" ? (
            <Button primary onClick={() => onAction?.("save", recipients)}>
              {recipients.length === 1
                ? `Share with ${choices.find((person) => person.id === recipients[0])?.name || "1 person"}`
                : recipients.length > 1
                  ? `Share with ${recipients.length} people`
                  : "Save sharing"}
            </Button>
          ) : (
            <Button
              primary
              icon="mdiLinkVariant"
              onClick={() =>
                onCreateLink?.({
                  type: "individual",
                  assetIds: assets.map((asset) => asset.id),
                  name: subject,
                })
              }
            >
              Create public link
            </Button>
          )}
        </>
      }
    >
      <div className="ss-strip">
        <AssetCollage items={assets} className="ss-collage" />
        <span>
          {count} {count === 1 ? "item" : "items"}
          {count > 1 &&
            ` · ${photos} ${photos === 1 ? "photo" : "photos"}${videos ? `, ${videos} ${videos === 1 ? "video" : "videos"}` : ""}`}
        </span>
      </div>
      <div
        className="ss-options"
        role="radiogroup"
        aria-label="How to share"
        onKeyDown={modeKeys}
      >
        <button
          type="button"
          role="radio"
          data-mode="people"
          aria-checked={mode === "people"}
          tabIndex={mode === "people" ? 0 : -1}
          className="ss-option"
          onClick={() => setMode("people")}
        >
          <Icon name="mdiAccountMultipleOutline" />
          <strong>Share with people in this library</strong>
          <small>
            They see it in their own Frameleaf. Nothing leaves this server.
          </small>
        </button>
        <button
          type="button"
          role="radio"
          data-mode="link"
          aria-checked={mode === "link"}
          tabIndex={mode === "link" ? 0 : -1}
          className="ss-option"
          onClick={() => setMode("link")}
        >
          <Icon name="mdiLinkVariant" />
          <strong>Create a public link</strong>
          <small>
            Anyone with the address can view. Add a password or an expiry.
          </small>
        </button>
      </div>
      {mode === "people" ? (
        <div
          className="ss-people"
          role="group"
          aria-label="People to share with"
        >
          {choices.length ? (
            choices.map((person) => {
              const selected = recipients.includes(person.id);
              return (
                <button
                  type="button"
                  key={person.id}
                  className={`ss-person${selected ? " is-selected" : ""}`}
                  aria-pressed={selected}
                  onClick={() =>
                    onRecipients?.(
                      selected
                        ? recipients.filter((id) => id !== person.id)
                        : [...recipients, person.id],
                    )
                  }
                >
                  <span className="ss-person-avatar">
                    <PersonAvatar person={person} size={60} />
                    <span className="ss-person-check" aria-hidden="true">
                      <Icon name="mdiCheck" size={14} />
                    </span>
                  </span>
                  <span className="ss-person-name">{person.name}</span>
                </button>
              );
            })
          ) : (
            <p className="muted">No other people in this library yet.</p>
          )}
        </div>
      ) : (
        <p className="ss-link-copy">
          Choose who can download or upload, set a password, and pick when the
          link expires. You can change these later from Shared links.
        </p>
      )}
      <div className="ss-shortcuts">
        <Button
          icon="mdiContentCopy"
          disabled={count !== 1 || assets[0]?.type === "video"}
          onClick={() => onAction?.("copy", assets)}
        >
          Copy image
        </Button>
        <Button
          icon="mdiDownloadOutline"
          onClick={() => onAction?.("download", assets)}
        >
          Download
        </Button>
      </div>
    </Dialog>
  );
}
