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
 * Header rendered above the grid of items copied from a partner's library.
 * The copies are the viewer's own; there are no timeline or location toggles.
 * onChange(patch): { sharing: false }
 */
export function PartnerHeader({ partner, count = 0, onChange, onOpenSettings }) {
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState("");
  const name = partner?.name || "Partner";
  const change = (patch, message) => {
    onChange?.(patch);
    setNotice(message);
  };
  return (
    <section className="ph-header" aria-label={`From ${possessive(name)} library`}>
      <div className="ph-identity">
        <PersonAvatar person={partner} size={48} />
        <div className="ph-copy">
          <h2>From {possessive(name)} library</h2>
          <p>
            {count} {count === 1 ? "item" : "items"} · copies in your library ·
            they follow {possessive(name)} edits until you change them
          </p>
        </div>
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
            New photos and edits stop reaching {name}. {name} keeps everything
            already copied into their library, and the copies you received stay
            yours. You can share again later from Sharing settings.
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
