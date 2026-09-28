import React, { useEffect, useRef, useState } from "react";
import { mdiCloudOffOutline } from "@mdi/js";
import { Icon, IconPath } from "./Icon";
import { localCaptureTime } from "./explore-timeline.mjs";
import "./asset-tile.css";

const PREVIEW_DELAY = 300;
const PRESS_DELAY = 400;
const isVideo = (asset) => ["video", "VIDEO"].includes(asset?.type);
const clamp01 = (value) => Math.min(1, Math.max(0, value));
const reducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/** "m:ss" or "h:mm:ss" for a duration in seconds. */
export const durationLabel = (value) => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
};
/** Display name without the file extension. */
export const assetTitle = (asset) =>
  String(asset?.name || asset?.originalFileName || "Photo").replace(
    /\.[^.]+$/,
    "",
  );
const fileSize = (bytes) => {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "";
  return value >= 1e9
    ? `${(value / 1e9).toFixed(1)} GB`
    : `${(value / 1e6).toFixed(1)} MB`;
};

/**
 * Photo-dominant library tile shared by the timeline, Browse and Work grids.
 * Callbacks: onOpen(id, event), onToggleSelect(event), onFavorite(id),
 * onEdit(id), onShare(id), onMore(id, event).
 */
export function AssetTile({
  asset,
  selected = false,
  selecting = false,
  layout = "browse",
  rating,
  stackCount,
  onOpen,
  onToggleSelect,
  onFavorite,
  onEdit,
  onShare,
  onMore,
  showCaption = false,
  size,
  style,
  className = "",
  tabIndex,
  onFocus,
  ...rest
}) {
  const [preview, setPreview] = useState(null);
  const videoRef = useRef(null);
  const timers = useRef({ hover: 0, press: 0 });
  const pressing = useRef(false);
  const suppressClick = useRef(false);

  const video = isVideo(asset);
  const live = Boolean(asset?.isLivePhoto && asset?.livePhotoVideo);
  const previewSrc = video ? asset.mediaSrc : live ? asset.livePhotoVideo : null;
  const title = assetTitle(asset);
  const favorite = Boolean(asset?.favorite ?? asset?.isFavorite);
  const stars =
    typeof rating === "number"
      ? rating
      : typeof asset?.rating === "number"
        ? asset.rating
        : 0;
  const time = localCaptureTime(asset || {});
  const shielded = Boolean(
    asset?.isLocked || asset?.isSensitive || asset?.isSuppressed,
  );
  const stacked = Boolean(asset?.stackId);
  const stackSize = Number.isFinite(stackCount) ? stackCount : null;
  const hasActions = Boolean(onFavorite || onEdit || onShare || onMore);

  useEffect(
    () => () => {
      clearTimeout(timers.current.hover);
      clearTimeout(timers.current.press);
    },
    [],
  );
  useEffect(() => {
    const element = videoRef.current;
    if (!element || !preview) return;
    const attempt = element.play?.();
    attempt?.catch?.(() => {});
  }, [preview]);

  const beginPreview = (delay) => {
    if (!previewSrc || reducedMotion()) return;
    clearTimeout(timers.current.hover);
    timers.current.hover = setTimeout(
      () => setPreview(video ? "video" : "live"),
      delay,
    );
  };
  const endPreview = () => {
    clearTimeout(timers.current.hover);
    clearTimeout(timers.current.press);
    pressing.current = false;
    setPreview(null);
  };
  const scrub = (event) => {
    const element = videoRef.current;
    if (!element || preview !== "video") return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const fraction = clamp01((event.clientX - rect.left) / rect.width);
    const length =
      Number.isFinite(element.duration) && element.duration > 0
        ? element.duration
        : Number(asset.duration) || 0;
    if (length) element.currentTime = fraction * length;
  };
  const pointerEnter = (event) => {
    if (event.pointerType === "touch") return;
    beginPreview(PREVIEW_DELAY);
  };
  const pointerDown = (event) => {
    if (event.pointerType !== "touch" || !live) return;
    pressing.current = true;
    clearTimeout(timers.current.press);
    timers.current.press = setTimeout(() => {
      if (!pressing.current) return;
      suppressClick.current = true;
      setPreview("live");
    }, PRESS_DELAY);
  };
  const pointerUp = (event) => {
    if (event.pointerType !== "touch") return;
    endPreview();
  };
  const activate = (event) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      event.preventDefault();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || selecting)
      onToggleSelect?.(event);
    else onOpen?.(asset.id, event);
  };
  const stop = (handler) => (event) => {
    event.stopPropagation();
    handler?.(asset.id, event);
  };

  const classes = [
    "asset-tile",
    selected ? "is-selected" : "",
    selecting ? "is-selecting" : "",
    preview ? "is-previewing" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      className={classes}
      data-asset-id={asset.id}
      data-layout={layout}
      aria-selected={selected || undefined}
      style={{
        ...(Number.isFinite(size) ? { "--at-size": `${size}px` } : {}),
        ...style,
      }}
      {...rest}
    >
      <button
        type="button"
        className="at-open"
        aria-label={`Open ${title}`}
        aria-pressed={selecting ? selected : undefined}
        tabIndex={tabIndex}
        onFocus={onFocus}
        onClick={activate}
        onPointerEnter={pointerEnter}
        onPointerMove={scrub}
        onPointerLeave={endPreview}
        onPointerDown={pointerDown}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onContextMenu={(event) => {
          if (pressing.current) event.preventDefault();
        }}
      >
        <img
          src={asset.image}
          alt={title}
          loading="lazy"
          decoding="async"
          draggable="false"
        />
        {preview && previewSrc && (
          <video
            ref={videoRef}
            className="at-preview"
            src={previewSrc}
            muted
            playsInline
            loop={preview === "live"}
            preload="auto"
            aria-hidden="true"
            tabIndex={-1}
          />
        )}
        <span className="at-scrim" aria-hidden="true" />
        <span className="at-badges">
          {video && (
            <span className="at-badge at-duration">
              <Icon name="mdiPlay" size={12} />
              {durationLabel(asset.duration)}
            </span>
          )}
          {live && (
            <span className="at-badge" title="Live Photo">
              <Icon name="mdiMotionPlayOutline" size={12} />
              <span className="at-sr">Live Photo</span>
            </span>
          )}
          {asset.isPanorama && (
            <span className="at-badge at-icon-badge" title="Panorama">
              <Icon name="mdiPanoramaVariantOutline" size={13} />
              <span className="at-sr">Panorama</span>
            </span>
          )}
          {stacked && (
            <span className="at-badge" title="Stack">
              <Icon name="mdiLayersOutline" size={12} />
              {stackSize > 1 ? stackSize : null}
              <span className="at-sr">
                {stackSize > 1 ? `Stack of ${stackSize}` : "Stacked"}
              </span>
            </span>
          )}
          {shielded && (
            <span
              className="at-badge at-icon-badge"
              title={asset.isLocked ? "Locked" : "Sensitive"}
            >
              <Icon name="mdiShieldLockOutline" size={13} />
              <span className="at-sr">
                {asset.isLocked ? "Locked" : "Sensitive"}
              </span>
            </span>
          )}
          {asset.isOffline && (
            <span className="at-badge at-icon-badge" title="Offline">
              <IconPath path={mdiCloudOffOutline} size={13} />
              <span className="at-sr">Offline</span>
            </span>
          )}
          {favorite && (
            <span className="at-badge at-icon-badge at-favorite" title="Favorite">
              <Icon name="mdiHeart" size={12} />
              <span className="at-sr">Favorite</span>
            </span>
          )}
        </span>
        {stars !== 0 && (
          <span
            className="at-rating"
            aria-label={
              stars === -1 ? "Rejected" : `${stars} star${stars === 1 ? "" : "s"}`
            }
          >
            {stars === -1
              ? "Rejected"
              : Array.from({ length: Math.min(5, stars) }, (_, index) => (
                  <Icon key={index} name="mdiStar" size={11} />
                ))}
          </span>
        )}
      </button>
      <label className="at-select" onClick={(event) => event.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected}
          aria-label={`Select ${title}`}
          onChange={() => {}}
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelect?.(event);
          }}
        />
        <span aria-hidden="true">
          {selected && <Icon name="mdiCheck" size={14} />}
        </span>
      </label>
      {hasActions && !selecting && (
        <div className="at-actions" role="group" aria-label={`Actions for ${title}`}>
          {onFavorite && (
            <button
              type="button"
              className={favorite ? "is-favorite" : ""}
              aria-pressed={favorite}
              aria-label={
                favorite ? `Remove ${title} from favorites` : `Favorite ${title}`
              }
              title={favorite ? "Remove from favorites" : "Favorite"}
              onClick={stop(onFavorite)}
            >
              <Icon name={favorite ? "mdiHeart" : "mdiHeartOutline"} size={16} />
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              aria-label={`Edit ${title}`}
              title="Edit"
              onClick={stop(onEdit)}
            >
              <Icon name="mdiPencilOutline" size={16} />
            </button>
          )}
          {onShare && (
            <button
              type="button"
              aria-label={`Share ${title}`}
              title="Share"
              onClick={stop(onShare)}
            >
              <Icon name="mdiExportVariant" size={16} />
            </button>
          )}
          {onMore && (
            <button
              type="button"
              aria-label={`More actions for ${title}`}
              title="More"
              aria-haspopup="menu"
              onClick={stop(onMore)}
            >
              <Icon name="mdiDotsHorizontal" size={16} />
            </button>
          )}
        </div>
      )}
      {showCaption && layout !== "list" && (
        <div className="at-caption">
          <span title={asset.name}>{title}</span>
          {time && <time dateTime={asset.takenAt}>{time}</time>}
        </div>
      )}
      {layout === "list" && (
        <>
          <span className="at-list-name" title={asset.name}>
            {title}
          </span>
          <span className="at-list-cell">{asset.date}</span>
          <span className="at-list-cell">{video ? "Video" : "Photo"}</span>
          <span className="at-list-cell">
            {video
              ? durationLabel(asset.duration)
              : asset.width && asset.height
                ? `${asset.width} × ${asset.height}`
                : fileSize(asset.fileSizeInBytes)}
          </span>
        </>
      )}
    </article>
  );
}
