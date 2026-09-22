import React, { useState } from "react";
import { Button, Dialog } from "./App";
import { Icon } from "./Icon";
import { PersonAvatar } from "./People";
import "./sharing.css";

const possessive = (name) => {
  const value = String(name || "Partner").trim();
  return /s$/i.test(value) ? `${value}’` : `${value}’s`;
};

/**
 * Header rendered above the library grid while browsing a partner's library.
 * settings: { inTimeline: boolean, shareLocation: boolean }
 * onChange(patch): { inTimeline } | { shareLocation } | { sharing: false }
 */
export function PartnerHeader({
  partner,
  count = 0,
  settings = {},
  onChange,
  onOpenSettings,
}) {
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState("");
  const name = partner?.name || "Partner";
  const change = (patch, message) => {
    onChange?.(patch);
    setNotice(message);
  };
  return (
    <section className="ph-header" aria-label={`${possessive(name)} library`}>
      <div className="ph-identity">
        <PersonAvatar person={partner} size={48} />
        <div className="ph-copy">
          <h2>{possessive(name)} library</h2>
          <p>
            {count} {count === 1 ? "item" : "items"} · shared with you ·
            originals stay in {possessive(name)} account
          </p>
        </div>
      </div>
      <div className="ph-toggles">
        <label className="slf-toggle">
          <span>
            <strong>Show in my timeline</strong>
            <small>Mix these photos into your own library view.</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="slf-switch"
            checked={!!settings.inTimeline}
            onChange={(event) =>
              change(
                { inTimeline: event.target.checked },
                event.target.checked
                  ? `${possessive(name)} photos now appear in your timeline.`
                  : `${possessive(name)} photos stay in their own library.`,
              )
            }
          />
        </label>
        <label className="slf-toggle">
          <span>
            <strong>Partner can see my location</strong>
            <small>Applies to places recorded on the items you share back.</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="slf-switch"
            checked={!!settings.shareLocation}
            onChange={(event) =>
              change(
                { shareLocation: event.target.checked },
                event.target.checked
                  ? `${name} can see where your shared photos were taken.`
                  : `Locations are hidden from ${name}.`,
              )
            }
          />
        </label>
      </div>
      <div className="ph-actions">
        <Button icon="mdiCogOutline" onClick={() => onOpenSettings?.()}>
          Sharing settings
        </Button>
        <Button
          icon="mdiLinkOff"
          className="sl-danger"
          onClick={() => setConfirming(true)}
        >
          Stop sharing
        </Button>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {notice}
      </span>
      {confirming && (
        <Dialog
          title="Stop sharing with this partner"
          close={() => setConfirming(false)}
          actions={
            <>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button
                primary
                data-initial-focus
                onClick={() => {
                  setConfirming(false);
                  change(
                    { sharing: false },
                    `Stopped sharing with ${name}.`,
                  );
                }}
              >
                Stop sharing
              </Button>
            </>
          }
        >
          <p>
            {name} loses access to your library and their photos leave your
            timeline. Nothing is deleted from either account, and you can
            share again later from Sharing settings.
          </p>
          <p className="muted">
            <Icon name="mdiInformationOutline" size={16} /> Shared links you
            created are not affected.
          </p>
        </Dialog>
      )}
    </section>
  );
}
