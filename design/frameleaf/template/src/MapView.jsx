import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "./Icon";
import { Button } from "./App";
import { captureDate, videoAsset } from "./explore-timeline.mjs";
import {
  boundsCenter,
  boundsFor,
  clusterAssets,
  defaultMapSettings,
  filterMapAssets,
  formatDegrees,
  graticuleLines,
  inBounds,
  located,
  mapDatePresets,
  mapLakes,
  mapPlaces,
  mapRoads,
  project,
  terrainFeatures,
  unproject,
  viewportBounds,
  zoomToFit,
} from "./discovery-data.mjs";
import "./map-view.css";

const MIN_ZOOM = 3;
const MAX_ZOOM = 16;
const clampZoom = (zoom) =>
  Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom * 2) / 2));
const isoToday = () => new Date().toISOString().slice(0, 10);
const countLabel = (count, word = "item") =>
  `${count} ${count === 1 ? word : `${word}s`}`;

/** Catmull-Rom → cubic Bézier closed path for organic contour shapes. */
function smoothPath(points) {
  if (points.length < 3) return "";
  const n = points.length;
  let d = `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n],
      p1 = points[i],
      p2 = points[(i + 1) % n],
      p3 = points[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return `${d} Z`;
}

function useElementSize(ref, fallback) {
  const [size, setSize] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0)
        setSize((current) =>
          current.measured &&
          Math.abs(current.width - rect.width) < 1 &&
          Math.abs(current.height - rect.height) < 1
            ? current
            : { width: rect.width, height: rect.height, measured: true },
        );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener?.("resize", measure);
      return () => window.removeEventListener?.("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function Switch({ checked, onChange, children, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`map-switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span className="map-switch-track" aria-hidden="true" />
      <span>{children}</span>
    </button>
  );
}

const clusterRadius = (cluster) =>
  cluster.count === 1 ? 21 : 18 + Math.min(cluster.count, 40) * 0.45;

/** Base terrain, lakes, roads, graticule and labels: purely decorative, offline. */
function BaseLayer({ bounds, size, zoom, terrain, blurId, showLabels = true, clusters = [] }) {
  const at = (lat, lng) => project(lat, lng, bounds, size);
  const origin = at(bounds.north, bounds.west);
  const unit = at(bounds.north - 0.1, bounds.west + 0.1);
  const pxLng = Math.abs(unit.x - origin.x) * 10;
  const pxLat = Math.abs(unit.y - origin.y) * 10;
  const grid = graticuleLines(bounds, zoom);
  const visible = (p, pad = 40) =>
    p.x > -pad && p.y > -pad && p.x < size.width + pad && p.y < size.height + pad;
  const contourPoints = (feature, factor) =>
    feature.wobble.map((w, k) => {
      const angle = (k / feature.wobble.length) * Math.PI * 2;
      const rx = feature.rx * pxLng * factor * w;
      const ry = feature.ry * pxLat * factor * w;
      const rad = (feature.rotate * Math.PI) / 180;
      const x = Math.cos(angle) * rx,
        y = Math.sin(angle) * ry;
      const center = at(feature.lat, feature.lng);
      return [
        center.x + x * Math.cos(rad) - y * Math.sin(rad),
        center.y + x * Math.sin(rad) + y * Math.cos(rad),
      ];
    });
  const labelRank = zoom >= 10 ? 3 : zoom >= 8.5 ? 2 : 1;
  return (
    <g className="map-base" aria-hidden="true">
      <rect className="map-ground" x="0" y="0" width={size.width} height={size.height} />
      <g filter={`url(#${blurId})`} className="map-terrain">
        {terrain.map((feature, index) => {
          const center = at(feature.lat, feature.lng);
          const rx = feature.rx * pxLng,
            ry = feature.ry * pxLat;
          if (!visible(center, rx + ry)) return null;
          return (
            <ellipse
              key={index}
              className={`map-${feature.kind}`}
              cx={center.x}
              cy={center.y}
              rx={rx}
              ry={ry}
              transform={`rotate(${feature.rotate} ${center.x} ${center.y})`}
            />
          );
        })}
      </g>
      {zoom >= 7 && (
        <g className="map-contours">
          {terrain.map((feature, index) =>
            feature.contours
              ? Array.from({ length: feature.contours }, (_, level) => {
                  const factor = 1 - level * 0.3;
                  const points = contourPoints(feature, factor);
                  if (!points.some((p) => visible({ x: p[0], y: p[1] }, 200))) return null;
                  return <path key={`${index}-${level}`} d={smoothPath(points)} />;
                })
              : null,
          )}
        </g>
      )}
      <g className="map-roads">
        {mapRoads.map((road, index) => (
          <polyline
            key={index}
            points={road
              .map(([lat, lng]) => {
                const p = at(lat, lng);
                return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
              })
              .join(" ")}
          />
        ))}
      </g>
      <g className="map-lakes">
        {mapLakes.map((lake) => {
          const center = at(lake.lat, lake.lng);
          const rx = Math.max(2, lake.rx * pxLng),
            ry = Math.max(2, lake.ry * pxLat);
          if (!visible(center, rx + ry)) return null;
          return (
            <g key={lake.name}>
              <ellipse cx={center.x} cy={center.y} rx={rx} ry={ry} />
              {zoom >= 10.5 && rx > 14 && (
                <text x={center.x} y={center.y + ry + 13} textAnchor="middle">
                  {lake.name}
                </text>
              )}
            </g>
          );
        })}
      </g>
      <g className="map-graticule">
        {grid.lat.map((lat) => {
          const y = at(lat, bounds.west).y;
          return (
            <g key={`lat${lat}`}>
              <line x1={0} y1={y} x2={size.width} y2={y} />
              <text x={6} y={y - 4}>
                {formatDegrees(lat, "lat")}
              </text>
            </g>
          );
        })}
        {grid.lng.map((lng) => {
          const x = at(bounds.north, lng).x;
          return (
            <g key={`lng${lng}`}>
              <line x1={x} y1={0} x2={x} y2={size.height} />
              <text x={x + 4} y={size.height - 6}>
                {formatDegrees(lng, "lng")}
              </text>
            </g>
          );
        })}
      </g>
      {showLabels && (
        <g className="map-labels">
          {mapPlaces
            .filter((place) => place.rank <= labelRank)
            .map((place) => {
              const p = at(place.lat, place.lng);
              if (!visible(p, 0)) return null;
              // Start the name past any cluster bubble drawn over this place.
              // Clusters sit at their photos' average, a little off the place dot.
              const bubble = clusters.find(
                (c) => Math.hypot(c.x - p.x, c.y - p.y) < clusterRadius(c) + 24,
              );
              const labelX = Math.max(
                p.x + 7,
                bubble ? bubble.x + clusterRadius(bubble) + 6 : 0,
              );
              return (
                <g key={place.id} className={`map-label rank-${place.rank}`}>
                  <circle cx={p.x} cy={p.y} r={place.rank === 1 ? 3 : 2} />
                  <text x={labelX} y={p.y + 4}>
                    {place.name}
                  </text>
                </g>
              );
            })}
        </g>
      )}
    </g>
  );
}

export function MapView({
  assets = [],
  onOpenAsset,
  onQuery,
  settings,
  onSettings,
  highlightId = null,
  focus = null,
  static: isStatic = false,
  today = isoToday(),
  title = "Map",
  className = "",
}) {
  const container = useRef(null);
  const stage = useRef(null);
  const gearButton = useRef(null);
  const size = useElementSize(container, {
    width: isStatic ? 320 : 960,
    height: isStatic ? 180 : 560,
    measured: false,
  });
  const blurId = useId();
  const clipId = useId();
  const helpId = useId();
  const liveId = useId();
  const [localSettings, setLocalSettings] = useState(defaultMapSettings);
  const current = useMemo(
    () => ({ ...defaultMapSettings, ...localSettings, ...(settings || {}) }),
    [localSettings, settings],
  );
  const patchSettings = (patch) => {
    setLocalSettings((value) => ({ ...value, ...patch }));
    onSettings?.(patch);
  };
  const filtered = useMemo(
    () => (isStatic ? assets.filter(located) : filterMapAssets(assets, current, today)),
    [assets, current, today, isStatic],
  );
  const extent = useMemo(() => boundsFor(filtered), [filtered]);
  const terrain = useMemo(() => terrainFeatures(), []);
  const [view, setView] = useState(() => ({
    center: boundsCenter(extent),
    zoom: zoomToFit(extent, size, isStatic ? 12 : 48),
  }));
  const [changed, setChanged] = useState(false);
  const [hover, setHover] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [status, setStatus] = useState("");
  const drag = useRef(null);
  const fitted = useRef(false);

  const fitAll = useCallback(
    (target = extent, announce = true) => {
      setView({
        center: boundsCenter(target),
        zoom: zoomToFit(target, size, isStatic ? 12 : 48),
      });
      setChanged(false);
      if (announce) setStatus("Map view reset to all located items.");
    },
    [extent, size, isStatic],
  );

  // Fit once the container is measured; static thumbnails always fit their assets.
  useEffect(() => {
    if (!size.measured && !isStatic) return;
    if (isStatic) {
      fitAll(extent, false);
      return;
    }
    if (fitted.current) return;
    fitted.current = true;
    const target = highlightId && filtered.find((asset) => asset.id === highlightId);
    if (target)
      setView({ center: { lat: target.latitude, lng: target.longitude }, zoom: 12 });
    else fitAll(extent, false);
  }, [size.measured, isStatic, extent, filtered, highlightId, fitAll]);

  // External focus requests (a city from Places, a highlighted asset).
  useEffect(() => {
    if (!focus) return;
    if (typeof focus === "string") {
      const place = mapPlaces.find((p) => p.name.toLowerCase() === focus.toLowerCase());
      const own = filtered.filter((a) => a.city === focus);
      if (own.length) fitAll(boundsFor(own, 0.4), false);
      else if (place) setView({ center: { lat: place.lat, lng: place.lng }, zoom: 11 });
      setChanged(true);
    } else if (Number.isFinite(focus.lat) && Number.isFinite(focus.lng)) {
      setView({
        center: { lat: focus.lat, lng: focus.lng },
        zoom: clampZoom(focus.zoom ?? 12),
      });
      setChanged(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const bounds = useMemo(
    () => viewportBounds(view.center, view.zoom, size),
    [view, size],
  );
  const clusters = useMemo(
    () => clusterAssets(filtered, { bounds, size, radius: isStatic ? 26 : 46 }),
    [filtered, bounds, size, isStatic],
  );
  const inView = useMemo(
    () => filtered.filter((asset) => inBounds(asset, bounds)),
    [filtered, bounds],
  );
  const counts = useMemo(
    () => ({
      photos: inView.filter((a) => !videoAsset(a)).length,
      videos: inView.filter(videoAsset).length,
      archived: assets.filter((a) => located(a) && a.visibility === "archive").length,
      partner: assets.filter((a) => located(a) && a.ownerId && a.ownerId !== "taylor").length,
      unlocated: assets.filter((a) => !located(a)).length,
    }),
    [inView, assets],
  );

  const setZoomAt = (delta, px = size.width / 2, py = size.height / 2) => {
    setView((state) => {
      const zoom = clampZoom(state.zoom + delta);
      if (zoom === state.zoom) return state;
      const before = viewportBounds(state.center, state.zoom, size);
      const anchor = unproject(px, py, before, size);
      const after = viewportBounds(state.center, zoom, size);
      const moved = project(anchor.lat, anchor.lng, after, size);
      const center = unproject(
        size.width / 2 + (moved.x - px),
        size.height / 2 + (moved.y - py),
        after,
        size,
      );
      return { center, zoom };
    });
    setChanged(true);
  };
  const panBy = (dx, dy) => {
    setView((state) => {
      const current = viewportBounds(state.center, state.zoom, size);
      return {
        ...state,
        center: unproject(size.width / 2 + dx, size.height / 2 + dy, current, size),
      };
    });
    setChanged(true);
  };
  const localPoint = (event) => {
    const rect = stage.current.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const startDrag = (event) => {
    if (isStatic || event.button !== 0 || event.target.closest?.("[data-cluster]")) return;
    const point = localPoint(event);
    drag.current = { ...point, center: view.center, bounds, moved: false };
    stage.current.setPointerCapture?.(event.pointerId);
  };
  const moveDrag = (event) => {
    if (!drag.current) return;
    const point = localPoint(event);
    const dx = point.x - drag.current.x,
      dy = point.y - drag.current.y;
    if (!drag.current.moved && Math.hypot(dx, dy) < 3) return;
    drag.current.moved = true;
    const center = unproject(size.width / 2 - dx, size.height / 2 - dy, drag.current.bounds, size);
    setView((state) => ({ ...state, center }));
    setChanged(true);
  };
  const endDrag = () => {
    drag.current = null;
  };
  const wheel = (event) => {
    if (isStatic) return;
    event.preventDefault();
    const point = localPoint(event);
    setZoomAt(event.deltaY < 0 ? 0.5 : -0.5, point.x, point.y);
  };
  useEffect(() => {
    const element = stage.current;
    if (!element || isStatic) return undefined;
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, isStatic]);

  const openCluster = (cluster) => {
    if (cluster.count === 1) {
      onOpenAsset?.(cluster.assetIds[0]);
      return;
    }
    const members = filtered.filter((asset) => cluster.assetIds.includes(asset.id));
    const target = boundsFor(members, 0.35);
    const zoom = zoomToFit(target, size, 80);
    setView({
      center: { lat: cluster.lat, lng: cluster.lng },
      zoom: clampZoom(zoom > view.zoom ? zoom : view.zoom + 2),
    });
    setChanged(true);
    setStatus(`Zoomed in to ${countLabel(cluster.count)}${cluster.place ? ` near ${cluster.place}` : ""}.`);
  };
  const keyboard = (event) => {
    if (isStatic) return;
    if (event.target !== event.currentTarget && !event.target.closest?.("[data-cluster]")) return;
    const step = event.shiftKey ? 240 : 80;
    const actions = {
      ArrowUp: () => panBy(0, -step),
      ArrowDown: () => panBy(0, step),
      ArrowLeft: () => panBy(-step, 0),
      ArrowRight: () => panBy(step, 0),
      "+": () => setZoomAt(0.5),
      "=": () => setZoomAt(0.5),
      "-": () => setZoomAt(-0.5),
      _: () => setZoomAt(-0.5),
      Home: () => fitAll(),
      "0": () => fitAll(),
    };
    if (actions[event.key]) {
      event.preventDefault();
      actions[event.key]();
    }
  };
  const searchArea = () => {
    onQuery?.(
      {
        bounds: {
          north: Number(bounds.north.toFixed(5)),
          south: Number(bounds.south.toFixed(5)),
          east: Number(bounds.east.toFixed(5)),
          west: Number(bounds.west.toFixed(5)),
        },
      },
      "Map area",
    );
    setChanged(false);
    setStatus(`Searching ${countLabel(inView.length)} in this area.`);
  };
  const locate = (asset) => {
    setView({ center: { lat: asset.latitude, lng: asset.longitude }, zoom: Math.max(view.zoom, 12) });
    setChanged(true);
    setStatus(`Centred on ${asset.name || asset.originalFileName}.`);
  };
  useEffect(() => {
    if (!settingsOpen) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
        gearButton.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  const hovered = hover && clusters.find((cluster) => cluster.id === hover);
  const cardLeft = hovered ? Math.min(Math.max(hovered.x - 90, 8), size.width - 188) : 0;
  const cardAbove = hovered ? hovered.y > 150 : false;
  const listOpen = current.assetPanel && !isStatic;
  const locatedCount = filtered.length;

  if (isStatic)
    return (
      <div
        ref={container}
        className={`map-view static ${className}`}
        role="img"
        aria-label={`Map with ${countLabel(locatedCount)}`}
      >
        <svg width={size.width} height={size.height} aria-hidden="true">
          <defs>
            <filter id={blurId} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="10" />
            </filter>
          </defs>
          <BaseLayer bounds={bounds} size={size} zoom={view.zoom} terrain={terrain} blurId={blurId} showLabels={size.width > 220} clusters={clusters} />
          <g className="map-markers">
            {clusters.map((cluster) => (
              <g key={cluster.id} className="map-dot">
                <circle cx={cluster.x} cy={cluster.y} r={cluster.count > 1 ? 9 : 5} />
                {cluster.count > 1 && (
                  <text x={cluster.x} y={cluster.y + 3.5} textAnchor="middle">
                    {cluster.count}
                  </text>
                )}
              </g>
            ))}
          </g>
        </svg>
      </div>
    );

  return (
    <div className={`map-view ${listOpen ? "with-list" : ""} ${className}`} ref={container}>
      <div
        className="map-stage"
        ref={stage}
        role="region"
        aria-label={`${title}: ${countLabel(inView.length)} in view`}
        aria-describedby={helpId}
        tabIndex={0}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(event) => {
          if (event.target.closest?.("[data-cluster]") || event.target.closest?.("button")) return;
          const point = localPoint(event);
          setZoomAt(1, point.x, point.y);
        }}
        onKeyDown={keyboard}
        style={{ cursor: drag.current ? "grabbing" : "grab" }}
      >
        <svg width={size.width} height={size.height} className="map-svg">
          <defs>
            <filter id={blurId} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="14" />
            </filter>
            <clipPath id={clipId}>
              <circle cx="0" cy="0" r="19" />
            </clipPath>
          </defs>
          <BaseLayer bounds={bounds} size={size} zoom={view.zoom} terrain={terrain} blurId={blurId} clusters={clusters} />
          <g className="map-markers">
            {clusters.map((cluster) => {
              const radius = clusterRadius(cluster);
              const highlighted = highlightId && cluster.assetIds.includes(highlightId);
              const label =
                cluster.count === 1
                  ? `Open ${cluster.cover?.name || cluster.cover?.originalFileName || "item"}${cluster.place ? `, ${cluster.place}` : ""}`
                  : `${countLabel(cluster.count)}${cluster.place ? ` near ${cluster.place}` : ""}. Zoom in`;
              return (
                <g
                  key={cluster.id}
                  data-cluster={cluster.id}
                  className={`map-cluster${cluster.count === 1 ? " single" : ""}${highlighted ? " highlighted" : ""}${hover === cluster.id ? " hovered" : ""}`}
                  transform={`translate(${cluster.x.toFixed(1)} ${cluster.y.toFixed(1)})`}
                  role="button"
                  tabIndex={0}
                  aria-label={label}
                  onClick={(event) => {
                    event.stopPropagation();
                    openCluster(cluster);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      openCluster(cluster);
                    }
                  }}
                  onPointerEnter={() => setHover(cluster.id)}
                  onPointerLeave={() => setHover((value) => (value === cluster.id ? null : value))}
                  onFocus={() => setHover(cluster.id)}
                  onBlur={() => setHover((value) => (value === cluster.id ? null : value))}
                >
                  {highlighted && <circle className="map-cluster-halo" r={radius + 8} />}
                  <circle className="map-cluster-ring" r={radius} />
                  {cluster.count === 1 && cluster.cover?.image ? (
                    <image
                      href={cluster.cover.image}
                      x={-19}
                      y={-19}
                      width={38}
                      height={38}
                      preserveAspectRatio="xMidYMid slice"
                      clipPath={`url(#${clipId})`}
                    />
                  ) : (
                    <text textAnchor="middle" dy="0.35em" className="map-cluster-count">
                      {cluster.count}
                    </text>
                  )}
                  {cluster.count === 1 && videoAsset(cluster.cover) && (
                    <circle className="map-cluster-video" cx={14} cy={-14} r={6} />
                  )}
                </g>
              );
            })}
          </g>
        </svg>
        {hovered && (
          <div
            className={`map-card${cardAbove ? " above" : ""}`}
            style={{ left: cardLeft, top: cardAbove ? hovered.y - 22 : hovered.y + 28 }}
            aria-hidden="true"
          >
            {hovered.cover?.image ? (
              <img src={hovered.cover.image} alt="" />
            ) : (
              <span className="map-card-empty">
                <Icon name="mdiImageOutline" size={20} />
              </span>
            )}
            <span>
              <strong>
                {hovered.count === 1
                  ? hovered.cover?.name || hovered.cover?.originalFileName
                  : countLabel(hovered.count)}
              </strong>
              <small>
                {hovered.count === 1
                  ? [captureDate(hovered.cover)?.day, hovered.place].filter(Boolean).join(" · ")
                  : hovered.place || `${hovered.lat.toFixed(3)}, ${hovered.lng.toFixed(3)}`}
              </small>
            </span>
          </div>
        )}
        <p id={helpId} className="map-sr-only">
          Drag or use the arrow keys to pan. Use plus and minus to zoom, Home to show
          everything, and Tab to move between markers.
        </p>
        <div className="map-overlay map-top-left">
          <span className="map-chip">
            <Icon name="mdiMapMarkerMultipleOutline" size={16} />
            {countLabel(inView.length)} in view
            <small>· {locatedCount} located</small>
          </span>
        </div>
        {changed && (
          <div className="map-overlay map-top-center">
            <Button primary icon="mdiMagnify" onClick={searchArea}>
              Search this area
            </Button>
          </div>
        )}
        <div className="map-overlay map-tools" role="toolbar" aria-label="Map tools">
          <Button aria-label="Zoom in" title="Zoom in" icon="mdiPlus" onClick={() => setZoomAt(0.5)} disabled={view.zoom >= MAX_ZOOM} />
          <Button aria-label="Zoom out" title="Zoom out" icon="mdiMinus" onClick={() => setZoomAt(-0.5)} disabled={view.zoom <= MIN_ZOOM} />
          <Button aria-label="Show all items" title="Show all items" icon="mdiArrowExpandAll" onClick={() => fitAll()} />
          <Button
            aria-label={listOpen ? "Hide list" : "Show list"}
            title={listOpen ? "Hide list" : "Show list"}
            icon="mdiViewListOutline"
            aria-pressed={listOpen}
            active={listOpen}
            onClick={() => patchSettings({ assetPanel: !listOpen })}
          />
          <Button
            ref={gearButton}
            aria-label="Map settings"
            title="Map settings"
            icon="mdiCogOutline"
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            active={settingsOpen}
            onClick={() => setSettingsOpen((value) => !value)}
          />
        </div>
        <div className="map-overlay map-legend" aria-label="Legend">
          <span>
            <i className="map-legend-dot small" /> 1
          </span>
          <span>
            <i className="map-legend-dot" /> 2–9
          </span>
          <span>
            <i className="map-legend-dot large" /> 10+
          </span>
          <span className="map-legend-counts">
            {countLabel(counts.photos, "photo")} · {countLabel(counts.videos, "video")}
          </span>
        </div>
        <div className="map-overlay map-attribution">
          Offline map preview · zoom {view.zoom.toFixed(1)}
        </div>
        {settingsOpen && (
          <div className="map-settings" role="dialog" aria-label="Map settings">
            <header>
              <strong>Map settings</strong>
              <Button
                aria-label="Close map settings"
                icon="mdiClose"
                onClick={() => {
                  setSettingsOpen(false);
                  gearButton.current?.focus();
                }}
              />
            </header>
            <fieldset>
              <legend>Date range</legend>
              <div className="map-presets" role="radiogroup" aria-label="Date range">
                {mapDatePresets.map((preset) => (
                  <button
                    type="button"
                    key={preset.id}
                    role="radio"
                    aria-checked={current.datePreset === preset.id}
                    className={current.datePreset === preset.id ? "on" : ""}
                    onClick={() => patchSettings({ datePreset: preset.id })}
                    data-initial-focus={preset.id === current.datePreset || undefined}
                    autoFocus={preset.id === current.datePreset}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              {current.datePreset === "custom" && (
                <div className="map-dates">
                  <label>
                    From
                    <input
                      type="date"
                      value={current.from}
                      max={current.to || undefined}
                      onChange={(event) => patchSettings({ from: event.target.value })}
                    />
                  </label>
                  <label>
                    To
                    <input
                      type="date"
                      value={current.to}
                      min={current.from || undefined}
                      onChange={(event) => patchSettings({ to: event.target.value })}
                    />
                  </label>
                </div>
              )}
            </fieldset>
            <fieldset>
              <legend>Include</legend>
              <Switch checked={current.includeArchived} onChange={(value) => patchSettings({ includeArchived: value })}>
                Archived items <small>{counts.archived}</small>
              </Switch>
              <Switch checked={current.includeShared} onChange={(value) => patchSettings({ includeShared: value })}>
                Shared spaces
              </Switch>
              <Switch checked={current.includePartner} onChange={(value) => patchSettings({ includePartner: value })}>
                Partner items <small>{counts.partner}</small>
              </Switch>
              <Switch checked={current.onlyFavorites} onChange={(value) => patchSettings({ onlyFavorites: value })}>
                Only favorites
              </Switch>
              <Switch checked={current.assetPanel} onChange={(value) => patchSettings({ assetPanel: value })}>
                Asset panel on map
              </Switch>
            </fieldset>
            <dl className="map-settings-counts">
              <div>
                <dt>Located</dt>
                <dd>{locatedCount}</dd>
              </div>
              <div>
                <dt>In view</dt>
                <dd>{inView.length}</dd>
              </div>
              <div>
                <dt>No location</dt>
                <dd>{counts.unlocated}</dd>
              </div>
            </dl>
          </div>
        )}
        <output id={liveId} className="map-sr-only" aria-live="polite">
          {status}
        </output>
      </div>
      {listOpen && (
        <aside className="map-list" aria-label="Items in view">
          <header>
            <strong>In view</strong>
            <small>{countLabel(inView.length)}</small>
            <Button aria-label="Hide list" icon="mdiClose" onClick={() => patchSettings({ assetPanel: false })} />
          </header>
          {inView.length ? (
            <ul>
              {inView.map((asset) => (
                <li key={asset.id}>
                  <button type="button" className="map-row" onClick={() => onOpenAsset?.(asset.id)}>
                    {asset.image ? <img src={asset.image} alt="" loading="lazy" /> : <span className="map-row-empty" />}
                    <span>
                      <strong>{asset.name || asset.originalFileName}</strong>
                      <small>
                        {[captureDate(asset)?.day, asset.city].filter(Boolean).join(" · ")}
                        {videoAsset(asset) ? " · Video" : ""}
                      </small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="map-row-locate"
                    aria-label={`Centre map on ${asset.name || asset.originalFileName}`}
                    title="Centre on map"
                    onClick={() => locate(asset)}
                  >
                    <Icon name="mdiCrosshairsGps" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="map-list-empty" role="status">
              Nothing in this part of the map. Zoom out or choose Show all items.
            </p>
          )}
        </aside>
      )}
      {!locatedCount && (
        <div className="map-empty" role="status">
          <Icon name="mdiMapMarkerOutline" size={30} />
          <strong>No located items match these settings</strong>
          <p>Widen the date range or include archived items to see them here.</p>
        </div>
      )}
    </div>
  );
}
