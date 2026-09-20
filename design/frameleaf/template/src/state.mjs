const object = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value, fallback = "", limit = 4096) =>
  typeof value === "string" ? value.slice(0, limit) : fallback;
const number = (value, fallback, min, max) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const choice = (value, choices, fallback) =>
  choices.includes(value) ? value : fallback;
export const durationFor = (asset) =>
  Number.isFinite(asset?.duration) && asset.duration > 0
    ? Math.max(0.1, asset.duration)
    : 24;
export const initialEdit = {
  rotation: 0,
  exposure: 0,
  saturation: 100,
  volume: 100,
  start: 0,
  end: 24,
  trim: "precise",
  crop: "Original",
  title: "Summer in the Rockies",
  animation: "Fade in",
  caption: "",
  captionLanguage: "Auto detect",
  comment: "",
  commentTime: 0,
  restorationMode: "Faithful",
  exportFormat: "MP4 · H.265 Main10",
  exportColor: "Preserve source",
};

export function normalizeEdit(candidate, asset) {
  const value = object(candidate) ? candidate : {};
  const duration = durationFor(asset);
  const start = number(value.start, 0, 0, Math.max(0, duration - 0.1));
  return {
    rotation: number(value.rotation, 0, 0, 360) % 360,
    exposure: number(value.exposure, 0, -2, 2),
    saturation: number(value.saturation, 100, 0, 150),
    volume: number(value.volume, 100, 0, 150),
    start,
    end: number(value.end, duration, start + 0.1, duration),
    trim: choice(value.trim, ["precise", "fast"], "precise"),
    crop: choice(
      value.crop,
      ["Original", "16:9", "9:16", "1:1", "4:3"],
      "Original",
    ),
    title: text(value.title, initialEdit.title),
    animation: choice(
      value.animation,
      ["Fade in", "Rise", "Typewriter"],
      "Fade in",
    ),
    caption: text(value.caption),
    captionLanguage: choice(
      value.captionLanguage,
      ["Auto detect", "English", "French"],
      "Auto detect",
    ),
    comment: text(value.comment),
    commentTime: number(value.commentTime, 0, 0, duration),
    restorationMode: choice(
      value.restorationMode,
      ["Faithful", "Creative"],
      "Faithful",
    ),
    exportFormat: choice(
      value.exportFormat,
      ["MP4 · H.265 Main10", "MP4 · H.264", "WebM · AV1"],
      initialEdit.exportFormat,
    ),
    exportColor: choice(
      value.exportColor,
      ["Preserve source", "HDR10", "Dolby Vision · qualification required"],
      initialEdit.exportColor,
    ),
  };
}

export function normalizeDraft(candidate, asset) {
  const value = object(candidate) ? candidate : {};
  const history = (items) =>
    Array.isArray(items)
      ? items
          .filter(object)
          .slice(-200)
          .map((item) => normalizeEdit(item, asset))
      : [];
  return {
    edit: normalizeEdit(value.edit, asset),
    undo: history(value.undo),
    redo: history(value.redo),
  };
}

export function changeDraft(draft, patch, asset) {
  const edit = normalizeEdit({ ...draft.edit, ...patch }, asset);
  return JSON.stringify(edit) === JSON.stringify(draft.edit)
    ? draft
    : {
        edit,
        undo: [...draft.undo, draft.edit].slice(-200),
        redo: [],
      };
}

export function travelDraft(draft, direction, asset) {
  const source = direction === "undo" ? "undo" : "redo";
  const target = source === "undo" ? "redo" : "undo";
  if (!draft[source].length) return draft;
  return {
    edit: normalizeEdit(draft[source].at(-1), asset),
    [source]: draft[source].slice(0, -1),
    [target]: [...draft[target], draft.edit].slice(-200),
  };
}

export function parseSavedPrototype(raw, assets, readView) {
  let saved;
  try {
    saved = JSON.parse(raw || "{}");
  } catch {
    saved = {};
  }
  if (!object(saved)) saved = {};
  const ids = new Set(assets.map((asset) => asset.id));
  const validIds = (value) =>
    Array.isArray(value)
      ? [...new Set(value.filter((id) => ids.has(id)))]
      : null;
  const openAssetId = ids.has(saved.openAssetId)
    ? saved.openAssetId
    : assets[0].id;
  const active = assets.find((asset) => asset.id === openAssetId);
  const drafts = Object.fromEntries(
    assets.map((asset) => {
      const draft = object(saved.drafts) ? saved.drafts[asset.id] : undefined;
      const legacy =
        asset.id === openAssetId
          ? {
              edit: object(saved.edit)
                ? { ...saved.edit, note: text(saved.note) }
                : undefined,
              undo: saved.undo,
            }
          : {};
      return [asset.id, normalizeDraft(object(draft) ? draft : legacy, asset)];
    }),
  );
  const presets = (Array.isArray(saved.presets) ? saved.presets : [])
    .filter(object)
    .slice(0, 200)
    .flatMap((item) => {
      const state = readView(item.state);
      const kind = choice(
        item.kind,
        ["Smart album", "Album snapshot", "Filter preset"],
        null,
      );
      const snapshot = validIds(item.ids);
      if (
        !state ||
        !kind ||
        !text(item.name).trim() ||
        (kind === "Album snapshot" && !snapshot)
      )
        return [];
      return [
        {
          id: text(String(item.id)),
          name: text(item.name),
          kind,
          searchBy: choice(
            item.searchBy,
            ["semantic", "text", "filename", "description", "ocr", "fullPath"],
            "semantic",
          ),
          state,
          ...(kind === "Album snapshot" ? { ids: snapshot } : {}),
        },
      ];
    });
  const versions = (Array.isArray(saved.versions) ? saved.versions : [])
    .filter(object)
    .slice(-500)
    .flatMap((item) => {
      const asset = assets.find(
        (asset) => asset.id === (item.assetId || assets[0].id),
      );
      if (!asset || !object(item.edit)) return [];
      return [
        {
          id: text(String(item.id)),
          assetId: asset.id,
          name: text(item.name, "Saved version"),
          edit: normalizeEdit(item.edit, asset),
        },
      ];
    });
  const jobs = (Array.isArray(saved.jobs) ? saved.jobs : [])
    .filter(object)
    .slice(0, 200)
    .map((item) => ({
      id: text(String(item.id)),
      kind: text(item.kind, "Export"),
      name: text(item.name, "Sample media"),
      destination: item.destination === "runpod" ? "runpod" : "local",
      simulated: true,
      status: choice(
        item.status,
        [
          "queued",
          "preparing",
          "rendering",
          "validating",
          "paused",
          "completed",
          "cancelled",
        ],
        "paused",
      ),
      progress: number(item.progress, 0, 0, 100),
      snapshot:
        object(item.snapshot) && ids.has(item.snapshot.assetId)
          ? {
              assetId: item.snapshot.assetId,
              edit: normalizeEdit(
                item.snapshot.edit,
                assets.find((asset) => asset.id === item.snapshot.assetId),
              ),
            }
          : null,
    }));
  return {
    openAssetId,
    drafts,
    versions,
    presets,
    jobs,
    notes: Object.fromEntries(
      assets.map((asset) => [
        asset.id,
        text(
          object(saved.notes)
            ? saved.notes[asset.id]
            : (saved.drafts?.[asset.id]?.edit?.note ??
                (asset.id === openAssetId ? saved.note : "")),
        ),
      ]),
    ),
    layout: choice(saved.layout, ["timeline", "browse", "work"], "work"),
    railCollapsed: saved.railCollapsed === true,
    searchBy: choice(
      saved.searchBy,
      ["semantic", "text", "filename", "description", "ocr", "fullPath"],
      "semantic",
    ),
    view: readView(saved.view),
    recentSearches: (Array.isArray(saved.recentSearches)
      ? saved.recentSearches
      : []
    )
      .flatMap((item) => {
        const term =
          typeof item === "string" ? item : object(item) ? item.text : "";
        if (!text(term).trim()) return [];
        const mode = choice(
          item.mode,
          ["semantic", "text", "filename", "description", "ocr", "fullPath"],
          "semantic",
        );
        const state = object(item.query)
          ? readView({
              version: 1,
              scope: { kind: "library" },
              query: item.query,
              sort: "captured-desc",
              grouping: "all",
              view: "grid",
            })
          : null;
        return [
          {
            text: text(term, "", 500),
            mode,
            ...(state ? { query: state.query } : {}),
          },
        ];
      })
      .slice(0, 5),
    theme: saved.theme === "light" ? "light" : "dark",
    collection: text(saved.collection, "Summer in the Rockies"),
    destination: saved.destination === "runpod" ? "runpod" : "local",
    selection: validIds(saved.selection) ?? [assets[0].id],
    snapshotIds: validIds(saved.snapshotIds),
    ratings: Object.fromEntries(
      Object.entries(object(saved.ratings) ? saved.ratings : {}).filter(
        ([id, value]) =>
          ids.has(id) && Number.isInteger(value) && value >= -1 && value <= 5,
      ),
    ),
    playbackPosition: number(saved.playbackPosition, 0, 0, durationFor(active)),
    scroll: number(saved.scroll, 0, 0, 1e7),
    scrollAnchor:
      object(saved.scrollAnchor) && ids.has(saved.scrollAnchor.id)
        ? {
            id: saved.scrollAnchor.id,
            offset: number(saved.scrollAnchor.offset, 0, -1e5, 1e5),
          }
        : null,
  };
}

export function applyPreset(context, preset) {
  if (preset.kind === "Filter preset")
    return {
      ...context,
      state: {
        ...context.state,
        query: {
          ...context.state.query,
          filter: structuredClone(preset.state.query.filter),
        },
      },
    };
  return {
    collection: preset.name,
    snapshotIds: preset.ids ? [...preset.ids] : null,
    state: structuredClone(preset.state),
  };
}

export function createSimulatedJob(kind, asset, edit, destination) {
  return {
    id: crypto.randomUUID(),
    kind,
    name: asset.name,
    destination,
    status: "queued",
    progress: 0,
    simulated: true,
    snapshot: {
      assetId: asset.id,
      edit: structuredClone(normalizeEdit(edit, asset)),
    },
  };
}

/** A shared search URL must never inherit membership from an unrelated local snapshot. */
export function restoredViewContext(saved, incoming) {
  const same =
    !incoming ||
    (saved.view && JSON.stringify(incoming) === JSON.stringify(saved.view));
  const view = incoming || saved.view;
  const names = {
    "summer-rockies": "Summer in the Rockies",
    "summer-in-the-rockies": "Summer in the Rockies",
    family: "Family",
    "family-space": "Family Space",
    everyday: "Everyday",
    "winter-2026": "Winter 2026",
  };
  return {
    view,
    snapshotIds: same ? saved.snapshotIds : null,
    collection: same
      ? saved.collection
      : names[incoming?.scope.id] ||
        (incoming?.scope.kind === "library" ? "Library" : "Collection"),
  };
}
