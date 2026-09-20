import React, { useId, useState } from "react";
import { Button } from "./App";
import {
  coordinateBounds,
  pickCoordinates,
  offsetCoordinates,
  ownerName,
} from "./utilities-data.mjs";
import "./utility-map-picker.css";
const valid = (value) =>
  (typeof value === "number" ||
    (typeof value === "string" && value.trim() !== "")) &&
  Number.isFinite(Number(value));
export function UtilityMapPicker({
  latitude,
  longitude,
  onChange,
  photos = [],
}) {
  const [center, setCenter] = useState({ latitude: 51.36, longitude: -116.18 }),
    [zoom, setZoom] = useState(1);
  const help = useId();
  const bounds = coordinateBounds(center.latitude, center.longitude, zoom);
  const locationValid =
    valid(latitude) &&
    valid(longitude) &&
    Math.abs(Number(latitude)) <= 90 &&
    Math.abs(Number(longitude)) <= 180;
  const selected = locationValid
    ? { latitude: Number(latitude), longitude: Number(longitude) }
    : null;
  const inside = (point) =>
    point &&
    point.latitude >= bounds.south &&
    point.latitude <= bounds.north &&
    point.longitude >= bounds.west &&
    point.longitude <= bounds.east;
  const point = (position) => ({
    x: (640 * (position.longitude - bounds.west)) / (bounds.east - bounds.west),
    y:
      (400 * (bounds.north - position.latitude)) /
      (bounds.north - bounds.south),
  });
  const marker = selected && point(selected);
  function choose(next) {
    onChange(next.latitude, next.longitude);
  }
  function move(direction, large = false) {
    choose(
      offsetCoordinates(
        selected?.latitude ?? center.latitude,
        selected?.longitude ?? center.longitude,
        direction,
        (large ? 0.01 : 0.001) / zoom,
      ),
    );
  }
  function click(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width && rect.height)
      choose(
        pickCoordinates(
          bounds,
          (event.clientX - rect.left) / rect.width,
          (event.clientY - rect.top) / rect.height,
        ),
      );
  }
  const known = photos.filter(
    (photo) =>
      Number.isFinite(photo.latitude) &&
      Number.isFinite(photo.longitude) &&
      inside(photo),
  );
  return (
    <div className="um-map-picker">
      <div className="um-map-heading">
        <div>
          <strong>Coordinate map</strong>
          <small>
            WGS 84 ·{" "}
            {zoom === 1 && center.latitude === 51.36
              ? "Banff area"
              : "Selected region"}
          </small>
        </div>
        <div>
          <Button
            aria-label="Zoom out"
            disabled={zoom <= 1}
            onClick={() => setZoom((value) => Math.max(1, value / 2))}
          >
            −
          </Button>
          <Button
            aria-label="Zoom in"
            disabled={zoom >= 8}
            onClick={() => setZoom((value) => Math.min(8, value * 2))}
          >
            +
          </Button>
        </div>
      </div>
      <svg
        viewBox="0 0 640 400"
        preserveAspectRatio="none"
        role="group"
        tabIndex={0}
        aria-label="Choose a photo location on the coordinate map"
        aria-describedby={help}
        onClick={click}
        onKeyDown={(event) => {
          const direction = {
            ArrowUp: "north",
            ArrowDown: "south",
            ArrowLeft: "west",
            ArrowRight: "east",
          }[event.key];
          if (direction) {
            event.preventDefault();
            move(direction, event.shiftKey);
          }
        }}
      >
        <rect
          x="0"
          y="0"
          width="640"
          height="400"
          className="um-map-background"
        />
        {[0, 1, 2, 3, 4].map((index) => (
          <g key={index} aria-hidden="true">
            <line x1={index * 160} y1={0} x2={index * 160} y2={400} />
            <line x1={0} y1={index * 100} x2={640} y2={index * 100} />
            <text x={Math.min(580, index * 160 + 7)} y={389}>
              {(
                bounds.west +
                ((bounds.east - bounds.west) * index) / 4
              ).toFixed(3)}
              °
            </text>
            {index < 4 && (
              <text x={7} y={index * 100 + 16}>
                {(
                  bounds.north -
                  ((bounds.north - bounds.south) * index) / 4
                ).toFixed(3)}
                °
              </text>
            )}
          </g>
        ))}
        {known.map((photo) => {
          const position = point(photo);
          return (
            <g
              key={photo.id}
              tabIndex={0}
              role="button"
              aria-label={`Use ${photo.name} location, ${ownerName(photo.ownerId)}`}
              onClick={(event) => {
                event.stopPropagation();
                choose(photo);
              }}
              onKeyDown={(event) => {
                if (["Enter", " "].includes(event.key)) {
                  event.preventDefault();
                  event.stopPropagation();
                  choose(photo);
                }
              }}
              className="um-map-photo"
            >
              <circle cx={position.x} cy={position.y} r={12} />
              <text x={position.x} y={position.y + 4} textAnchor="middle">
                ●
              </text>
              <title>{`${photo.name} · ${ownerName(photo.ownerId)}`}</title>
            </g>
          );
        })}
        {inside(selected) && (
          <g
            className="um-map-selected"
            aria-hidden="true"
            style={{ pointerEvents: "none" }}
          >
            <circle cx={marker.x} cy={marker.y} r={16} />
            <circle cx={marker.x} cy={marker.y} r={5} />
            <line
              x1={marker.x - 23}
              y1={marker.y}
              x2={marker.x - 12}
              y2={marker.y}
            />
            <line
              x1={marker.x + 12}
              y1={marker.y}
              x2={marker.x + 23}
              y2={marker.y}
            />
            <line
              x1={marker.x}
              y1={marker.y - 23}
              x2={marker.x}
              y2={marker.y - 12}
            />
            <line
              x1={marker.x}
              y1={marker.y + 12}
              x2={marker.x}
              y2={marker.y + 23}
            />
          </g>
        )}
      </svg>
      <div className="um-map-controls">
        <div aria-label="Move selected location">
          <Button aria-label="Move location west" onClick={() => move("west")}>
            ←
          </Button>
          <Button
            aria-label="Move location north"
            onClick={() => move("north")}
          >
            ↑
          </Button>
          <Button
            aria-label="Move location south"
            onClick={() => move("south")}
          >
            ↓
          </Button>
          <Button aria-label="Move location east" onClick={() => move("east")}>
            →
          </Button>
        </div>
        <Button disabled={!selected} onClick={() => setCenter(selected)}>
          Center on selection
        </Button>
      </div>
      <output aria-live="polite">
        {selected
          ? `${selected.latitude.toFixed(6)}, ${selected.longitude.toFixed(6)}`
          : "Enter valid coordinates or choose a point"}
      </output>
      {selected && !inside(selected) && (
        <p className="um-map-outside">
          Selected location is outside this view. Center on it to see the
          marker.
        </p>
      )}
      <p id={help}>
        Click the grid or choose a photo marker. Arrow keys move the selected
        point; Shift moves farther. This coordinate surface does not show roads
        or terrain.
      </p>
    </div>
  );
}
