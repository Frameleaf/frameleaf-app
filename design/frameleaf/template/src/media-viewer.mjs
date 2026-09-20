// Source references: AssetViewerNavBar.svelte, asset.service.ts and slideshow.store.ts.
// Callers supply their accessible collection; this layer also fails closed on explicit privacy flags.
import { classifyLocked } from "./locked-content.mjs";

export const viewerCanShare = (asset) =>
  !!asset && asset.canShare !== false && !classifyLocked(asset);

export function viewerAssets(assets, { allowLocked = false } = {}) {
  const rows = Array.isArray(assets) ? assets : [];
  const counts = new Map();
  for (const asset of rows)
    if (asset?.id != null)
      counts.set(String(asset.id), (counts.get(String(asset.id)) || 0) + 1);
  return rows.filter(
    (asset) =>
      asset &&
      typeof asset.id === "string" &&
      asset.id &&
      counts.get(asset.id) === 1 &&
      asset.canView !== false &&
      asset.accessible !== false &&
      !asset.hidden &&
      (allowLocked || (!asset.locked && !asset.isLocked)) &&
      !asset.isTrashed &&
      !asset.trashed &&
      ![
        ...(allowLocked ? [] : ["locked"]),
        "hidden",
        "trash",
        "trashed",
      ].includes(String(asset.visibility || "").toLowerCase()) &&
      !["Deleted", "Trashed"].includes(asset.status),
  );
}
export function safeMediaSource(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\u0000-\u001f]/.test(value)
  )
    return null;
  const source = value.trim();
  if (source.startsWith("/") && !source.startsWith("//")) return source;
  if (/^blob:https?:\/\//i.test(source)) return source;
  if (/^data:image\/(png|jpeg|webp|avif|gif);base64,/i.test(source))
    return source;
  try {
    const url = new URL(source);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? source
      : null;
  } catch {
    return null;
  }
}
export function viewerMedia(asset) {
  if (!asset) return { isVideo: false, image: null, video: null };
  const isVideo =
    String(asset.type || asset.mediaType || "").toLowerCase() === "video";
  const image =
    [asset.fullSrc, asset.src, asset.image, asset.thumbnailUrl]
      .map(safeMediaSource)
      .find(Boolean) || null;
  const candidate = isVideo
    ? safeMediaSource(asset.mediaSrc || asset.videoSrc)
    : null;
  const video =
    candidate &&
    !/^data:image\//i.test(candidate) &&
    !/\.(png|jpe?g|webp|avif|gif|svg)(?:[?#]|$)/i.test(candidate)
      ? candidate
      : null;
  return { isVideo, image, video };
}
export function slideshowOrder(
  ids,
  currentId,
  shuffle = false,
  random = Math.random,
) {
  const unique = [...new Set(ids)];
  if (!shuffle) return unique;
  const others = unique.filter((id) => id !== currentId);
  for (let i = others.length - 1; i > 0; i--) {
    const value = random();
    const j = Math.max(
      0,
      Math.min(i, Math.floor((Number.isFinite(value) ? value : 0) * (i + 1))),
    );
    [others[i], others[j]] = [others[j], others[i]];
  }
  return unique.includes(currentId) ? [currentId, ...others] : others;
}
export function slideshowNeighbor(
  order,
  currentId,
  direction = 1,
  repeat = false,
) {
  const index = order.indexOf(currentId);
  if (index < 0 || order.length < 2) return null;
  const next = index + (direction < 0 ? -1 : 1);
  if (next >= 0 && next < order.length) return order[next];
  return repeat ? order[(next + order.length) % order.length] : null;
}
export function fitDimensions(width, height, viewportWidth, viewportHeight) {
  if (
    ![width, height, viewportWidth, viewportHeight].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return null;
  const scale = Math.min(1, viewportWidth / width, viewportHeight / height);
  return { width: width * scale, height: height * scale, scale };
}
export function clampPan(pan, dimensions, viewport, zoom) {
  if (!dimensions || zoom <= 1) return { x: 0, y: 0 };
  const x = Math.max(0, (dimensions.width * zoom - viewport.width) / 2);
  const y = Math.max(0, (dimensions.height * zoom - viewport.height) / 2);
  return {
    x: Math.max(-x, Math.min(x, pan.x || 0)),
    y: Math.max(-y, Math.min(y, pan.y || 0)),
  };
}
export function viewerMetadata(asset) {
  const items = [
    ["Captured", asset.takenAt || asset.date || asset.localDateTime],
    ["Camera", [asset.make, asset.model].filter(Boolean).join(" · ")],
    ["Lens", asset.lensModel],
    [
      "Dimensions",
      asset.width && asset.height
        ? `${asset.width.toLocaleString()} × ${asset.height.toLocaleString()}`
        : null,
    ],
    [
      "Location",
      [asset.city, asset.state, asset.country].filter(Boolean).join(", "),
    ],
    [
      "Exposure",
      [
        asset.fNumber ? `ƒ/${asset.fNumber}` : null,
        asset.exposureTime,
        asset.iso ? `ISO ${asset.iso}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    ],
    ["File", asset.originalFileName || asset.name],
    [
      "Folder",
      asset.originalPath
        ? asset.originalPath.slice(0, asset.originalPath.lastIndexOf("/"))
        : null,
    ],
  ];
  return items
    .filter(
      ([, value]) => value !== null && value !== undefined && value !== "",
    )
    .map(([label, value]) => ({ label, value: String(value) }));
}
