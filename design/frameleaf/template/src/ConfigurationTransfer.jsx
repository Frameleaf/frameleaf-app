import React, { useRef, useState } from "react";
import { Button } from "./App";
import {
  exportConfiguration,
  importConfiguration,
} from "./configuration-transfer.mjs";
export function ConfigurationTransfer({ settings, draft, onImport }) {
  const input = useRef(null),
    [notice, setNotice] = useState("");
  const value = () => JSON.stringify(exportConfiguration(settings), null, 2);
  function download() {
    const url = URL.createObjectURL(
      new Blob([value()], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "frameleaf-settings.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("Saved settings exported. Credentials are managed separately.");
  }
  return (
    <div className="cc-config-transfer">
      <h3>Move settings between installations</h3>
      <p>
        Export the saved configuration, or load a settings file into your draft
        to review each change. Accounts, media, credentials and pending edits
        are excluded.
      </p>
      <div className="cc-section-action">
        <Button icon="mdiDownload" onClick={download}>
          Export settings
        </Button>
        <Button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value());
              setNotice("Saved settings copied.");
            } catch {
              setNotice(
                "Clipboard access is unavailable. Use Export settings.",
              );
            }
          }}
        >
          Copy settings
        </Button>
        <Button onClick={() => input.current.click()}>Import settings</Button>
        <input
          ref={input}
          hidden
          type="file"
          accept=".json,application/json"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            try {
              if (file.size > 8 * 1024 * 1024)
                throw Error("Choose a settings file smaller than 8 MB.");
              const next = importConfiguration(await file.text(), draft);
              onImport(next);
              setNotice(
                "Settings loaded into your draft. Review changes before saving.",
              );
            } catch (error) {
              setNotice(error.message);
            }
            event.target.value = "";
          }}
        />
      </div>
      {notice && (
        <p className="cc-notice" role="status">
          {notice}
        </p>
      )}
      <details>
        <summary>What is included</summary>
        <p>
          Editable preferences and server settings. Installation-managed
          policies and hidden credentials are excluded.
        </p>
        <pre>{value()}</pre>
      </details>
    </div>
  );
}
