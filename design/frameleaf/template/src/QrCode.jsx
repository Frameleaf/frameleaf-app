import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { encodeQr, qrPath } from "./qr.mjs";
import "./sharing.css";

const QUIET = 4;

/** Copy text to the clipboard, falling back to a hidden textarea. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand?.("copy") ?? false;
    area.remove();
    return !!ok;
  } catch {
    return false;
  }
}

function safeFileName(name) {
  return (
    String(name || "frameleaf-link")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "frameleaf-link"
  );
}

/** Draw the matrix into a canvas and trigger a PNG download. */
export function downloadQrPng(modules, fileName, scale = 8) {
  const size = (modules.length + QUIET * 2) * scale;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return false;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "#101112";
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark)
        context.fillRect((x + QUIET) * scale, (y + QUIET) * scale, scale, scale);
    }),
  );
  const finish = (href, revoke) => {
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${safeFileName(fileName)}.png`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(href), 1000);
  };
  if (typeof canvas.toBlob === "function")
    canvas.toBlob((blob) => {
      if (blob) finish(URL.createObjectURL(blob), true);
      else finish(canvas.toDataURL("image/png"), false);
    }, "image/png");
  else finish(canvas.toDataURL("image/png"), false);
  return true;
}

/**
 * QR code for a URL, rendered as SVG with a quiet zone and optional
 * "Copy link" / "Download PNG" actions.
 */
export function QrCode({
  value,
  size = 220,
  ecc = "M",
  label = "QR code",
  fileName,
  showActions = true,
  onCopied,
}) {
  const [status, setStatus] = useState("");
  const timer = useRef(null);
  const encoded = useMemo(() => {
    try {
      return { symbol: encodeQr(String(value ?? ""), { ecc }) };
    } catch {
      return { error: "This link is too long to fit in a QR code." };
    }
  }, [value, ecc]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const announce = (message) => {
    setStatus(message);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(""), 2500);
  };
  const copy = async () => {
    const ok = await copyText(String(value ?? ""));
    announce(ok ? "Link copied." : "Copying is not available here. Select the address instead.");
    if (ok) onCopied?.();
  };
  if (encoded.error)
    return (
      <div className="qr qr-error" role="status">
        <Icon name="mdiQrcode" />
        <span>{encoded.error}</span>
      </div>
    );
  const { modules } = encoded.symbol;
  const extent = modules.length + QUIET * 2;
  return (
    <figure className="qr">
      <svg
        className="qr-svg"
        role="img"
        aria-label={`${label} for ${value}`}
        viewBox={`0 0 ${extent} ${extent}`}
        width={size}
        height={size}
        shapeRendering="crispEdges"
      >
        <rect width={extent} height={extent} fill="#ffffff" />
        <path d={qrPath(modules, QUIET)} fill="#101112" />
      </svg>
      {showActions && (
        <figcaption className="qr-actions">
          <button type="button" className="button" onClick={copy}>
            <Icon name="mdiContentCopy" />
            Copy link
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              const ok = downloadQrPng(modules, fileName || label);
              announce(ok ? "PNG saved to your downloads." : "PNG export is not available here.");
            }}
          >
            <Icon name="mdiDownloadOutline" />
            Download PNG
          </button>
        </figcaption>
      )}
      <span className="qr-status" role="status" aria-live="polite">
        {status}
      </span>
    </figure>
  );
}
