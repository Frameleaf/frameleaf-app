import React, {
  useEffect,
  useLayoutEffect,
  useId,
  useReducer,
  useRef,
  useState,
  lazy,
  Suspense,
} from "react";
import {
  createLibrarySession,
  reduceLibrarySession,
  readLibraryView,
  readLibraryViewValue,
  writeLibraryView,
} from "./reference/library-session";
import "./reference/tokens.css";
import { Icon } from "./Icon";
import {
  media,
  timecode,
  people as basePeople,
  tags,
  scopeMedia,
} from "./media";
import { ExploreLibrary } from "./ExploreLibrary";
import { TimelineLibrary } from "./TimelineLibrary";
import { MediaViewer } from "./MediaViewer";
import { FaceTagger } from "./FaceTagger";
import {
  createFaceState,
  loadFaceState,
  subscribeFaceState,
  saveAssetFaces,
  getAssetFaces,
  mergeFacePeople,
  mergeAssetFaceTags,
} from "./face-tags.mjs";
import { LockedControl } from "./LockedContent";
import {
  loadResourceState,
  subscribeResourceState,
} from "./account-library-data.mjs";
import { applyLockedRules } from "./locked-rules.mjs";
import {
  visibleAssets,
  classifyLocked,
  lockedAccessSnapshot,
} from "./locked-content.mjs";
import {
  readLibraryAssets,
  changeLibraryAsset,
  mergeLibraryAssets,
  trashLibraryAsset,
} from "./library-assets.mjs";
import { parseUtilities, utilityStorageKey } from "./utilities-data.mjs";
import "./library-enhancements.css";
import { LibraryRail } from "./LibraryRail";
import { PeopleLibrary, PeoplePanel, PersonAvatar } from "./People";
import { FilterPanel } from "./FilterPanel";
import { SearchDialog, searchModes } from "./SearchDialog";
import {
  normalizeSearchQuery,
  searchSampleAssets,
  sampleFacets,
  searchChips,
} from "./search.mjs";
import { Editor, Processing } from "./Editor";
import { HighRiskWorkflows } from "./HighRiskWorkflows";
const CommandCenter = lazy(() =>
  import("./CommandCenter").then((module) => ({
    default: module.CommandCenter,
  })),
);
import {
  initialEdit,
  durationFor,
  normalizeEdit,
  parseSavedPrototype,
  changeDraft,
  travelDraft,
  applyPreset,
  createSimulatedJob,
  restoredViewContext,
} from "./state.mjs";

const key = "frameleaf:prototype:v1";
const readSaved = () => {
  try {
    return parseSavedPrototype(
      localStorage.getItem(key),
      media,
      readLibraryViewValue,
    );
  } catch {
    return parseSavedPrototype(null, media, readLibraryViewValue);
  }
};
function init() {
  const session = createLibrarySession();
  session.state.scope = { kind: "album", id: "summer-rockies" };
  const saved = readSaved();
  session.state =
    restoredViewContext(saved, readLibraryView(new URL(location.href))).view ||
    session.state;
  session.layout = ["timeline", "browse", "work"].includes(saved.layout)
    ? saved.layout
    : "work";
  session.selection = Array.isArray(saved.selection)
    ? saved.selection.filter((id) => media.some((asset) => asset.id === id))
    : ["1"];
  session.openAssetId = media.some((asset) => asset.id === saved.openAssetId)
    ? saved.openAssetId
    : "1";
  session.playbackPosition = Number.isFinite(saved.playbackPosition)
    ? Math.max(
        0,
        Math.min(
          durationFor(media.find((asset) => asset.id === session.openAssetId)),
          saved.playbackPosition,
        ),
      )
    : 0;
  return session;
}
export function Button({
  children,
  icon,
  primary,
  active,
  className = "",
  ...props
}) {
  return (
    <button
      className={`button ${primary ? "primary" : ""} ${active ? "active" : ""} ${className}`}
      {...props}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}
export function Dialog({ title, close, children, wide, actions }) {
  const ref = useRef(null);
  const mounted = useRef(false);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    mounted.current = true;
    dialog?.showModal();
    dialog?.querySelector("[data-initial-focus]")?.focus();
    return () => {
      mounted.current = false;
      if (dialog?.open) dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`dialog ${wide ? "wide" : ""} ${actions ? "with-actions" : ""}`}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClose={() => {
        if (mounted.current && !ref.current?.open) close();
      }}
    >
      <div className="dialog-title">
        <h2 id={titleId}>{title}</h2>
        <Button aria-label="Close dialog" icon="mdiClose" onClick={close} />
      </div>
      {actions ? <div className="dialog-body">{children}</div> : children}
      {actions && <div className="dialog-actions">{actions}</div>}
    </dialog>
  );
}

export function App() {
  const [session, dispatch] = useReducer(reduceLibrarySession, undefined, init);
  const [saved] = useState(readSaved);
  const [theme, setTheme] = useState(
    saved.theme === "light" ? "light" : "dark",
  );
  const [screen, setScreen] = useState(() => {
    const value = new URL(location.href).searchParams.get("screen");
    return [
      "studio",
      "activity",
      "admin",
      "care",
      "people",
      "explore",
      "review",
    ].includes(value)
      ? value
      : "library";
  });
  const [settingsStart, setSettingsStart] = useState("overview");
  const [initialContext] = useState(() =>
    restoredViewContext(saved, readLibraryView(new URL(location.href))),
  );
  const [collection, setCollection] = useState(
    new URL(location.href).searchParams.get("collection") ||
      initialContext.collection ||
      "Summer in the Rockies",
  );
  const [panel, setPanel] = useState(() =>
    ["quick", "search", "filters"].includes(
      new URL(location.href).searchParams.get("screen"),
    )
      ? new URL(location.href).searchParams.get("screen")
      : null,
  );
  const [tab, setTab] = useState("Info");
  const [inspector, setInspector] = useState(
    session.layout === "work" && window.innerWidth > 1000,
  );
  const [size, setSize] = useState(190);
  const [ratings, setRatings] = useState(saved.ratings || {});
  const [ratingHistory, setRatingHistory] = useState([]);
  const [drafts, setDrafts] = useState(saved.drafts);
  const [notes, setNotes] = useState(saved.notes);
  const [assetOverrides, setAssetOverrides] = useState(() => {
    try {
      return readLibraryAssets();
    } catch {
      return {};
    }
  });
  const [utilityState, setUtilityState] = useState(() => {
    try {
      return parseUtilities(localStorage.getItem(utilityStorageKey));
    } catch {
      return parseUtilities(null);
    }
  });
  const [unlocked, setUnlocked] = useState(false);
  const [unlockRequest, setUnlockRequest] = useState(0);
  const [viewerId, setViewerId] = useState(null);
  const [viewerOrigin, setViewerOrigin] = useState("collection");
  const [slideshow, setSlideshow] = useState(false);
  const [actionAssetId, setActionAssetId] = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [albumTarget, setAlbumTarget] = useState("family");
  const [exploreSection, setExploreSection] = useState(null);
  const [resources, setResources] = useState(loadResourceState);
  const [faceState, setFaceState] = useState(() => {
    try {
      return loadFaceState();
    } catch {
      return createFaceState();
    }
  });
  const [faceReturnViewer, setFaceReturnViewer] = useState(null);
  const allFacePeople = [...basePeople, ...faceState.people];
  const catalog = applyLockedRules(
    mergeAssetFaceTags(
      mergeLibraryAssets(assetOverrides, utilityState),
      faceState,
      allFacePeople,
    ),
    resources.users.find((user) => user.id === "taylor")?.preferences,
  );
  const accessibleAssets = visibleAssets(catalog, { unlocked });
  const people = mergeFacePeople(basePeople, faceState, [
    ...accessibleAssets,
    ...visibleAssets(catalog, { unlocked, scope: "locked" }),
  ]);
  const exploreAssets = accessibleAssets.filter(
    (asset) => asset.visibility !== "archive",
  );
  const collectionAssets =
    collection === "Locked"
      ? visibleAssets(catalog, { unlocked, scope: "locked" })
      : accessibleAssets;
  const selected =
    collectionAssets.find((asset) => asset.id === session.openAssetId) ||
    accessibleAssets[0] ||
    media[0];
  const { edit, undo, redo } = drafts[selected.id];
  const [versions, setVersions] = useState(saved.versions || []);
  const [jobs, setJobs] = useState(Array.isArray(saved.jobs) ? saved.jobs : []);
  const [destination, setDestination] = useState(
    saved.destination === "runpod" ? "runpod" : "local",
  );
  const [presets, setPresets] = useState(saved.presets || []);
  const [name, setName] = useState("Summer favorites");
  const [toast, setToast] = useState("");
  const [storageStatus, setStorageStatus] = useState("saving");
  const [scrollEpoch, setScrollEpoch] = useState(0);
  const [navOpen, setNavOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(
    saved.railCollapsed || false,
  );
  const [searchBy, setSearchBy] = useState(() => {
    const value = new URL(location.href).searchParams.get("searchBy");
    return searchModes.some(([mode]) => mode === value)
      ? value
      : saved.searchBy || "semantic";
  });
  const [recentSearches, setRecentSearches] = useState(
    saved.recentSearches || [],
  );
  const [filterSection, setFilterSection] = useState("people");
  const openFilters = (section = "people") => {
    setFilterSection(section);
    setPanel("filters");
    setScreen("library");
  };
  const [snapshotIds, setSnapshotIds] = useState(
    initialContext.snapshotIds || null,
  );
  const search = useRef(null),
    grid = useRef(null),
    scroll = useRef(saved.scroll || 0),
    scrollAnchor = useRef(saved.scrollAnchor);
  const query = normalizeSearchQuery(session.state.query, { people, tags });
  const filter = query.filter;
  const patchView = (patch) => dispatch({ type: "view", patch });
  const patchQuery = (patch) => patchView({ query: { ...query, ...patch } });
  const setCondition = (field, value) => {
    const next = { ...filter };
    if (value) next[field] = value;
    else delete next[field];
    patchQuery({ filter: next });
  };
  const rate = (asset) => ratings[asset.id] ?? asset.rating;
  const scopedAssets = scopeMedia(
    collectionAssets,
    session.state.scope,
    snapshotIds,
  ).filter((asset) =>
    collection === "Archive"
      ? asset.visibility === "archive"
      : collection === "Best Photos"
        ? asset.bestPhotosScore >= 90
        : session.state.scope.kind === "library" && collection !== "Locked"
          ? filter.visibility || query.text
            ? true
            : asset.visibility !== "archive"
          : true,
  );
  const searchOptions = { people, tags, ratings, textMode: searchBy };
  const facets = sampleFacets(scopedAssets, query, searchOptions);
  const activeChips = searchChips(query, { people, tags });
  const visible = searchSampleAssets(scopedAssets, query, searchOptions).sort(
    (a, b) =>
      collection === "Best Photos"
        ? b.bestPhotosScore - a.bestPhotosScore
        : session.state.sort === "imported-desc"
          ? b.addedAt.localeCompare(a.addedAt)
          : session.state.sort === "filename"
            ? a.name.localeCompare(b.name)
            : session.state.sort === "rating"
              ? rate(b) - rate(a)
              : session.state.sort === "captured-asc"
                ? a.date.localeCompare(b.date)
                : b.date.localeCompare(a.date),
  );
  const selectedVisible = visible.filter((asset) =>
    session.selection.includes(asset.id),
  );
  const viewableAssets = viewerOrigin === "explore" ? exploreAssets : visible;
  const visibleKey = visible.map((asset) => asset.id).join(",");
  const setRating = (asset, value) => {
    setRatingHistory([...ratingHistory, ratings]);
    setRatings({ ...ratings, [asset.id]: value });
  };
  const open = (asset, multi = false) => {
    dispatch({
      type: "selection",
      ids: multi
        ? session.selection.includes(asset.id)
          ? session.selection.filter((id) => id !== asset.id)
          : [...session.selection, asset.id]
        : [asset.id],
    });
    dispatch({
      type: "open",
      id: asset.id,
      time: selected.id === asset.id ? session.playbackPosition : 0,
    });
  };
  const navigate = (title) => {
    setCollection(title);
    setScreen("library");
    setNavOpen(false);
    setPanel(null);
    setSnapshotIds(null);
    setViewerId(null);
    if (title === "Locked") {
      dispatch({ type: "layout", layout: "timeline" });
      if (!unlocked) setUnlockRequest((value) => value + 1);
    }
    patchView({
      scope: [
        "Library",
        "Favorites",
        "Recently added",
        "Best Photos",
        "Archive",
        "Locked",
        "Pets",
        "Documents",
      ].includes(title)
        ? { kind: "library" }
        : {
            kind: title === "Family Space" ? "space" : "album",
            id:
              title === "Summer in the Rockies"
                ? "summer-rockies"
                : title.toLowerCase().replaceAll(" ", "-"),
          },
      query: {
        ...query,
        text: "",
        filter:
          title === "Favorites"
            ? { isFavorite: { eq: true } }
            : title === "Pets"
              ? { tagIds: { any: ["pet"] } }
              : title === "Documents"
                ? { tagIds: { any: ["sign"] } }
                : {},
      },
      sort:
        title === "Best Photos"
          ? "rating"
          : title === "Recently added"
            ? "imported-desc"
            : "captured-desc",
      view: "grid",
    });
  };
  const openViewer = (id, from = "collection", startSlideshow = false) => {
    const asset = (from === "explore" ? exploreAssets : visible).find(
      (asset) => asset.id === id,
    );
    if (!asset) return;
    open(asset);
    setViewerOrigin(from);
    setSlideshow(startSlideshow);
    setViewerId(id);
  };
  const goExplore = (section = null) => {
    if (collection === "Locked") {
      setCollection("Library");
      patchView({
        scope: { kind: "library" },
        query: { ...query, text: "", filter: {} },
      });
    }
    setScreen("explore");
    setExploreSection(section);
    setNavOpen(false);
    setPanel(null);
  };
  const openSettings = (area, section) => {
    const url = new URL(location.href);
    url.searchParams.set("screen", "admin");
    url.searchParams.set("settings", area);
    if (section) url.searchParams.set("section", section);
    else url.searchParams.delete("section");
    history.replaceState({}, "", url);
    setSettingsStart(area);
    setPanel(null);
    setScreen("admin");
    setNavOpen(false);
  };
  const mutateAsset = (id, patch) => {
    if (!collectionAssets.some((asset) => asset.id === id)) {
      setToast("This item is no longer available.");
      return false;
    }
    try {
      setAssetOverrides(changeLibraryAsset(id, patch));
      return true;
    } catch (error) {
      setToast(error.message);
      return false;
    }
  };
  const favoriteAsset = (id) => {
    const asset = catalog.find((item) => item.id === id);
    return mutateAsset(id, { favorite: !asset?.favorite });
  };
  const trashAsset = (id) => {
    if (!collectionAssets.some((asset) => asset.id === id)) return false;
    try {
      setUtilityState(trashLibraryAsset(id));
      setToast("Moved to Trash. Restore it any time in Settings → Trash.");
      return true;
    } catch (error) {
      setToast(error.message);
      return false;
    }
  };
  const editAsset = (id, position) => {
    const asset = collectionAssets.find((asset) => asset.id === id);
    if (!asset) return false;
    open(asset);
    if (Number.isFinite(position?.currentTime))
      dispatch({ type: "playback", time: position.currentTime });
    setViewerId(null);
    setPanel("quick");
  };
  const shareAsset = (id) => {
    const asset = collectionAssets.find((asset) => asset.id === id);
    if (!asset) return false;
    if (classifyLocked(asset)) {
      setToast("Unmark Sensitive before sharing this item.");
      return false;
    }
    setActionAssetId(id);
    setRecipients(asset.sharedWith || []);
    setViewerId(null);
    setPanel("share");
    return true;
  };
  const beginFaceTagging = (id) => {
    const asset = collectionAssets.find((asset) => asset.id === id);
    if (!asset) return false;
    setActionAssetId(id);
    setFaceReturnViewer(viewerId);
    setViewerId(null);
    setPanel("tag-people");
    return true;
  };
  const closeFaceTagging = () => {
    setPanel(null);
    if (
      faceReturnViewer &&
      collectionAssets.some((asset) => asset.id === faceReturnViewer)
    )
      setViewerId(faceReturnViewer);
    setFaceReturnViewer(null);
  };
  const saveFaces = (faces, metadata) => {
    const latestResources = loadResourceState();
    const previousAccess = lockedAccessSnapshot(resources),
      latestAccess = lockedAccessSnapshot(latestResources);
    if (!latestAccess.available || latestAccess.token !== previousAccess.token)
      throw Error(
        "Your session changed. Reopen the image before saving face tags.",
      );
    const latestFaceState = loadFaceState();
    const latestCatalog = applyLockedRules(
      mergeAssetFaceTags(
        mergeLibraryAssets(
          readLibraryAssets(),
          parseUtilities(localStorage.getItem(utilityStorageKey)),
        ),
        latestFaceState,
        [...basePeople, ...latestFaceState.people],
      ),
      latestResources.users.find((user) => user.id === "taylor")?.preferences,
    );
    const latestAccessibleAssets = [
      ...visibleAssets(latestCatalog, { unlocked }),
      ...visibleAssets(latestCatalog, { unlocked, scope: "locked" }),
    ];
    const asset = latestAccessibleAssets.find(
      (asset) => asset.id === actionAssetId,
    );
    if (!asset)
      throw Error("This photo is no longer available for face tagging.");
    const next = saveAssetFaces(asset, faces, {
      ...metadata,
      people: mergeFacePeople(
        basePeople,
        latestFaceState,
        latestAccessibleAssets,
      ),
      unlocked,
    });
    setFaceState(next);
    setToast("People updated. Face regions are saved on this device.");
    return true;
  };
  const mediaAction = (action, id) => {
    const asset = collectionAssets.find((item) => item.id === id);
    if (!asset) return false;
    if (action === "download") {
      const link = document.createElement("a");
      link.href = asset.mediaSrc || asset.image;
      link.download = asset.name.replace(
        /\.[^.]+$/,
        asset.type === "video" ? ".mp4" : ".png",
      );
      link.click();
    } else if (action === "add-to-album") {
      setActionAssetId(id);
      setViewerId(null);
      setPanel("add-to-album");
    } else if (action === "archive" || action === "unarchive")
      return mutateAsset(id, {
        visibility: action === "archive" ? "archive" : "timeline",
      });
    else if (action === "unlock" && asset.lockedByRule) {
      setViewerId(null);
      openSettings("security", "advanced-protected-suppression");
      return true;
    } else if (action === "lock" || action === "unlock")
      return mutateAsset(id, {
        isSensitive: action === "lock",
        ...(action === "unlock"
          ? { isLocked: false, isSuppressed: false }
          : {}),
      });
    else if (action === "view-in-timeline") {
      setViewerId(null);
      setScreen("library");
      dispatch({ type: "layout", layout: "timeline" });
      dispatch({ type: "anchor", id });
    } else if (action === "find-similar") {
      setViewerId(null);
      setSearchBy("semantic");
      patchQuery({ text: asset.description, filter: {} });
      setScreen("library");
    } else if (action === "view-on-map") {
      setViewerId(null);
      setActionAssetId(id);
      setPanel("location");
    }
    return true;
  };
  const hideLocked = () => {
    setUnlocked(false);
    setViewerId(null);
    setPanel(null);
    if (collection === "Locked") navigate("Library");
    if (screen === "studio") setScreen("library");
  };
  const choosePerson = (id, allLibrary = false) => {
    setScreen("library");
    setNavOpen(false);
    if (allLibrary) {
      setCollection("Library");
      setSnapshotIds(null);
      patchView({
        scope: { kind: "library" },
        view: "grid",
        query: { ...query, text: "", filter: { personIds: { all: [id] } } },
      });
    } else setCondition("personIds", { all: [id] });
  };
  const changeEdit = (patch) =>
    setDrafts((current) => ({
      ...current,
      [selected.id]: changeDraft(current[selected.id], patch, selected),
    }));
  const undoEdit = () =>
    setDrafts((current) => ({
      ...current,
      [selected.id]: travelDraft(current[selected.id], "undo", selected),
    }));
  const redoEdit = () =>
    setDrafts((current) => ({
      ...current,
      [selected.id]: travelDraft(current[selected.id], "redo", selected),
    }));
  const saveVersion = () => {
    setVersions([
      ...versions,
      {
        id: Date.now(),
        assetId: selected.id,
        name: `Version ${versions.filter((v) => v.assetId === selected.id).length + 1}`,
        edit,
      },
    ]);
    setToast("Version saved in this prototype");
    setPanel(null);
  };
  const enqueue = (kind) => {
    setJobs((current) => [
      createSimulatedJob(kind, selected, edit, destination),
      ...current,
    ]);
    setPanel(null);
    setToast("Simulated job queued. No media was uploaded or rendered.");
  };
  const editorProps = {
    selected,
    edit,
    changeEdit,
    initialEdit,
    undo,
    redo,
    undoEdit,
    redoEdit,
    session,
    dispatch,
    destination,
    setDestination,
    saveVersion,
    enqueue,
    close: () => setPanel(null),
    openStudio: () => {
      setPanel(null);
      setScreen("studio");
    },
    notify: setToast,
  };

  useEffect(() => subscribeResourceState(setResources), []);
  useEffect(
    () =>
      subscribeFaceState((next, error) => {
        if (next) setFaceState(next);
        else setToast(error?.message || "Face tags could not be refreshed.");
      }),
    [],
  );
  useEffect(() => {
    const sync = () => {
      try {
        setAssetOverrides(readLibraryAssets());
        setUtilityState(
          parseUtilities(localStorage.getItem(utilityStorageKey)),
        );
      } catch {
        setToast("Library changes could not be refreshed.");
      }
    };
    window.addEventListener("storage", sync);
    window.addEventListener("frameleaf:utilities-changed", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("frameleaf:utilities-changed", sync);
    };
  }, []);
  useEffect(() => {
    if (screen === "explore" && exploreSection)
      document
        .getElementById(`explore-${exploreSection}`)
        ?.scrollIntoView({ block: "start" });
  }, [screen, exploreSection]);
  useEffect(() => {
    const allowed = new Set(collectionAssets.map((asset) => asset.id));
    const next = session.selection.filter((id) => allowed.has(id));
    if (next.length !== session.selection.length)
      dispatch({ type: "selection", ids: next });
    if (!allowed.has(session.openAssetId))
      dispatch({ type: "open", id: collectionAssets[0]?.id });
    if (viewerId && !viewableAssets.some((asset) => asset.id === viewerId))
      setViewerId(null);
    if (!allowed.size && (screen === "studio" || panel === "quick")) {
      setScreen("library");
      setPanel(null);
    }
    if (actionAssetId && !allowed.has(actionAssetId)) {
      setActionAssetId(null);
      setPanel(null);
    }
  }, [
    collectionAssets.map((asset) => asset.id).join(","),
    visibleKey,
    unlocked,
  ]);
  useEffect(() => {
    document.title = "Frameleaf — interactive prototype";
  }, []);
  useEffect(() => {
    const url = writeLibraryView(new URL(location.href), session.state);
    url.searchParams.set("searchBy", searchBy);
    if (["people", "admin", "explore"].includes(screen))
      url.searchParams.set("screen", screen);
    else {
      url.searchParams.delete("screen");
      url.searchParams.delete("settings");
      url.searchParams.delete("section");
    }
    if (
      [
        "Library",
        "Favorites",
        "Recently added",
        "Best Photos",
        "Archive",
        "Locked",
        "Pets",
        "Documents",
      ].includes(collection)
    )
      url.searchParams.set("collection", collection);
    else url.searchParams.delete("collection");
    history.replaceState({}, "", url);
  }, [session.state, searchBy, screen, collection]);
  useEffect(() => {
    const handler = () => {
      const state = readLibraryView(new URL(location.href));
      if (state) {
        patchView(state);
        const context = restoredViewContext({}, state);
        setCollection(context.collection);
        setSnapshotIds(null);
      }
      const mode = new URL(location.href).searchParams.get("searchBy");
      if (searchModes.some(([value]) => value === mode)) setSearchBy(mode);
    };
    addEventListener("popstate", handler);
    return () => removeEventListener("popstate", handler);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(
        key,
        JSON.stringify({
          theme,
          view: session.state,
          railCollapsed,
          searchBy,
          recentSearches,
          collection,
          snapshotIds,
          scroll: scroll.current,
          scrollAnchor: scrollAnchor.current,
          layout: session.layout,
          selection: session.selection,
          openAssetId: session.openAssetId,
          playbackPosition: session.playbackPosition,
          drafts,
          notes,
          versions,
          jobs,
          destination,
          ratings,
          presets,
        }),
      );
      setStorageStatus("saved");
    } catch {
      setStorageStatus("failed");
      setToast(
        "Storage unavailable. Keep this tab open to retain the prototype draft.",
      );
    }
  }, [
    theme,
    railCollapsed,
    searchBy,
    recentSearches,
    collection,
    snapshotIds,
    session,
    drafts,
    notes,
    edit,
    undo,
    redo,
    versions,
    jobs,
    destination,
    ratings,
    presets,
    scrollEpoch,
  ]);
  useEffect(() => {
    dispatch({
      type: "draft",
      draft: {
        assetId: selected.id,
        recipe: [edit],
        undo: undo.map((item) => [item]),
        redo: redo.map((item) => [item]),
      },
    });
  }, [edit, undo, redo, selected.id]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const handler = (event) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k" &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        if (screen === "admin")
          document.getElementById("settings-search")?.focus();
        else setPanel("search");
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "z" &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) &&
        !event.target.isContentEditable &&
        (panel === "quick" ||
          (screen === "studio" && !document.querySelector("dialog[open]")))
      ) {
        event.preventDefault();
        event.shiftKey ? redoEdit() : undoEdit();
      }
    };
    addEventListener("keydown", handler);
    return () => removeEventListener("keydown", handler);
  }, [undo, redo, edit, panel, screen]);
  useLayoutEffect(() => {
    const container = grid.current;
    if (!container || !["grid", "list"].includes(session.state.view)) return;
    const anchor = scrollAnchor.current;
    const target =
      anchor &&
      Array.from(container.querySelectorAll("[data-asset-id]")).find(
        (element) => element.dataset.assetId === anchor.id,
      );
    if (target)
      container.scrollTop +=
        target.getBoundingClientRect().top -
        container.getBoundingClientRect().top -
        anchor.offset;
    else container.scrollTop = anchor ? 0 : scroll.current;
  }, [
    screen,
    session.layout,
    session.state.view,
    size,
    visibleKey,
    railCollapsed,
    panel,
  ]);

  const assetTile = (asset) => (
    <article
      key={asset.id}
      data-asset-id={asset.id}
      className={`asset ${session.selection.includes(asset.id) ? "selected" : ""}`}
    >
      <button
        className="asset-image"
        aria-label={`Open ${asset.name}`}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey)
            open(asset, true);
          else openViewer(asset.id);
        }}
      >
        <img
          src={asset.image}
          alt={asset.name.replace(/\.[^.]+$/, "")}
          loading="lazy"
        />
        {asset.type === "video" && (
          <span className="duration">
            <Icon name="mdiPlay" size={14} />
            {timecode(asset.duration)}
          </span>
        )}
      </button>
      <input
        className="asset-select"
        type="checkbox"
        aria-label={`Select ${asset.name}`}
        checked={session.selection.includes(asset.id)}
        onChange={() => open(asset, true)}
      />
      <div className="asset-quick-actions">
        <button
          aria-label={`${asset.favorite ? "Unfavorite" : "Favorite"} ${asset.name}`}
          title={asset.favorite ? "Remove favorite" : "Favorite"}
          className={asset.favorite ? "is-favorite" : ""}
          onClick={() => favoriteAsset(asset.id)}
        >
          <Icon name="mdiHeartOutline" size={16} />
        </button>
        <button
          aria-label={`Edit ${asset.name}`}
          title="Quick edit"
          onClick={() => editAsset(asset.id)}
        >
          <Icon name="mdiPencilOutline" size={16} />
        </button>
        <button
          aria-label={`Share ${asset.name}`}
          title="Share"
          onClick={() => shareAsset(asset.id)}
        >
          <Icon name="mdiExportVariant" size={16} />
        </button>
        <button
          aria-label={`More actions for ${asset.name}`}
          title="Open photo actions"
          onClick={() => openViewer(asset.id)}
        >
          <Icon name="mdiDotsHorizontal" size={16} />
        </button>
      </div>
      <div className="asset-meta">
        <span>{asset.name}</span>
        <span className="stars" aria-label={`${rate(asset)} stars`}>
          {Array.from({ length: Math.max(0, rate(asset)) }, (_, i) => (
            <Icon key={i} name="mdiStar" size={12} />
          ))}
          {rate(asset) === -1 && "Rejected"}
        </span>
      </div>
      {session.state.view === "list" && (
        <>
          <span>{asset.date}</span>
          <span>{asset.type}</span>
          <span>
            {asset.duration ? timecode(asset.duration) : "3840 × 2160"}
          </span>
        </>
      )}
    </article>
  );
  return (
    <div
      className="frameleaf app"
      data-theme={theme}
      data-layout={session.layout}
      data-inspector={inspector}
      data-screen={screen}
    >
      <header className="topbar">
        <Button
          className="mobile-menu"
          icon="mdiMenu"
          aria-label="Open navigation"
          aria-expanded={navOpen}
          aria-controls={screen === "admin" ? "settings-navigation" : undefined}
          onClick={() => setNavOpen(!navOpen)}
        />
        <button className="brand" onClick={() => setScreen("library")}>
          <img src="/media/brand.png" alt="" />
          <strong>Frameleaf</strong>
        </button>
        <nav className="primary-nav" aria-label="Primary">
          {["library", "studio", "activity"].map((value) => (
            <button
              key={value}
              className={
                screen === value ||
                (value === "library" && ["people", "explore"].includes(screen))
                  ? "current"
                  : ""
              }
              onClick={() => setScreen(value)}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </nav>
        <button
          className="global-search search-launcher"
          ref={search}
          aria-label={screen === "admin" ? "Find a setting" : "Search library"}
          onClick={() =>
            screen === "admin"
              ? document.getElementById("settings-search")?.focus()
              : setPanel("search")
          }
        >
          <Icon name="mdiMagnify" />
          <span>
            {screen === "admin"
              ? "Search settings"
              : query.text || "Search your library"}
          </span>
          <kbd>⌘ K</kbd>
        </button>
        <LockedControl
          locked={!unlocked}
          requestKey={unlockRequest}
          onUnlock={() => setUnlocked(true)}
          onLock={hideLocked}
          onOpenLocked={() => navigate("Locked")}
          onOpenSettings={() => openSettings("preferences", "account-security")}
        />
        <Button
          icon={
            theme === "dark" ? "mdiWhiteBalanceSunny" : "mdiMoonWaningCrescent"
          }
          aria-label="Toggle theme"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        />
        <button
          className="profile"
          aria-label="Account settings"
          onClick={() => {
            setSettingsStart("preferences");
            setScreen("admin");
          }}
        >
          <img src="/media/avatar-taylor.png" alt="" />
          <span>Taylor</span>
          <Icon name="mdiChevronDown" />
        </button>
      </header>
      <div className="workspace">
        {screen !== "studio" && screen !== "admin" && screen !== "review" && (
          <LibraryRail
            collapsed={railCollapsed}
            setCollapsed={setRailCollapsed}
            navOpen={navOpen}
            collection={collection}
            screen={screen}
            navigate={navigate}
            openPeople={() => {
              if (collection === "Locked") {
                setCollection("Library");
                patchView({
                  scope: { kind: "library" },
                  query: { ...query, text: "", filter: {} },
                });
              }
              setScreen("people");
              setNavOpen(false);
              setPanel(null);
            }}
            openExplore={(title) => {
              if (title === "Pets" || title === "Documents") navigate(title);
              else
                goExplore(
                  title === "Places"
                    ? "places"
                    : title === "Memories"
                      ? "memories"
                      : null,
                );
            }}
            onTool={(section) => openSettings("utilities", section)}
            onTrash={() => openSettings("trash", "contents")}
            presets={presets}
            onPreset={(item) => {
              const next = applyPreset(
                { collection, snapshotIds, state: session.state },
                item,
              );
              setCollection(next.collection);
              setSnapshotIds(next.snapshotIds);
              patchView(next.state);
              if (item.kind !== "Filter preset")
                setSearchBy(item.searchBy || "semantic");
              setScreen("library");
              setNavOpen(false);
            }}
            onSave={() => setPanel("save")}
            onCare={() => {
              setSettingsStart("utilities");
              setScreen("admin");
              setNavOpen(false);
              setPanel(null);
            }}
            onSettings={() => {
              setSettingsStart("overview");
              setScreen("admin");
              setNavOpen(false);
              setPanel(null);
            }}
          />
        )}
        {screen === "people" && (
          <PeopleLibrary
            people={people.filter((person) =>
              accessibleAssets.some((asset) =>
                asset.personIds.includes(person.id),
              ),
            )}
            assets={accessibleAssets}
            onPerson={(id) => choosePerson(id, true)}
          />
        )}
        {screen === "explore" && (
          <ExploreLibrary
            assets={exploreAssets}
            people={people}
            onQuery={(next, title) => {
              setCollection(title);
              setSnapshotIds(null);
              patchView({
                scope: { kind: "library" },
                query: { ...query, text: "", ...next },
                view: "grid",
              });
              setScreen("library");
            }}
            onOpenCollection={(id) =>
              navigate(
                {
                  "summer-rockies": "Summer in the Rockies",
                  family: "Family",
                  everyday: "Everyday",
                }[id] || id,
              )
            }
            onOpenAsset={(id) => openViewer(id, "explore")}
            onNavigate={(title) => {
              if (title === "People") setScreen("people");
              else if (title === "Places") {
                setExploreSection("places");
                document
                  .getElementById("explore-places")
                  ?.scrollIntoView({ block: "start" });
              } else if (title === "Memories") setExploreSection("memories");
              else navigate(title);
            }}
          />
        )}
        {screen === "library" && (
          <>
            <main className="library">
              <div className="collection-header">
                <div>
                  <div className="breadcrumbs">
                    Library <span>/</span>{" "}
                    {session.state.scope.kind === "space"
                      ? "Shared Spaces"
                      : session.state.scope.kind === "album"
                        ? "Collections"
                        : "All media"}
                  </div>
                  <h1>
                    {collection}
                    <small>{scopedAssets.length} sample items</small>
                  </h1>
                </div>
                <div className="layout-switch" aria-label="Library layout">
                  {(collection === "Locked"
                    ? ["timeline"]
                    : ["timeline", "browse", "work"]
                  ).map((layout) => (
                    <button
                      key={layout}
                      aria-pressed={session.layout === layout}
                      className={session.layout === layout ? "current" : ""}
                      onClick={() => {
                        dispatch({ type: "layout", layout });
                        setInspector(layout === "work");
                        if (
                          layout === "timeline" &&
                          session.state.grouping === "all"
                        )
                          patchView({ grouping: "days" });
                      }}
                    >
                      {layout === "timeline"
                        ? "Timeline"
                        : layout === "browse"
                          ? "Browse"
                          : "Work"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="discovery-bar">
                <button
                  className="search-context"
                  onClick={() => setPanel("search")}
                >
                  <Icon name="mdiMagnify" />
                  <span>{query.text || "Search this collection"}</span>
                  <small>
                    {searchModes.find(([value]) => value === searchBy)?.[1]}
                  </small>
                </button>
                <div className="quick-filters">
                  {[
                    ["people", "People", "mdiAccountMultipleOutline"],
                    ["date", "Date", "mdiCalendarRange"],
                    ["places", "Places", "mdiMapMarker"],
                    ["media", "Media", "mdiPlayBoxOutline"],
                    ["tags", "Tags", "mdiTagOutline"],
                  ].map(([section, label, icon]) => (
                    <Button
                      key={section}
                      icon={icon}
                      active={panel === "filters" && filterSection === section}
                      onClick={() => openFilters(section)}
                    >
                      {label}
                    </Button>
                  ))}
                  <Button
                    icon="mdiTuneVariant"
                    active={panel === "filters"}
                    onClick={() =>
                      panel === "filters"
                        ? setPanel(null)
                        : openFilters("camera")
                    }
                  >
                    All filters
                  </Button>
                </div>
              </div>
              {(activeChips.length > 0 || query.text) && (
                <div className="active-filter-bar">
                  <div className="chips">
                    {query.text && (
                      <span className="chip">
                        <Icon name="mdiMagnify" size={15} />
                        {query.text}
                        <button
                          aria-label="Remove search text"
                          onClick={() => patchQuery({ text: "" })}
                        >
                          <Icon name="mdiClose" size={14} />
                        </button>
                      </span>
                    )}
                    {activeChips.map((chip) => (
                      <span className="chip" key={chip.field}>
                        {chip.field === "personIds" &&
                          [...new Set(Object.values(filter.personIds).flat())]
                            .slice(0, 3)
                            .map((id) => (
                              <PersonAvatar
                                key={id}
                                person={people.find(
                                  (person) => person.id === id,
                                )}
                                size={22}
                              />
                            ))}
                        <button
                          className="chip-label"
                          onClick={() =>
                            openFilters(
                              chip.field === "personIds"
                                ? "people"
                                : chip.field === "tagIds"
                                  ? "tags"
                                  : "camera",
                            )
                          }
                        >
                          {chip.label}
                        </button>
                        <button
                          aria-label={`Remove ${chip.label}`}
                          onClick={() => setCondition(chip.field, null)}
                        >
                          <Icon name="mdiClose" size={14} />
                        </button>
                      </span>
                    ))}
                  </div>
                  <button
                    className="text-button"
                    onClick={() => patchQuery({ text: "", filter: {} })}
                  >
                    Clear all
                  </button>
                </div>
              )}
              <div className="toolbar results-toolbar">
                <span className="result-count" aria-live="polite">
                  {visible.length} {visible.length === 1 ? "item" : "items"}
                </span>
                <span className="grow" />
                <Button
                  icon="mdiPlayBoxOutline"
                  disabled={!visible.length}
                  onClick={() =>
                    openViewer(
                      visible.some((asset) => asset.id === selected.id)
                        ? selected.id
                        : visible[0]?.id,
                      "collection",
                      true,
                    )
                  }
                >
                  Slideshow
                </Button>
                <Button
                  icon="mdiTuneVariant"
                  aria-label={
                    inspector
                      ? "Hide information panel"
                      : "Show information panel"
                  }
                  active={inspector}
                  onClick={() => setInspector(!inspector)}
                />
                <label className="sort">
                  <Icon name="mdiSort" />
                  <select
                    aria-label="Sort assets"
                    value={session.state.sort}
                    onChange={(event) =>
                      patchView({ sort: event.target.value })
                    }
                  >
                    <option value="captured-desc">Captured — newest</option>
                    <option value="captured-asc">Captured — oldest</option>
                    <option value="imported-desc">Added — newest</option>
                    <option value="filename">Filename</option>
                    <option value="rating">Rating — highest</option>
                  </select>
                </label>
                <Button
                  icon="mdiViewGridOutline"
                  aria-label="Grid view"
                  active={session.state.view === "grid"}
                  onClick={() => patchView({ view: "grid" })}
                />
                <Button
                  icon="mdiFormatListBulleted"
                  aria-label="List view"
                  active={session.state.view === "list"}
                  onClick={() => patchView({ view: "list" })}
                />
                <Button
                  icon="mdiDotsHorizontal"
                  aria-label="More library actions"
                  onClick={() => setPanel("actions")}
                />
              </div>
              <div
                className="media-scroll"
                ref={grid}
                onScroll={(event) => {
                  const container = event.currentTarget;
                  scroll.current = container.scrollTop;
                  const top = container.getBoundingClientRect().top;
                  const first = Array.from(
                    container.querySelectorAll("[data-asset-id]"),
                  ).find(
                    (element) => element.getBoundingClientRect().bottom > top,
                  );
                  if (first) {
                    scrollAnchor.current = {
                      id: first.dataset.assetId,
                      offset: first.getBoundingClientRect().top - top,
                    };
                    dispatch({ type: "anchor", id: first.dataset.assetId });
                  }
                  setScrollEpoch((value) => value + 1);
                }}
              >
                {collection === "Locked" && !unlocked ? (
                  <div className="locked-library-empty">
                    <Icon name="mdiShieldLockOutline" size={42} />
                    <h2>Your Locked collection</h2>
                    <p>
                      Keep private photos and photos hidden by your rules
                      together.
                    </p>
                    <Button
                      primary
                      onClick={() => setUnlockRequest((value) => value + 1)}
                    >
                      Unlock collection
                    </Button>
                  </div>
                ) : session.state.view === "compare" ? (
                  <div className="compare">
                    <div className="compare-heading">
                      <h2>Compare</h2>
                      <Button onClick={() => patchView({ view: "grid" })}>
                        Done
                      </Button>
                    </div>
                    {selectedVisible.length < 2 && (
                      <p>Select at least two matching items to compare.</p>
                    )}
                    <div className="comparison-images">
                      {(selectedVisible.length >= 2 ? selectedVisible : [])
                        .slice(0, 2)
                        .map((asset, i) => (
                          <section key={`${asset.id}-${i}`}>
                            <img src={asset.image} alt={asset.name} />
                            <h3>
                              {i === 0 && <Icon name="mdiPinOutline" />}
                              {asset.name}
                            </h3>
                            <div className="field-pair">
                              <Button
                                active={rate(asset) === 5}
                                icon="mdiCheck"
                                onClick={() => setRating(asset, 5)}
                              >
                                Keep
                              </Button>
                              <Button
                                active={rate(asset) === -1}
                                icon="mdiClose"
                                onClick={() => setRating(asset, -1)}
                              >
                                Reject
                              </Button>
                            </div>
                          </section>
                        ))}
                    </div>
                    <Button
                      icon="mdiUndo"
                      disabled={!ratingHistory.length}
                      onClick={() => {
                        setRatings(ratingHistory.at(-1));
                        setRatingHistory(ratingHistory.slice(0, -1));
                      }}
                    >
                      Undo decision
                    </Button>
                  </div>
                ) : collection === "Locked" || session.layout === "timeline" ? (
                  <TimelineLibrary
                    assets={visible}
                    selected={new Set(session.selection)}
                    grouping={session.state.grouping}
                    order={
                      session.state.sort === "captured-asc" ? "asc" : "desc"
                    }
                    onGroupingChange={(grouping) => patchView({ grouping })}
                    onSelect={(id) => {
                      const asset = visible.find((asset) => asset.id === id);
                      if (asset) open(asset, true);
                    }}
                    onOpen={(id) => openViewer(id)}
                  />
                ) : session.state.view === "detail" &&
                  visible.some((asset) => asset.id === selected.id) ? (
                  <div className="detail-view">
                    <Button
                      icon="mdiArrowLeft"
                      onClick={() => patchView({ view: "grid" })}
                    >
                      Back to grid
                    </Button>
                    <img src={selected.image} alt={selected.name} />
                    <h2>{selected.name}</h2>
                  </div>
                ) : (
                  <div
                    className={`media-grid ${session.state.view === "list" ? "media-list" : ""}`}
                    style={{ "--thumb-size": `${size}px` }}
                  >
                    {visible.map(assetTile)}
                  </div>
                )}
                {!visible.length && !(collection === "Locked" && !unlocked) && (
                  <div className="empty">
                    <Icon name="mdiFilterOffOutline" size={36} />
                    <h2>No matching media</h2>
                    <p>Your active filters remain available above.</p>
                    <Button
                      onClick={() => patchQuery({ text: "", filter: {} })}
                    >
                      Clear search and filters
                    </Button>
                  </div>
                )}
              </div>
            </main>
            {panel === "filters" && (
              <FilterPanel
                query={query}
                facets={facets}
                people={people}
                count={visible.length}
                collection={collection}
                setCondition={setCondition}
                clear={() => patchQuery({ filter: {} })}
                close={() => setPanel(null)}
                save={() => setPanel("save")}
                focusSection={filterSection}
              />
            )}
            {inspector &&
              panel !== "filters" &&
              visible.some((asset) => asset.id === selected.id) && (
                <aside className="inspector">
                  <div className="inspector-heading">
                    <span>Information</span>
                    <Button
                      icon="mdiClose"
                      aria-label="Close information panel"
                      onClick={() => setInspector(false)}
                    />
                  </div>
                  <button
                    className="inspector-preview"
                    onClick={() => openViewer(selected.id)}
                  >
                    <img src={selected.image} alt={selected.name} />
                    {selected.type === "video" && (
                      <>
                        <span className="play-overlay">
                          <Icon name="mdiPlay" size={38} />
                        </span>
                        <span className="duration">
                          {timecode(selected.duration)}
                        </span>
                      </>
                    )}
                  </button>
                  <h2>{selected.name}</h2>
                  <div className="tabbar">
                    {["Info", "People", "Versions"].map((title) => (
                      <button
                        key={title}
                        className={tab === title ? "current" : ""}
                        onClick={() => setTab(title)}
                      >
                        {title}
                      </button>
                    ))}
                  </div>
                  {tab === "Info" && (
                    <>
                      <dl>
                        <dt>Type</dt>
                        <dd>{selected.type === "video" ? "Video" : "Photo"}</dd>
                        <dt>Resolution</dt>
                        <dd>4K (3840 × 2160)</dd>
                        {!!selected.duration && (
                          <>
                            <dt>Frame rate</dt>
                            <dd>29.97 fps</dd>
                            <dt>Duration</dt>
                            <dd>{timecode(selected.duration)}</dd>
                          </>
                        )}
                      </dl>
                      <dl>
                        <dt>Captured</dt>
                        <dd>{selected.date}, 7:14 AM</dd>
                        <dt>Camera</dt>
                        <dd>
                          {selected.make} {selected.model}
                        </dd>
                        <dt>Location</dt>
                        <dd>
                          {selected.city}, {selected.state}, {selected.country}
                        </dd>
                      </dl>
                      <div className="location">
                        <Icon name="mdiMapMarker" size={28} />
                        <span>
                          {selected.city}
                          <small>
                            {selected.state}, {selected.country}
                          </small>
                        </span>
                      </div>
                      <section className="inspector-section">
                        <div className="inspector-heading">
                          <h3>People</h3>
                          <Button
                            icon="mdiPlus"
                            aria-label="Add person"
                            onClick={() => beginFaceTagging(selected.id)}
                          >
                            Add
                          </Button>
                        </div>
                        <PeoplePanel
                          people={people}
                          personIds={selected.personIds}
                          onPerson={(id) => choosePerson(id)}
                        />
                      </section>
                      <section className="inspector-section">
                        <h3>Tags</h3>
                        <div className="tag-list">
                          {selected.tags.map((tag) => (
                            <button
                              key={tag}
                              onClick={() =>
                                setCondition("tagIds", { all: [tag] })
                              }
                            >
                              {tag}
                            </button>
                          ))}
                        </div>
                      </section>
                      <section className="inspector-section">
                        <h3>Rating</h3>
                        <div className="rating-buttons">
                          {[1, 2, 3, 4, 5].map((value) => (
                            <button
                              key={value}
                              aria-label={`Rate ${value} stars`}
                              aria-pressed={rate(selected) === value}
                              onClick={() => setRating(selected, value)}
                            >
                              <Icon
                                name={
                                  rate(selected) >= value
                                    ? "mdiStar"
                                    : "mdiStarOutline"
                                }
                              />
                            </button>
                          ))}
                        </div>
                      </section>
                      <label className="note">
                        <span className="sr-only">Asset note</span>
                        <textarea
                          placeholder="Add a note…"
                          value={notes[selected.id] || ""}
                          onChange={(event) =>
                            setNotes({
                              ...notes,
                              [selected.id]: event.target.value,
                            })
                          }
                        />
                      </label>
                    </>
                  )}
                  {tab === "People" && (
                    <>
                      <div className="inspector-heading">
                        <span>People in this photo</span>
                        <Button
                          icon="mdiPlus"
                          aria-label="Add person"
                          onClick={() => beginFaceTagging(selected.id)}
                        >
                          Add
                        </Button>
                      </div>
                      <PeoplePanel
                        people={people}
                        personIds={selected.personIds}
                        onPerson={(id) => choosePerson(id)}
                      />
                    </>
                  )}
                  {tab === "Versions" && (
                    <div className="versions">
                      <Button
                        active
                        onClick={() =>
                          changeEdit(
                            normalizeEdit(
                              { ...initialEdit, end: durationFor(selected) },
                              selected,
                            ),
                          )
                        }
                      >
                        Original
                      </Button>
                      {versions
                        .filter(
                          (version) => (version.assetId || "1") === selected.id,
                        )
                        .map((version) => (
                          <Button
                            key={version.id}
                            onClick={() =>
                              changeEdit(normalizeEdit(version.edit, selected))
                            }
                          >
                            {version.name}
                          </Button>
                        ))}
                      <p className="muted">
                        Prototype versions are stored on this device.
                      </p>
                    </div>
                  )}
                </aside>
              )}
          </>
        )}
        {screen === "studio" &&
          collectionAssets.some((asset) => asset.id === selected.id) && (
            <Editor
              {...editorProps}
              back={() => setScreen("library")}
              openAsset={open}
            />
          )}
        {screen === "activity" && (
          <Processing
            jobs={jobs.filter((job) =>
              [
                ...accessibleAssets,
                ...visibleAssets(catalog, { unlocked, scope: "locked" }),
              ].some((asset) => asset.id === job.snapshot?.assetId),
            )}
            setJobs={setJobs}
            openStudio={() => setScreen("studio")}
          />
        )}
        {screen === "admin" && (
          <Suspense
            fallback={
              <main className="workspace-page" role="status">
                Opening command center…
              </main>
            }
          >
            <CommandCenter
              destination={destination}
              setDestination={setDestination}
              theme={theme}
              setTheme={setTheme}
              showLocked={unlocked}
              onRequestUnlock={() => setUnlockRequest((value) => value + 1)}
              onLock={hideLocked}
              defaultLayout={session.layout}
              startArea={settingsStart}
              onBack={() => {
                setScreen("library");
                setNavOpen(false);
              }}
              onActivity={() => setScreen("activity")}
              collapsed={railCollapsed}
              setCollapsed={setRailCollapsed}
              navOpen={navOpen}
              closeNav={() => setNavOpen(false)}
              onLayout={(layout) => dispatch({ type: "layout", layout })}
            />
          </Suspense>
        )}
        {screen === "care" && (
          <main className="workspace-page">
            <p className="eyebrow">Maintenance</p>
            <h1>Library Care</h1>
            <p className="muted">
              Sample repair queues. Production findings remain in your existing
              library.
            </p>
            {[
              "Media health",
              "Live Photo pairing",
              "Duplicate review",
              "Import reconciliation",
              "Preservation verification",
            ].map((title) => (
              <button
                className="care-row"
                key={title}
                onClick={() =>
                  setToast(
                    `${title}: no live scan has been run in this prototype.`,
                  )
                }
              >
                <Icon name="mdiShieldCheckOutline" />
                {title}
                <span className="grow" />
                <Icon name="mdiChevronRight" />
              </button>
            ))}
          </main>
        )}
        {screen === "review" && (
          <HighRiskWorkflows back={() => setScreen("library")} />
        )}
      </div>
      {screen !== "admin" && screen !== "review" && (
        <footer className="bottom-bar">
          <span>
            {visible.length} of {collectionAssets.length} items <i />
            {session.selection.length} selected
            {session.selection.length > selectedVisible.length &&
              ` (${session.selection.length - selectedVisible.length} outside these results)`}
          </span>
          <span className="grow" />
          {screen === "library" && (
            <>
              <Button
                className="compare-button"
                icon="mdiCompare"
                disabled={selectedVisible.length < 2}
                onClick={() => patchView({ view: "compare" })}
              >
                Compare
              </Button>
              <Button
                icon="mdiPencilOutline"
                disabled={!visible.some((asset) => asset.id === selected.id)}
                onClick={() => setPanel("quick")}
              >
                Quick edit
              </Button>
              <Button
                primary
                icon="mdiOpenInNew"
                disabled={!visible.some((asset) => asset.id === selected.id)}
                onClick={() => setScreen("studio")}
              >
                Open in Studio
              </Button>
            </>
          )}
          <span className="grow" />
          <span
            className="saved-label"
            role="status"
            title={
              storageStatus === "failed"
                ? "Storage failed. Keep this tab open to retain your draft."
                : undefined
            }
          >
            <Icon
              name={
                storageStatus === "failed"
                  ? "mdiAlertCircleOutline"
                  : "mdiCheckCircle"
              }
              size={13}
            />
            {storageStatus === "failed"
              ? "Not saved · keep this tab open"
              : storageStatus === "saved"
                ? "Saved on this device"
                : "Saving…"}
          </span>
          {screen === "library" && (
            <label className="thumbnail-control">
              Thumbnail size
              <input
                aria-label="Thumbnail size"
                type="range"
                min="140"
                max="290"
                value={size}
                onChange={(event) => setSize(Number(event.target.value))}
              />
            </label>
          )}
        </footer>
      )}
      {viewerId && (
        <MediaViewer
          assets={viewableAssets}
          assetId={viewerId}
          allowLocked={unlocked}
          initialTime={session.playbackPosition}
          onPlaybackChange={(id, time) => {
            if (id === session.openAssetId)
              dispatch({ type: "playback", time });
          }}
          onClose={() => {
            setViewerId(null);
            setSlideshow(false);
          }}
          onNavigateAsset={(id) => {
            setViewerId(id);
            const asset = viewableAssets.find((item) => item.id === id);
            if (asset) open(asset);
          }}
          onTagPeople={beginFaceTagging}
          personProfiles={people}
          onFavorite={favoriteAsset}
          onEdit={editAsset}
          onTrash={trashAsset}
          onShare={shareAsset}
          onAction={mediaAction}
          slideshow={slideshow}
          onSlideshowChange={setSlideshow}
          availableActions={[
            "download",
            "add-to-album",
            classifyLocked(catalog.find((asset) => asset.id === viewerId))
              ? "unlock"
              : "lock",
            ...(!classifyLocked(catalog.find((asset) => asset.id === viewerId))
              ? ["archive", "unarchive"]
              : []),
            "view-in-timeline",
            "find-similar",
            "view-on-map",
          ]}
        />
      )}
      {panel === "tag-people" &&
        collectionAssets.some((asset) => asset.id === actionAssetId) && (
          <FaceTagger
            asset={collectionAssets.find((asset) => asset.id === actionAssetId)}
            people={people}
            faces={getAssetFaces(
              faceState,
              collectionAssets.find((asset) => asset.id === actionAssetId),
            )}
            revision={faceState.revision}
            unlocked={unlocked}
            onSave={saveFaces}
            onClose={closeFaceTagging}
          />
        )}
      {panel === "share" && (
        <Dialog
          title="Share photo or video"
          close={() => setPanel(null)}
          actions={
            <Button
              primary
              onClick={() => {
                if (mutateAsset(actionAssetId, { sharedWith: recipients })) {
                  setPanel(null);
                  setToast("Sharing preferences saved on this device.");
                }
              }}
            >
              Save sharing
            </Button>
          }
        >
          <p>
            Choose people who can view this item. They keep their own private
            libraries.
          </p>
          <div className="library-recipient-list">
            {people
              .filter((person) => person.id !== "Taylor")
              .map((person) => (
                <label key={person.id}>
                  <PersonAvatar person={person} size={36} />
                  <span>{person.name}</span>
                  <input
                    type="checkbox"
                    checked={recipients.includes(person.id)}
                    onChange={(event) =>
                      setRecipients(
                        event.target.checked
                          ? [...recipients, person.id]
                          : recipients.filter((id) => id !== person.id),
                      )
                    }
                  />
                </label>
              ))}
          </div>
          <p className="muted">
            Sample library · sharing stays on this device.
          </p>
        </Dialog>
      )}
      {panel === "add-to-album" && (
        <Dialog
          title="Add to collection"
          close={() => setPanel(null)}
          actions={
            <Button
              primary
              onClick={() => {
                const asset = catalog.find((item) => item.id === actionAssetId);
                if (
                  mutateAsset(actionAssetId, {
                    albumIds: [...new Set([...asset.albumIds, albumTarget])],
                  })
                ) {
                  setPanel(null);
                  setToast("Added to collection.");
                }
              }}
            >
              Add to collection
            </Button>
          }
        >
          <label>
            Collection
            <select
              value={albumTarget}
              onChange={(event) => setAlbumTarget(event.target.value)}
            >
              <option value="family">Family</option>
              <option value="summer-rockies">Summer in the Rockies</option>
              <option value="everyday">Everyday</option>
              <option value="winter-2026">Winter 2026</option>
            </select>
          </label>
        </Dialog>
      )}
      {panel === "location" && (
        <Dialog title="Photo location" close={() => setPanel(null)}>
          <p>
            {catalog.find((asset) => asset.id === actionAssetId)?.city},
            Alberta, Canada
          </p>
          <p className="muted">
            This sample records a city, without an exact GPS position.
          </p>
          <Button
            onClick={() => {
              setPanel(null);
              const asset = catalog.find((item) => item.id === actionAssetId);
              setCollection(asset.city);
              patchView({
                scope: { kind: "library" },
                query: {
                  ...query,
                  text: "",
                  filter: { city: { eq: asset.city } },
                },
              });
              setScreen("library");
            }}
          >
            Show photos from this place
          </Button>
        </Dialog>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <Icon name="mdiClose" />
          </button>
        </div>
      )}
      {panel === "search" && (
        <SearchDialog
          query={query}
          searchBy={searchBy}
          collection={collection}
          scopedAssets={scopedAssets}
          allAssets={accessibleAssets}
          people={people}
          tags={tags}
          ratings={ratings}
          recent={recentSearches}
          close={() => setPanel(null)}
          submit={(next, mode, scope, text) => {
            setSearchBy(mode);
            setRecentSearches((current) =>
              text.trim()
                ? [
                    { text: text.trim(), mode, query: next },
                    ...current.filter(
                      (item) => item.text !== text.trim() || item.mode !== mode,
                    ),
                  ].slice(0, 5)
                : current,
            );
            if (scope === "library") {
              setCollection("Library");
              setSnapshotIds(null);
            }
            patchView({
              ...(scope === "library" ? { scope: { kind: "library" } } : {}),
              query: next,
              view: "grid",
            });
            setScreen("library");
            setPanel(null);
          }}
        />
      )}
      {panel === "actions" && (
        <Dialog title="Collection actions" close={() => setPanel(null)}>
          <div className="action-list">
            <Button
              onClick={() => {
                dispatch({
                  type: "selection",
                  ids: visible.map((asset) => asset.id),
                  allMatching: true,
                });
                setPanel(null);
              }}
            >
              Select all {visible.length} matching items
            </Button>
            <Button onClick={() => setPanel("save")}>
              Save query or collection
            </Button>
            <Button
              onClick={() => {
                setInspector(!inspector);
                setPanel(null);
              }}
            >
              {inspector ? "Hide" : "Show"} inspector
            </Button>
            <Button
              disabled={selectedVisible.length < 2}
              onClick={() => {
                patchView({ view: "compare" });
                setPanel(null);
              }}
            >
              Compare selected items
            </Button>
          </div>
        </Dialog>
      )}
      {panel === "save" && (
        <Dialog title="Save this collection" close={() => setPanel(null)}>
          <label>
            Name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="action-list">
            {[
              ["Smart album", "Updates as new media matches"],
              ["Album snapshot", `${visible.length} current items`],
              ["Filter preset", "Reusable filters for another collection"],
            ].map(([kind, description]) => (
              <button
                key={kind}
                disabled={!name.trim()}
                onClick={() => {
                  setPresets([
                    ...presets,
                    {
                      id: Date.now(),
                      kind,
                      searchBy,
                      name: name.trim(),
                      state: structuredClone(session.state),
                      ...(kind === "Album snapshot"
                        ? { ids: visible.map((asset) => asset.id) }
                        : {}),
                    },
                  ]);
                  setPanel(null);
                  setToast(`${kind} saved in this prototype`);
                }}
              >
                <strong>{kind}</strong>
                <span>{description}</span>
              </button>
            ))}
          </div>
        </Dialog>
      )}
      {panel === "quick" &&
        collectionAssets.some((asset) => asset.id === selected.id) && (
          <Editor {...editorProps} quick />
        )}
      {panel === "explore" && (
        <Dialog title={name} close={() => setPanel(null)}>
          <p>
            This destination is included in the full Frameleaf migration. The
            current prototype focuses on library, editing, processing, and
            worker setup.
          </p>
          <Button onClick={() => setPanel(null)}>Back to library</Button>
        </Dialog>
      )}
    </div>
  );
}
