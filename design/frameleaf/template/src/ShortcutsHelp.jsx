import React from "react";
import { Button, Dialog } from "./App";
import { shortcutGroups } from "./shortcuts.mjs";
import "./selection-bar.css";

/** The "?" keyboard shortcuts reference. Props: close(). */
export function ShortcutsHelp({ close }) {
  const groups = shortcutGroups();
  return (
    <Dialog
      title="Keyboard shortcuts"
      close={close}
      actions={
        <Button primary onClick={close} data-initial-focus>
          Done
        </Button>
      }
    >
      <div className="shortcuts-help">
        {groups.map((group) => (
          <section key={group.id} aria-labelledby={`shortcuts-${group.id}`}>
            <h3 id={`shortcuts-${group.id}`}>{group.title}</h3>
            <dl>
              {group.items.map((item) => (
                <div key={item.id}>
                  <dt>{item.label}</dt>
                  <dd>
                    {item.keys.map((key, index) => (
                      <React.Fragment key={`${key}-${index}`}>
                        {index > 0 && <span aria-hidden="true">+</span>}
                        <kbd>{key}</kbd>
                      </React.Fragment>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <p className="shortcuts-note">
          Shortcuts pause while you type in a field. Hold ⇧ while clicking to
          select a range.
        </p>
      </div>
    </Dialog>
  );
}
