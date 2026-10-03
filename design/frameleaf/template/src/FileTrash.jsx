import React, { useMemo, useState } from "react";
import { Button, Dialog } from "./App";
import { Icon } from "./Icon";
import { formatBytes } from "./utilities-data.mjs";

/*
 * Library Care → File trash (universal storage). The server keeps one file per
 * content; when no library references a file any more its original waits here.
 * Nothing is deleted automatically: an administrator restores a file to the
 * library it was last in, or deletes it permanently.
 */
const SAMPLE_FILES = [
  {
    id: "ft-1",
    originalFileName: "IMG_4021.HEIC",
    sizeInBytes: 3_481_202,
    lastOwnerName: "Taylor",
    trashedAt: "2026-10-02T18:20:00Z",
  },
  {
    id: "ft-2",
    originalFileName: "Lake sunrise.mov",
    sizeInBytes: 412_903_114,
    lastOwnerName: "Jordan",
    trashedAt: "2026-09-30T08:05:00Z",
  },
  {
    id: "ft-3",
    originalFileName: "DSC_0912.NEF",
    sizeInBytes: 28_114_908,
    lastOwnerName: null,
    trashedAt: "2026-09-21T14:41:00Z",
  },
];

const dateLabel = (value) =>
  new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

export function FileTrash({ onBack = () => {}, notify = () => {} }) {
  const [files, setFiles] = useState(SAMPLE_FILES);
  const [pendingDelete, setPendingDelete] = useState(null);
  const totalBytes = useMemo(
    () => files.reduce((sum, file) => sum + file.sizeInBytes, 0),
    [files],
  );

  const restore = (file) => {
    if (!file.lastOwnerName) {
      notify("The account this file was last in no longer exists.");
      return;
    }
    setFiles((current) => current.filter((item) => item.id !== file.id));
    notify(
      `${file.originalFileName} is back in ${file.lastOwnerName}'s library.`,
    );
  };

  const remove = () => {
    setFiles((current) =>
      current.filter((item) => item.id !== pendingDelete.id),
    );
    notify(`${pendingDelete.originalFileName} was deleted permanently.`);
    setPendingDelete(null);
  };

  return (
    <main className="workspace-page file-trash">
      <button className="text-button" onClick={onBack}>
        <Icon name="mdiArrowLeft" /> Library Care
      </button>
      <p className="eyebrow">Library Care</p>
      <h1>File trash</h1>
      <p className="muted">
        Originals no library uses any more. Frameleaf keeps one copy of each
        file on the server, so a file only lands here once every library has let
        go of it. Nothing here is deleted automatically.
      </p>
      <p>
        <strong>
          {files.length} {files.length === 1 ? "file" : "files"} ·{" "}
          {formatBytes(totalBytes)} held
        </strong>
      </p>
      {files.length === 0 ? (
        <p className="muted" role="status">
          The file trash is empty.
        </p>
      ) : (
        <table className="file-trash-table">
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Size</th>
              <th scope="col">Last in</th>
              <th scope="col">Moved here</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr key={file.id}>
                <td>{file.originalFileName}</td>
                <td>{formatBytes(file.sizeInBytes)}</td>
                <td>{file.lastOwnerName ?? "Removed account"}</td>
                <td>{dateLabel(file.trashedAt)}</td>
                <td className="file-trash-actions">
                  <Button
                    disabled={!file.lastOwnerName}
                    onClick={() => restore(file)}
                  >
                    Restore
                  </Button>
                  <Button
                    className="danger"
                    onClick={() => setPendingDelete(file)}
                  >
                    Delete permanently
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pendingDelete && (
        <Dialog
          title="Delete this file permanently?"
          close={() => setPendingDelete(null)}
          actions={
            <>
              <Button onClick={() => setPendingDelete(null)}>Cancel</Button>
              <Button className="danger" onClick={remove}>
                Delete permanently
              </Button>
            </>
          }
        >
          <p>
            <strong>
              {pendingDelete.originalFileName} ·{" "}
              {formatBytes(pendingDelete.sizeInBytes)}
            </strong>
          </p>
          <p>
            The file is removed from the server's disk. This cannot be undone.
          </p>
        </Dialog>
      )}
    </main>
  );
}
