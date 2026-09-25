import React, {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  lazy,
  Suspense,
} from "react";
import { Button, Dialog } from "./Controls";
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
  personId as newPersonId,
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
  changeLibraryAssets,
  mergeLibraryAssets,
  trashLibraryAsset,
} from "./library-assets.mjs";
import { reviewTrashAction, applyTrashAction } from "./trash-data.mjs";
import { parseUtilities, utilityStorageKey } from "./utilities-data.mjs";
import "./library-enhancements.css";
import { LibraryRail } from "./LibraryRail";
import { AssetTile } from "./AssetTile";
import { SelectionBar } from "./SelectionBar";
import { ShortcutsHelp } from "./ShortcutsHelp";
import {
  selectRange,
  toggleSelection,
  selectGroup,
  nextAnchor,
} from "./selection.mjs";
import { matchShortcut } from "./shortcuts.mjs";
import {
  Login,
  Register,
  ChangePassword,
  PinPrompt,
  Onboarding,
  MaintenanceSplash,
  Buy,
} from "./AuthScreens";
import {
  NotificationsBell,
  NotificationsPanel,
  HelpFeedback,
  About,
  AvatarEditor,
  AccountMenu,
} from "./SystemPanels";
import {
  UploadButton,
  DragDropOverlay,
  useDragActive,
  PanelDock,
  UploadPanel,
  DownloadPanel,
} from "./UploadPanel";
import {
  loadNotifications,
  saveNotifications,
  createUploads,
  createDownload,
  loadSupporter,
  saveSupporter,
} from "./system-data.mjs";
import {
  loadCollections,
  saveCollections,
  tree as collectionTree,
  findCollection,
  updateCollection,
  deleteCollection,
  leaveCollection,
  setCover,
  toggleLike,
  addActivity,
  removeActivity,
  activityFor,
  collectionAssets as collectionAssetsOf,
  coverAsset,
  itemCount,
  isMember,
} from "./collections-data.mjs";
import {
  readPeopleOverrides,
  savePeopleOverrides,
  applyPeopleOverrides,
  remapAssetPeople,
  personAssets,
  setFeaturedAsset,
  isUnnamed,
} from "./people-data.mjs";
import { readTagOverrides, readMemoryOverrides } from "./discovery-data.mjs";
import { SharedLinks, ShareSheet, useSharedLinks } from "./SharedLinks";
import { SharedLinkForm } from "./SharedLinkForm";
import { PublicViewer } from "./PublicViewer";
import { PartnerHeader } from "./PartnerLibrary";
import {
  resolveLink,
  recordView,
  addUploads as addLinkUploads,
  createLink as createSharedLink,
} from "./shared-links-data.mjs";
import { Collections } from "./Collections";
import { CollectionHeader } from "./CollectionHeader";
import { ActivityPanel } from "./ActivityPanel";
import { PersonHeader } from "./PersonDetail";
import { ManagePeople } from "./ManagePeople";
import { MapView } from "./MapView";
import { Places } from "./Places";
import { Tags } from "./Tags";
import { Folders } from "./Folders";
import { Memories } from "./Memories";
import { MemoryPlayer } from "./MemoryPlayer";
import { CommandPalette } from "./CommandPalette";
import { buildCommandIndex } from "./command-palette.mjs";
import { settingsAreas, settingsSections } from "./settings-catalog.mjs";
import { paginate } from "./search.mjs";
import { PeopleLibrary, PeoplePanel, PersonAvatar } from "./People";
import { FilterPanel } from "./FilterPanel";
import { SearchPalette, searchModes } from "./SearchPalette";
import { animateGridChange, viewerTransition } from "./interactions";
import {
  normalizeSearchQuery,
  searchSampleAssets,
  sampleFacets,
  searchChips,
} from "./search.mjs";
import { Editor } from "./Editor";
import { Studio } from "./Studio";
import { Processing, ActivityIndicator, useJobSimulation } from "./Activity";
import { publishJobs } from "./live-jobs.mjs";
import { loadCloudState, saveCloudState } from "./frameleaf-cloud-data.mjs";
import { settleWallet, settlementFor } from "./cloud-jobs.mjs";
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
const LIBRARY_SCREENS = ["library", "person", "partner"];
/** Depth-first flatten of the nested collection tree for rails and pickers. */
const flattenTree = (nodes = []) =>
  nodes.flatMap((node) => [node, ...flattenTree(node.children || [])]);
const PARTNER = {
  id: "jamie",
  name: "Jamie",
  image: "/media/avatar-jamie.png",
};
const AUTH_SCREENS = [
  "login",
  "register",
  "change-password",
  "pin",
  "onboarding",
  "maintenance",
  "buy",
];
const SCREEN_IDS = [
  "studio",
  "activity",
  "admin",
  "care",
  "people",
  "person",
  "people-manage",
  "explore",
  "review",
  "collections",
  "map",
  "places",
  "tags",
  "folders",
  "memories",
  "shared-links",
  "public",
  "partner",
  ...AUTH_SCREENS,
];
const CAST_DEVICES = [
  { id: "living-room", name: "Living room TV", type: "tv" },
  { id: "office", name: "Office monitor", type: "monitor" },
  { id: "kitchen", name: "Kitchen speaker", type: "speaker" },
];
const ALBUM_NAMES = {
  "summer-rockies": "Summer in the Rockies",
  family: "Family",
  everyday: "Everyday",
  "winter-2026": "Winter 2026",
};
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
  session.selection = [];
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
export { Button, Dialog } from "./Controls";
// Thumbnail size slider default; the timeline's rows scale relative to it.
const DEFAULT_THUMB_SIZE = 190;

export function App() {
  const [session, dispatch] = useReducer(reduceLibrarySession, undefined, init);
  const [saved] = useState(readSaved);
  const [theme, setTheme] = useState(
    saved.theme === "light" ? "light" : "dark",
  );
  const [screen, setScreen] = useState(() => {
    const value = new URL(location.href).searchParams.get("screen");
    return SCREEN_IDS.includes(value) ? value : "library";
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
  const [size, setSize] = useState(DEFAULT_THUMB_SIZE);
  // Work is the editing surface: ratings always, file names only on request.
  const [showFilenames, setShowFilenames] = useState(() => {
    try {
      return localStorage.getItem("frameleaf-work-filenames") === "true";
    } catch {
      return false;
    }
  });
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
  const [viewerId, setViewerIdState] = useState(null);
  const viewerIdRef = useRef(null);
  viewerIdRef.current = viewerId;
  // #11 open/close the viewer through the zoom transition.
  const setViewerId = (next) => {
    const value = typeof next === "function" ? next(viewerIdRef.current) : next;
    viewerTransition(viewerIdRef.current, value, () => setViewerIdState(value));
  };
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
  const [peopleOverrides, setPeopleOverrides] = useState(() => {
    try {
      return readPeopleOverrides();
    } catch {
      return {};
    }
  });
  const [createRequest, setCreateRequest] = useState(null);
  const [collections, setCollections] = useState(() => {
    try {
      return loadCollections(localStorage);
    } catch {
      return loadCollections();
    }
  });
  const [personId, setPersonId] = useState(null);
  const [tagOverrides, setTagOverrides] = useState(() => readTagOverrides());
  const [memoryOverrides, setMemoryOverrides] = useState(() =>
    readMemoryOverrides(),
  );
  const [playingMemory, setPlayingMemory] = useState(null);
  const [mapFocus, setMapFocus] = useState(null);
  const [mapScope, setMapScope] = useState("all");
  const [links, setLinks] = useSharedLinks();
  const [linkTarget, setLinkTarget] = useState(null);
  const [publicLink, setPublicLink] = useState(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState(null);
  const [partnerSettings, setPartnerSettings] = useState({
    inTimeline: true,
    shareLocation: false,
  });
  const [page, setPage] = useState(1);
  const [uploadTargetId, setUploadTargetId] = useState(null);
  const uploadInput = useRef(null);
  const allFacePeople = [...basePeople, ...faceState.people];
  const catalog = remapAssetPeople(
    applyLockedRules(
      mergeAssetFaceTags(
        mergeLibraryAssets(assetOverrides, utilityState),
        faceState,
        allFacePeople,
      ),
      resources.users.find((user) => user.id === "taylor")?.preferences,
    ),
    peopleOverrides,
  );
  const accessibleAssets = visibleAssets(catalog, { unlocked });
  const people = applyPeopleOverrides(
    mergeFacePeople(basePeople, faceState, [
      ...accessibleAssets,
      ...visibleAssets(catalog, { unlocked, scope: "locked" }),
    ]),
    peopleOverrides,
  );
  const changePeople = (next) => {
    try {
      setPeopleOverrides(savePeopleOverrides(next));
    } catch (error) {
      setToast(error.message);
    }
  };
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
  // Jobs keep moving Queued → Starting → Running while Activity is closed; Activity runs its own tick.
  useJobSimulation(setJobs, screen !== "activity");
  useEffect(() => publishJobs(jobs), [jobs]);
  const [destination, setDestination] = useState(
    saved.destination === "cloud" || saved.destination === "runpod" ? "cloud" : "local",
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
  const [anchorId, setAnchorId] = useState(null);
  const [notifications, setNotifications] = useState(() => {
    try {
      return loadNotifications(localStorage);
    } catch {
      return loadNotifications();
    }
  });
  const [avatar, setAvatar] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("frameleaf:avatar:v1")) || null;
    } catch {
      return null;
    }
  });
  const [supporter, setSupporter] = useState(() => {
    try {
      return loadSupporter(localStorage);
    } catch {
      return null;
    }
  });
  const [uploads, setUploads] = useState([]);
  const [downloads, setDownloads] = useState([]);
  const [uploadConcurrency, setUploadConcurrency] = useState(3);
  const [uploadsMinimized, setUploadsMinimized] = useState(false);
  const dragActive = useDragActive();
  const [helpOpen, setHelpOpen] = useState(false);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const filterMenu = useRef(null);
  const [focusedAssetId, setFocusedAssetId] = useState(null);
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
  const currentCollection =
    session.state.scope.kind !== "library"
      ? findCollection(collections, session.state.scope.id)
      : null;
  const scopedAssets = (
    currentCollection?.smart
      ? collectionAssetsOf(currentCollection, collectionAssets).filter(
          (asset) => !snapshotIds || snapshotIds.includes(asset.id),
        )
      : currentCollection?.kind === "collection"
        ? [
            ...new Map(
              [
                ...scopeMedia(
                  collectionAssets,
                  session.state.scope,
                  snapshotIds,
                ),
                ...collections.collections
                  .filter((item) => item.parentId === currentCollection.id)
                  .flatMap((item) =>
                    collectionAssetsOf(item, collectionAssets),
                  ),
              ].map((asset) => [asset.id, asset]),
            ).values(),
          ].filter((asset) => !snapshotIds || snapshotIds.includes(asset.id))
        : scopeMedia(collectionAssets, session.state.scope, snapshotIds)
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
  /** Chips that only restate the destination itself (Favorites, Pets, a person page) stay hidden. */
  const destinationField =
    collection === "Favorites"
      ? "isFavorite"
      : ["Pets", "Documents"].includes(collection)
        ? "tagIds"
        : screen === "person" || screen === "partner"
          ? "personIds"
          : null;
  const activeChips = searchChips(query, { people, tags }).filter(
    (chip) => chip.field !== destinationField,
  );
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
  const open = (asset) => {
    dispatch({
      type: "open",
      id: asset.id,
      time: selected.id === asset.id ? session.playbackPosition : 0,
    });
  };
  const orderedIds = () => visible.map((asset) => asset.id);
  const toggleSelect = (id, event) => {
    if (event?.shiftKey && anchorId) {
      dispatch({
        type: "selection",
        ids: selectRange(orderedIds(), anchorId, id, session.selection),
      });
      return;
    }
    const next = toggleSelection(session.selection, id);
    dispatch({ type: "selection", ids: next });
    setAnchorId(nextAnchor(next, id, anchorId));
  };
  const selectGroupIds = (ids, checked) =>
    dispatch({
      type: "selection",
      ids: selectGroup(session.selection, ids, checked),
    });
  const clearSelection = () => dispatch({ type: "selection", ids: [] });
  const selectAllVisible = () =>
    dispatch({ type: "selection", ids: orderedIds(), allMatching: true });
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
  const navigateCollection = (item) => {
    if (!item) return;
    setCollection(item.name);
    setScreen("library");
    setNavOpen(false);
    setPanel(null);
    setSnapshotIds(null);
    setViewerId(null);
    setActivityOpen(false);
    patchView({
      scope: { kind: item.kind === "space" ? "space" : "album", id: item.id },
      query: { ...query, text: "", filter: {} },
      sort: "captured-desc",
      view: "grid",
    });
  };
  const collectionName = (id) =>
    findCollection(collections, id)?.name || ALBUM_NAMES[id] || id;
  const openCollectionById = (id) => {
    const item = findCollection(collections, id);
    if (item) navigateCollection(item);
    else navigate(ALBUM_NAMES[id] || "Library");
  };
  const exploreQuery = (patch, title) => {
    setCollection(title);
    setSnapshotIds(null);
    patchView({
      scope: { kind: "library" },
      query: { ...query, text: "", filter: {}, ...patch },
      view: "grid",
    });
    setScreen("library");
    setViewerId(null);
    setPanel(null);
  };
  const openPartner = () => {
    setCollection(`${PARTNER.name}'s library`);
    setSnapshotIds(null);
    patchView({
      scope: { kind: "library" },
      query: {
        ...query,
        text: "",
        filter: { personIds: { any: [PARTNER.name] } },
      },
      view: "grid",
    });
    setScreen("partner");
    setNavOpen(false);
    setPanel(null);
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
  const applySearch = (next, mode, scope, text) => {
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
  };
  // Opening a result from search applies the search first, then opens the viewer on it.
  const [pendingOpen, setPendingOpen] = useState(null);
  // #8 Native share sheet (AirDrop, Messages…): sends a copy; Frameleaf sharing stays separate.
  const sendCopy = async (ids) => {
    const items = catalog.filter(
      (asset) => ids.includes(asset.id) && !classifyLocked(asset),
    );
    if (!items.length) return;
    try {
      const files = await Promise.all(
        items.map(async (asset) => {
          const blob = await (
            await fetch(asset.mediaSrc || asset.image)
          ).blob();
          return new File([blob], asset.name, { type: blob.type });
        }),
      );
      await navigator.share(
        navigator.canShare?.({ files })
          ? {
              files,
              title:
                items.length === 1 ? items[0].name : `${items.length} items`,
            }
          : { title: items[0].name, url: location.href },
      );
    } catch (error) {
      if (error?.name !== "AbortError")
        setToast("This item could not be sent from this browser.");
    }
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
  const bulkChange = (ids, patch, message) => {
    try {
      const { overrides, changed } = changeLibraryAssets(ids, patch);
      setAssetOverrides(overrides);
      if (message) setToast(message(changed.length));
      return true;
    } catch (error) {
      setToast(error.message);
      return false;
    }
  };
  const writeUtilities = (next) => {
    localStorage.setItem(utilityStorageKey, JSON.stringify(next));
    setUtilityState(next);
  };
  const trashChange = (action, ids, confirmed = false) => {
    try {
      const state = parseUtilities(localStorage.getItem(utilityStorageKey));
      const review = reviewTrashAction(state, { action, ids, unlocked });
      writeUtilities(
        applyTrashAction(state, {
          action,
          ids,
          expectedRows: review.expectedRows,
          confirmed,
          unlocked,
        }),
      );
      return true;
    } catch (error) {
      setToast(error.message);
      return false;
    }
  };
  const countLabel = (n, verb) => `${verb} ${n} ${n === 1 ? "item" : "items"}`;
  const trashAssets = (ids) => {
    let next = null;
    const done = [];
    for (const id of ids) {
      try {
        next = trashLibraryAsset(id);
        done.push(id);
      } catch (error) {
        setToast(error.message);
        break;
      }
    }
    if (next) setUtilityState(next);
    if (done.length) {
      dispatch({
        type: "selection",
        ids: session.selection.filter((id) => !done.includes(id)),
      });
      setToast({
        text: countLabel(done.length, "Moved") + " to Trash",
        action: {
          label: "Undo",
          run: () => trashChange("restore", done),
        },
      });
    }
    return done.length > 0;
  };
  const queueAssetJobs = (kind, ids) => {
    const targets = catalog.filter((asset) => ids.includes(asset.id));
    setJobs((current) => [
      ...targets.map((asset) => ({
        ...createSimulatedJob(
          kind,
          asset,
          drafts[asset.id]?.edit || initialEdit,
          "local",
        ),
        destination: "local",
      })),
      ...current,
    ]);
    setToast(countLabel(targets.length, `${kind} queued for`));
    return true;
  };
  /** Selection-scoped library operations shared by the selection bar, viewer menu and keyboard shortcuts. */
  const bulkAction = (action, ids, payload = {}) => {
    const targets = catalog.filter((asset) => ids.includes(asset.id));
    if (!targets.length) return false;
    const n = targets.length;
    const label = (verb) => () => countLabel(n, verb);
    const patchEach = (build, verb) => {
      try {
        let overrides = assetOverrides;
        for (const asset of targets)
          overrides = changeLibraryAsset(asset.id, build(asset));
        setAssetOverrides(overrides);
        setToast(countLabel(n, verb));
        return true;
      } catch (error) {
        setToast(error.message);
        return false;
      }
    };
    switch (action) {
      case "favorite":
        return bulkChange(ids, { favorite: true }, label("Favorited"));
      case "unfavorite":
        return bulkChange(ids, { favorite: false }, label("Unfavorited"));
      case "archive":
        return bulkChange(ids, { visibility: "archive" }, label("Archived"));
      case "unarchive":
        return bulkChange(ids, { visibility: "timeline" }, label("Unarchived"));
      case "mark-sensitive":
      case "lock":
        return bulkChange(
          ids,
          { isSensitive: true },
          label("Marked Sensitive:"),
        );
      case "unmark-sensitive":
      case "unlock":
        return bulkChange(
          ids,
          { isSensitive: false, isLocked: false, isSuppressed: false },
          label("Unmarked Sensitive:"),
        );
      case "add-to-album":
        return patchEach(
          (asset) => ({
            albumIds: [...new Set([...asset.albumIds, payload.albumId])],
          }),
          "Added to collection:",
        );
      case "remove-from-album":
        return patchEach(
          (asset) => ({
            albumIds: asset.albumIds.filter((id) => id !== payload.albumId),
          }),
          "Removed from collection:",
        );
      case "tag":
        return patchEach(
          (asset) => ({
            tagIds: payload.replace
              ? [...(payload.tagIds || [])]
              : [...new Set([...asset.tagIds, ...(payload.tagIds || [])])],
          }),
          "Tagged",
        );
      case "untag":
        return patchEach(
          (asset) => ({
            tagIds: asset.tagIds.filter(
              (id) => !(payload.tagIds || []).includes(id),
            ),
          }),
          "Updated tags on",
        );
      case "change-date": {
        if (payload.shiftMinutes) {
          return patchEach((asset) => {
            const at = new Date(asset.takenAt);
            at.setMinutes(at.getMinutes() + Number(payload.shiftMinutes));
            const iso = at.toISOString().slice(0, 19);
            return { takenAt: iso, date: iso.slice(0, 10) };
          }, "Shifted the date of");
        }
        const time = payload.time || "07:14:00";
        return bulkChange(
          ids,
          {
            date: payload.date,
            takenAt: `${payload.date}T${time.length === 5 ? `${time}:00` : time}`,
          },
          label("Changed the date of"),
        );
      }
      case "change-description":
        return bulkChange(
          ids,
          { description: payload.description ?? "" },
          label("Described"),
        );
      case "change-location":
        return bulkChange(
          ids,
          Object.fromEntries(
            Object.entries({
              city: payload.city,
              state: payload.state,
              country: payload.country,
              latitude: payload.latitude,
              longitude: payload.longitude,
            }).filter(([, value]) => value !== undefined && value !== ""),
          ),
          label("Relocated"),
        );
      case "stack": {
        const primary = payload.primaryId || ids[0];
        return bulkChange(
          ids,
          { stackId: `stack-${primary}` },
          label("Stacked"),
        );
      }
      case "unstack":
        return bulkChange(ids, { stackId: null }, label("Unstacked"));
      case "stack-set-primary": {
        const members = catalog.filter(
          (asset) => asset.stackId && asset.stackId === targets[0].stackId,
        );
        return bulkChange(
          members.map((asset) => asset.id),
          { stackId: `stack-${targets[0].id}` },
          () => "Stack primary updated",
        );
      }
      case "stack-keep-this": {
        const others = catalog
          .filter(
            (asset) =>
              asset.stackId &&
              asset.stackId === targets[0].stackId &&
              asset.id !== targets[0].id,
          )
          .map((asset) => asset.id);
        bulkChange([targets[0].id], { stackId: null });
        return others.length ? trashAssets(others) : true;
      }
      case "link-live-photo":
        setToast(countLabel(n, "Linked motion clips for"));
        return true;
      case "unlink-live-photo":
        setToast(countLabel(n, "Unlinked motion clips for"));
        return true;
      case "delete":
        return trashAssets(ids);
      case "restore":
        return trashChange("restore", ids);
      case "delete-permanently":
        return trashChange("delete", ids, payload.confirmed === true);
      case "refresh-thumbnails":
        return queueAssetJobs("Refresh thumbnails", ids);
      case "refresh-metadata":
        return queueAssetJobs("Refresh metadata", ids);
      case "refresh-encoded":
      case "transcode":
        return queueAssetJobs("Refresh encoded video", ids);
      case "refresh-faces":
        return queueAssetJobs("Refresh faces", ids);
      case "rerun-description":
        return queueAssetJobs("Describe photo", ids);
      case "rerun-sensitive":
        return queueAssetJobs("Sensitivity check", ids);
      default:
        return false;
    }
  };
  const currentUser = resources.users.find((user) => user.id === "taylor") || {
    id: "taylor",
    name: "Taylor",
  };
  const albumOptions = flattenTree(collectionTree(collections))
    .map(({ collection: item }) => item)
    .filter((item) => item.kind === "album" && isMember(item, "taylor"))
    .map((item) => ({
      id: item.id,
      name: item.name,
      cover: coverAsset(item, catalog)?.image,
      count: itemCount(item, catalog),
    }));
  const addUploads = (files, { albumId = null } = {}) => {
    const list = Array.from(files || []);
    if (!list.length) return false;
    setUploads((current) => [
      ...current,
      ...createUploads(list, { albumId, offset: current.length }),
    ]);
    setUploadsMinimized(false);
    return true;
  };
  const startDownload = (ids) => {
    const targets = catalog.filter((asset) => ids.includes(asset.id));
    if (!targets.length) return false;
    const name =
      targets.length === 1
        ? targets[0].name
        : `Frameleaf-${targets.length}-items.zip`;
    setDownloads((current) => [
      ...current,
      createDownload(
        name,
        targets.map((asset) => asset.id),
      ),
    ]);
    return true;
  };
  const setCollectionCover = (assetId, albumId) => {
    const target = albumId || session.state.scope.id;
    if (!findCollection(collections, target)) {
      setToast("Open an album to choose its cover.");
      return false;
    }
    setCollections((state) => setCover(state, target, assetId));
    setToast("Cover updated.");
    return true;
  };
  const updateAsset = (id, patch) => {
    const asset = collectionAssets.find((item) => item.id === id);
    if (!asset) return false;
    if (patch.rating !== undefined) setRating(asset, patch.rating);
    const rest = Object.fromEntries(
      Object.entries(patch).filter(
        ([field, value]) =>
          !["rating", "timezone"].includes(field) &&
          value !== undefined &&
          value !== null,
      ),
    );
    if (!Object.keys(rest).length) return true;
    if (rest.takenAt && !rest.date)
      rest.date = String(rest.takenAt).slice(0, 10);
    return mutateAsset(id, rest);
  };
  const faceAction = (assetId, action) => {
    const asset = collectionAssets.find((item) => item.id === assetId);
    if (!asset) return false;
    const faces = getAssetFaces(faceState, asset);
    let next = faces;
    const newPeople = [];
    if (action.type === "remove" || action.type === "hide")
      next = faces.filter((face) => face.id !== action.faceId);
    else if (action.type === "reassign")
      next = faces.map((face) =>
        face.id === action.faceId
          ? { ...face, personId: action.personId }
          : face,
      );
    else if (action.type === "create") {
      const id = newPersonId();
      newPeople.push({ id, name: action.name });
      next = faces.map((face) =>
        face.id === action.faceId ? { ...face, personId: id } : face,
      );
    }
    try {
      setFaceState(
        saveAssetFaces(asset, next, {
          newPeople,
          people,
          expectedRevision: faceState.revision,
          unlocked,
          imageWidth: asset.width,
          imageHeight: asset.height,
        }),
      );
      setToast("People updated.");
      return true;
    } catch (error) {
      setToast(error.message);
      return false;
    }
  };
  /** Every viewer menu action routes here; shared operations reuse bulkAction. */
  const viewerAction = (action, id, payload = {}) => {
    const asset = collectionAssets.find((item) => item.id === id);
    if (!asset) return false;
    switch (action) {
      case "download":
      case "download-original":
        return mediaAction("download", id);
      case "add-to-album":
      case "archive":
      case "unarchive":
      case "lock":
      case "unlock":
      case "view-in-timeline":
      case "find-similar":
      case "view-on-map":
        return mediaAction(action, id);
      case "remove-from-album":
        return bulkAction("remove-from-album", [id], {
          albumId: payload?.albumId || session.state.scope.id,
        });
      case "add-to-stack": {
        const others = session.selection.filter((item) => item !== id);
        if (!others.length) {
          setToast("Select the other photos first, then choose Add to stack.");
          return true;
        }
        return bulkAction("stack", [id, ...others], { primaryId: id });
      }
      case "unstack":
      case "stack-keep-this":
      case "stack-set-primary":
      case "refresh-faces":
      case "refresh-metadata":
      case "refresh-thumbnails":
      case "refresh-encoded":
      case "transcode":
      case "rerun-description":
      case "rerun-sensitive":
        return bulkAction(action, [id]);
      case "set-album-cover":
        return setCollectionCover(
          id,
          payload?.albumId || session.state.scope.id,
        );
      case "set-person-featured":
        return setPersonFeatured(payload?.personId, id);
      case "set-profile-picture":
        setAvatar({ kind: "photo", src: asset.image, zoom: 1, x: 0, y: 0 });
        setToast("Profile picture updated.");
        return true;
      case "restore":
        return trashChange("restore", [id]);
      case "delete-permanently":
        return trashChange("delete", [id], true);
      case "cast":
        setToast(
          payload?.deviceId
            ? `Casting to ${CAST_DEVICES.find((device) => device.id === payload.deviceId)?.name || "device"}.`
            : "Stopped casting.",
        );
        return true;
      case "copy-image":
        setToast(
          payload?.copied
            ? "Image copied."
            : "Copy is unavailable in this browser.",
        );
        return true;
      case "open-folder":
        setViewerId(null);
        setScreen("folders");
        return true;
      case "open-album":
        setViewerId(null);
        openCollectionById(payload?.albumId);
        return true;
      case "search-camera":
        setViewerId(null);
        setCollection("Library");
        setSnapshotIds(null);
        patchView({
          scope: { kind: "library" },
          query: {
            ...query,
            text: "",
            filter: payload?.lensModel
              ? { lensModel: { eq: payload.lensModel } }
              : { make: { eq: payload?.make }, model: { eq: payload?.model } },
          },
          view: "grid",
        });
        setScreen("library");
        return true;
      case "open-person":
        setViewerId(null);
        openPerson(payload?.personId);
        return true;
      case "accept-description":
        setToast("Description accepted.");
        return mutateAsset(id, { description: asset.description });
      default:
        return false;
    }
  };
  /** Selection bar and keyboard entry point; dialogs that need App state open here. */
  const selectionAction = (action, payload = {}) => {
    const ids = selectedVisible.map((asset) => asset.id);
    if (!ids.length) return false;
    if (action === "add-to-album") {
      setActionAssetId(null);
      setPanel("add-to-album");
      return true;
    }
    if (action === "create-shared-link") {
      setActionAssetId(null);
      setPanel("share-link");
      return true;
    }
    if (action === "download") return startDownload(ids);
    if (action === "set-album-cover") return setCollectionCover(ids[0]);
    if (action === "remove-from-shared-link") {
      setToast(countLabel(ids.length, "Removed from the shared link:"));
      return true;
    }
    if (action === "change-date" && payload.mode === "shift")
      return bulkAction("change-date", ids, { shiftMinutes: payload.minutes });
    return bulkAction(action, ids, payload);
  };
  const openPerson = (id) => {
    if (!id) return false;
    setPersonId(id);
    choosePerson(id, true);
    setScreen("person");
    setViewerId(null);
    return true;
  };
  const setPersonFeatured = (personIdValue, assetId) => {
    if (!personIdValue) return false;
    changePeople(setFeaturedAsset(peopleOverrides, personIdValue, assetId));
    setToast("Featured photo updated.");
    return true;
  };
  const runCommand = (command) => {
    const payload = command?.payload || {};
    setPaletteQuery(null);
    setPanel(null);
    switch (payload.kind) {
      case "page":
        if (payload.id === "library") navigate("Library");
        else if (payload.id === "admin") openSettings("overview");
        else setScreen(payload.id);
        break;
      case "settings":
        openSettings(payload.area, payload.section);
        break;
      case "person":
        openPerson(payload.id);
        break;
      case "collection":
        openCollectionById(payload.id);
        break;
      case "place":
        exploreQuery(
          { filter: { [payload.field]: { eq: payload.value } } },
          payload.value,
        );
        break;
      case "action":
        if (payload.id === "upload") uploadInput.current?.click();
        else if (payload.id === "new-collection") {
          setScreen("collections");
          setCreateRequest({ kind: "album", key: Date.now() });
        } else if (payload.id === "shortcuts") setHelpOpen(true);
        else if (payload.id === "toggle-theme")
          setTheme(theme === "dark" ? "light" : "dark");
        else if (payload.id === "lock")
          unlocked ? hideLocked() : setUnlockRequest((value) => value + 1);
        else if (payload.id === "help") setPanel("help");
        else if (payload.id === "about") setPanel("about");
        else if (payload.id === "sign-out") setScreen("login");
        break;
      default:
        if (typeof command?.run === "function") command.run();
    }
    return true;
  };
  const commandIndex = buildCommandIndex({
    pages: [
      { id: "library", title: "Library", icon: "mdiImageMultipleOutline" },
      { id: "explore", title: "Explore", icon: "mdiImageSearchOutline" },
      { id: "people", title: "People", icon: "mdiAccountOutline" },
      { id: "collections", title: "Albums", icon: "mdiImageAlbum" },
      { id: "map", title: "Map", icon: "mdiMapOutline" },
      { id: "places", title: "Places", icon: "mdiMapMarkerMultipleOutline" },
      { id: "tags", title: "Tags", icon: "mdiTagMultipleOutline" },
      { id: "folders", title: "Folders", icon: "mdiFolderMultipleOutline" },
      { id: "memories", title: "Memories", icon: "mdiHistory" },
      { id: "shared-links", title: "Shared links", icon: "mdiLinkVariant" },
      { id: "activity", title: "Activity", icon: "mdiProgressClock" },
      { id: "studio", title: "Studio", icon: "mdiMovieEditOutline" },
      { id: "admin", title: "Settings", icon: "mdiCogOutline" },
    ],
    settingsAreas,
    settingsSections,
    actions: [
      { id: "upload", title: "Upload photos", icon: "mdiUpload" },
      {
        id: "new-collection",
        title: "New album",
        icon: "mdiFolderPlusOutline",
      },
      {
        id: "shortcuts",
        title: "Keyboard shortcuts",
        icon: "mdiKeyboardOutline",
        shortcut: "?",
      },
      {
        id: "toggle-theme",
        title:
          theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        icon:
          theme === "dark" ? "mdiWhiteBalanceSunny" : "mdiMoonWaningCrescent",
      },
      {
        id: "lock",
        title: unlocked ? "Lock private content" : "Unlock private content",
        icon: "mdiShieldLockOutline",
      },
      { id: "help", title: "Help and feedback", icon: "mdiHelpCircleOutline" },
      { id: "about", title: "About Frameleaf", icon: "mdiInformationOutline" },
      { id: "sign-out", title: "Sign out", icon: "mdiLogoutVariant" },
    ],
    people: people.map((person) => ({ id: person.id, name: person.name })),
    collections: albumOptions.map((item) => ({
      id: item.id,
      title: item.name,
      kind: "album",
      count: item.count,
    })),
    places: [...new Set(accessibleAssets.map((asset) => asset.city))]
      .filter(Boolean)
      .map((value) => ({ value, field: "city" })),
  });
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
  const enqueue = (kind, extra = {}) => {
    const job = {
      ...createSimulatedJob(kind, selected, edit, extra.cloud ? "cloud" : (extra.destination ?? destination)),
      ...(extra.cloud ? { cloud: extra.cloud } : {}),
      ...(extra.settings ? { settings: extra.settings } : {}),
    };
    setJobs((current) => [job, ...current]);
    if (!extra.keepOpen) setPanel(null);
    setToast(
      extra.cloud
        ? `${kind} sent to Frameleaf Cloud. Follow it in Activity.`
        : "Simulated job queued. No media was uploaded or rendered.",
    );
    return job.id;
  };
  /**
   * A cloud dialog saw its job finish. The shared simulation already moved it
   * Queued → Starting → Running → Done and settled it, so nothing is forced here.
   */
  const finishJob = () => {};
  const [buySection, setBuySection] = useState(null);
  const cloudActions = {
    finishJob,
    onOpenCloudSettings: (section = "cloud-processing") => openSettings("cloud", section),
    onAddCredit: () => {
      setPanel(null);
      setBuySection("credit");
      setScreen("buy");
    },
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
    ...cloudActions,
    close: () => setPanel(null),
    openStudio: () => {
      setPanel(null);
      setScreen("studio");
    },
    notify: setToast,
  };

  useEffect(() => subscribeResourceState(setResources), []);
  useEffect(() => {
    if (!filterMenuOpen) return;
    const pointer = (event) => {
      if (!filterMenu.current?.contains(event.target)) setFilterMenuOpen(false);
    };
    const key = (event) => {
      if (event.key === "Escape") setFilterMenuOpen(false);
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
    };
  }, [filterMenuOpen]);
  useEffect(() => {
    try {
      saveNotifications(notifications, localStorage);
    } catch {}
  }, [notifications]);
  useEffect(() => {
    try {
      saveCollections(collections, localStorage);
    } catch {}
  }, [collections]);
  useEffect(() => setPage(1), [visibleKey]);
  useEffect(() => {
    try {
      if (avatar)
        localStorage.setItem("frameleaf:avatar:v1", JSON.stringify(avatar));
      else localStorage.removeItem("frameleaf:avatar:v1");
    } catch {}
  }, [avatar]);
  useEffect(() => {
    try {
      if (supporter) saveSupporter(supporter, localStorage);
    } catch {}
  }, [supporter]);
  // Frameleaf Cloud jobs settle exactly once when they end: the hold is released
  // and only what the job used is taken from AI credit (nothing when it failed).
  const settledCloudJobs = useRef(new Set());
  useEffect(() => {
    const ended = jobs.filter(
      (job) =>
        job.cloud &&
        !job.cloud.settled &&
        !settledCloudJobs.current.has(`${job.id}:${job.cloud.consentedAt}`) &&
        ["completed", "cancelled", "failed"].includes(job.status),
    );
    if (!ended.length) return;
    for (const job of ended) settledCloudJobs.current.add(`${job.id}:${job.cloud.consentedAt}`);
    const charges = new Map(ended.map((job) => [job.id, settlementFor(job)]));
    let cloud = loadCloudState();
    for (const job of ended) cloud = settleWallet(cloud, job.cloud, charges.get(job.id));
    saveCloudState(cloud);
    setJobs((current) =>
      current.map((job) =>
        charges.has(job.id) && !job.cloud.settled
          ? { ...job, cloud: { ...job.cloud, settled: true, chargedUsd: charges.get(job.id) } }
          : job,
      ),
    );
  }, [jobs]);
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
    if (screen !== "library" && screen !== "studio" && screen !== "activity")
      url.searchParams.set("screen", screen);
    else {
      url.searchParams.delete("screen");
      url.searchParams.delete("settings");
      url.searchParams.delete("section");
    }
    if (screen === "public" && publicLink)
      url.searchParams.set("link", publicLink.slug || publicLink.id);
    else url.searchParams.delete("link");
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
  }, [session.state, searchBy, screen, collection, publicLink]);
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
        event.shiftKey &&
        event.key.toLowerCase() === "p" &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        setPaletteQuery("");
        return;
      }
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
        panel === "quick"
      ) {
        event.preventDefault();
        event.shiftKey ? redoEdit() : undoEdit();
      }
    };
    addEventListener("keydown", handler);
    return () => removeEventListener("keydown", handler);
  }, [undo, redo, edit, panel, screen]);
  useEffect(() => {
    const handler = (event) => {
      if (
        event.defaultPrevented ||
        screen !== "library" ||
        panel ||
        viewerId ||
        document.querySelector("dialog[open]")
      )
        return;
      const hit = matchShortcut(event);
      if (!hit) return;
      const current =
        visible.find((asset) => asset.id === focusedAssetId) ||
        (visible.some((asset) => asset.id === selected.id) ? selected : null);
      const targets = selectedVisible.length
        ? selectedVisible.map((asset) => asset.id)
        : current
          ? [current.id]
          : [];
      const tiles = () => [
        ...document.querySelectorAll(".media-scroll [data-asset-id]"),
      ];
      const moveFocus = (delta) => {
        const items = tiles();
        const index = items.findIndex(
          (element) =>
            element.contains(document.activeElement) ||
            element.dataset.assetId === focusedAssetId,
        );
        const next =
          items[
            Math.max(0, Math.min(items.length - 1, Math.max(index, 0) + delta))
          ];
        next?.querySelector("button")?.focus();
      };
      const columns = () => {
        const items = tiles();
        if (items.length < 2) return 1;
        const top = items[0].getBoundingClientRect().top;
        return Math.max(
          1,
          items.filter(
            (element) =>
              Math.abs(element.getBoundingClientRect().top - top) < 2,
          ).length,
        );
      };
      const jump = (grouping) => {
        dispatch({ type: "layout", layout: "timeline" });
        patchView({ grouping });
      };
      event.preventDefault();
      switch (hit.id) {
        case "select":
          if (current) toggleSelect(current.id, event);
          break;
        case "focus-previous":
          moveFocus(-1);
          break;
        case "focus-next":
          moveFocus(1);
          break;
        case "focus-up":
          moveFocus(-columns());
          break;
        case "focus-down":
          moveFocus(columns());
          break;
        case "select-all":
          selectAllVisible();
          break;
        case "clear-selection":
          clearSelection();
          break;
        case "jump-day":
          jump("days");
          break;
        case "jump-month":
          jump("months");
          break;
        case "jump-year":
          jump("years");
          break;
        case "go-to-date":
          jump(
            session.state.grouping === "all" ? "days" : session.state.grouping,
          );
          setTimeout(
            () =>
              document
                .querySelector('.timeline-library [role="slider"]')
                ?.focus(),
            50,
          );
          break;
        case "focus-search":
          setPanel("search");
          break;
        case "help":
          setHelpOpen(true);
          break;
        case "rate-1":
        case "rate-2":
        case "rate-3":
        case "rate-4":
        case "rate-5":
        case "rate-clear":
          if (current) setRating(current, hit.value);
          break;
        case "favorite":
          if (targets.length)
            bulkAction(
              targets.every(
                (id) => catalog.find((asset) => asset.id === id)?.favorite,
              )
                ? "unfavorite"
                : "favorite",
              targets,
            );
          break;
        case "info":
          setInspector((value) => !value);
          break;
        case "edit":
          if (current) editAsset(current.id);
          break;
        case "stack":
          if (targets.length > 1) bulkAction("stack", targets);
          else setToast("Select two or more items to stack them.");
          break;
        case "add-to-album":
          if (targets.length) {
            setActionAssetId(targets.length === 1 ? targets[0] : null);
            setPanel("add-to-album");
          }
          break;
        case "tag":
          if (current && !session.selection.includes(current.id))
            toggleSelect(current.id, {});
          setToast("Choose Tag in the selection bar to add or remove tags.");
          break;
        case "tag-people":
          if (current) beginFaceTagging(current.id);
          break;
        case "archive":
          if (targets.length) bulkAction("archive", targets);
          break;
        case "download":
          if (targets.length) startDownload(targets);
          break;
        case "delete":
          if (targets.length) trashAssets(targets);
          break;
        default:
          break;
      }
    };
    addEventListener("keydown", handler);
    return () => removeEventListener("keydown", handler);
  });
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
    <AssetTile
      key={asset.id}
      asset={asset}
      layout={session.state.view === "list" ? "list" : session.layout}
      showCaption={session.layout !== "browse"}
      selected={session.selection.includes(asset.id)}
      selecting={selectedVisible.length > 0}
      rating={rate(asset)}
      stackCount={
        asset.stackId
          ? catalog.filter((item) => item.stackId === asset.stackId).length
          : 0
      }
      onOpen={(id) => openViewer(id)}
      onToggleSelect={(event) => toggleSelect(asset.id, event)}
      onFavorite={favoriteAsset}
      onEdit={editAsset}
      onShare={shareAsset}
      onMore={(id) => openViewer(id)}
      onFocus={() => setFocusedAssetId(asset.id)}
    />
  );
  const personView = personId
    ? people.find((person) => person.id === personId) || null
    : null;
  const personAssetList = personView
    ? personAssets(personView, accessibleAssets)
    : [];
  const layoutSwitch = (
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
            setInspector(layout === "work" && window.innerWidth > 1000);
            if (layout === "timeline" && session.state.grouping === "all")
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
  );
  useEffect(() => {
    if (pendingOpen && visible.some((asset) => asset.id === pendingOpen)) {
      setPendingOpen(null);
      openViewer(pendingOpen);
    }
  }, [pendingOpen, visible]);
  // #12 grid zoom: pinch (ctrl+wheel on trackpads) or +/−; browser zoom keeps ⌘/Ctrl +/−.
  const zoomGrid = (direction) => {
    const next = Math.min(290, Math.max(140, size + direction * 30));
    if (next !== size) animateGridChange(grid.current, () => setSize(next));
  };
  const zoomGridRef = useRef(zoomGrid);
  zoomGridRef.current = zoomGrid;
  const layoutRef = useRef(session.layout);
  layoutRef.current = session.layout;
  useEffect(() => {
    const container = grid.current;
    if (!container) return;
    let accumulated = 0;
    const wheel = (event) => {
      // Timeline owns pinch and ⌘-scroll: they step Years/Months/Days there.
      if (
        !event.ctrlKey ||
        event.defaultPrevented ||
        layoutRef.current === "timeline"
      )
        return;
      event.preventDefault();
      accumulated += event.deltaY;
      if (Math.abs(accumulated) < 30) return;
      zoomGridRef.current(accumulated < 0 ? 1 : -1);
      accumulated = 0;
    };
    container.addEventListener("wheel", wheel, { passive: false });
    return () => container.removeEventListener("wheel", wheel);
  }, [screen]);
  useEffect(() => {
    const key = (event) => {
      if (
        !["+", "=", "-"].includes(event.key) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        screen !== "library" ||
        layoutRef.current === "timeline" ||
        document.querySelector("dialog[open]") ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) ||
        event.target.isContentEditable
      )
        return;
      event.preventDefault();
      zoomGridRef.current(event.key === "-" ? -1 : 1);
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [screen]);
  // #9 browser and installed-app chrome match the active theme's canvas.
  useEffect(() => {
    let meta = document.querySelector('meta[name="theme-color"]:not([media])');
    if (!meta) {
      meta = Object.assign(document.createElement("meta"), {
        name: "theme-color",
      });
      document.head.append(meta);
    }
    meta.content = theme === "light" ? "#f4f6f7" : "#101416";
  }, [theme]);
  // Timeline day headers and the scrubber stick below the frosted toolbar, whatever its height.
  useEffect(() => {
    const container = grid.current;
    const toolbar = container?.querySelector(":scope > .results-toolbar");
    if (!toolbar || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(([entry]) =>
      container.style.setProperty(
        "--fl-sticky-offset",
        `${Math.round(entry.target.getBoundingClientRect().height)}px`,
      ),
    );
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [screen, session.layout]);
  const pageOf = paginate(visible, page, 60);
  if (screen === "public") {
    const link =
      publicLink ||
      resolveLink({ links }, new URL(location.href).searchParams.get("link"));
    return (
      <div className="frameleaf app" data-theme={theme} data-screen="public">
        <PublicViewer
          link={link}
          assets={catalog}
          owner={{ name: "Taylor", image: "/media/avatar-taylor.png" }}
          theme={theme}
          onView={(item) => setLinks(recordView({ links }, item.id).links)}
          onUpload={(item, files) => {
            const result = addLinkUploads({ links }, item.id, files);
            setLinks((result.state || result).links);
          }}
          onExit={() => {
            setPublicLink(null);
            setScreen("shared-links");
          }}
        />
      </div>
    );
  }
  const authScreen = {
    login: (
      <Login
        onDone={() => setScreen("library")}
        via={new URLSearchParams(location.search).get("via") === "relay" ? "relay" : "lan"}
        onRegister={() => setScreen("register")}
        theme={theme}
        setTheme={setTheme}
        users={resources.users}
      />
    ),
    register: (
      <Register
        onDone={() => setScreen("onboarding")}
        onCancel={() => setScreen("login")}
        theme={theme}
        setTheme={setTheme}
      />
    ),
    "change-password": (
      <ChangePassword
        user={currentUser}
        onDone={() => setScreen("library")}
        onCancel={() => setScreen("login")}
        theme={theme}
        setTheme={setTheme}
      />
    ),
    pin: (
      <PinPrompt
        onDone={() => {
          setUnlocked(true);
          setScreen("library");
        }}
        onCancel={() => setScreen("library")}
        onReset={() => openSettings("preferences", "account-security")}
        theme={theme}
        setTheme={setTheme}
      />
    ),
    onboarding: (
      <Onboarding
        user={currentUser}
        onDone={() => setScreen("library")}
        onCancel={() => setScreen("library")}
        theme={theme}
        setTheme={setTheme}
      />
    ),
    maintenance: (
      <MaintenanceSplash
        isAdmin
        onDone={() => setScreen("library")}
        onEnd={() => setScreen("library")}
        theme={theme}
        setTheme={setTheme}
      />
    ),
    buy: (
      <Buy
        user={currentUser}
        onDone={() => setScreen("library")}
        onCancel={() => {
          setBuySection(null);
          setScreen("library");
        }}
        onChange={setSupporter}
        section={buySection}
        onOpenCloudSettings={(section) => openSettings("cloud", section)}
        theme={theme}
        setTheme={setTheme}
      />
    ),
  }[screen];
  if (authScreen)
    return (
      <div className="frameleaf app" data-theme={theme} data-screen={screen}>
        {authScreen}
      </div>
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
        <button
          className="brand"
          aria-label="Frameleaf"
          onClick={() => setScreen("library")}
        >
          <img src="/brand/frameleaf-symbol.svg" alt="" />
          <strong aria-hidden="true">Frameleaf</strong>
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
        <UploadButton
          onFiles={addUploads}
          targets={albumOptions.map(({ id, name }) => ({ id, name }))}
        />
        <ActivityIndicator jobs={jobs} onClick={() => setScreen("activity")} />
        <NotificationsBell
          notifications={notifications}
          open={panel === "notifications"}
          onOpen={() =>
            setPanel(panel === "notifications" ? null : "notifications")
          }
        />
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
        <AccountMenu
          user={currentUser}
          avatar={avatar}
          supporter={supporter}
          unlocked={unlocked}
          onUnlock={() => setUnlockRequest((value) => value + 1)}
          onLock={hideLocked}
          onOpenLocked={() => navigate("Locked")}
          onAccountSettings={() => openSettings("preferences")}
          onAdministration={() => openSettings("overview")}
          onFrameleafCloud={() => openSettings("cloud", "cloud-account")}
          onSupportFrameleaf={() => setScreen("buy")}
          onEditAvatar={() => setPanel("avatar")}
          onSupport={() => setPanel("help")}
          onAbout={() => setPanel("about")}
          onSignOut={() => setScreen("login")}
        />
      </header>
      {panel === "notifications" && (
        <NotificationsPanel
          notifications={notifications}
          onChange={setNotifications}
          onClose={() => setPanel(null)}
          onOpenTarget={(target) => {
            setPanel(null);
            if (target?.kind === "album") openCollectionById(target.id);
            else if (target?.kind === "jobs") setScreen("activity");
            else if (target?.kind === "storage") openSettings("storage");
            else if (target?.kind === "about") setPanel("about");
          }}
        />
      )}
      {/* #7 phones: the main sections sit in a tab bar; the ☰ drawer keeps every other destination. */}
      {!["studio", "admin", "review"].includes(screen) && (
        <nav className="fl-tabbar" aria-label="Sections">
          {[
            [
              "library",
              "Library",
              "mdiImageMultipleOutline",
              () => navigate("Library"),
            ],
            [
              "memories",
              "Memories",
              "mdiHistory",
              () => {
                setScreen("memories");
                setPanel(null);
                setViewerId(null);
              },
            ],
            [
              "collections",
              "Albums",
              "mdiFolderMultipleOutline",
              () => {
                setCreateRequest(null);
                setScreen("collections");
                setPanel(null);
              },
            ],
            ["search", "Search", "mdiMagnify", () => setPanel("search")],
          ].map(([id, label, icon, go]) => (
            <button
              key={id}
              type="button"
              aria-current={
                (id === "search" ? panel === "search" : screen === id)
                  ? "page"
                  : undefined
              }
              onClick={go}
            >
              <Icon name={icon} size={24} />
              {label}
            </button>
          ))}
        </nav>
      )}
      <div className="workspace">
        {screen !== "studio" && screen !== "admin" && screen !== "review" && (
          <LibraryRail
            collapsed={railCollapsed}
            setCollapsed={setRailCollapsed}
            navOpen={navOpen}
            collection={collection}
            screen={screen}
            navigate={navigate}
            collectionsTree={flattenTree(collectionTree(collections)).filter(
              ({ collection: item }) => isMember(item, "taylor"),
            )}
            onCollection={navigateCollection}
            onCollections={() => {
              // A pending "New album" request would otherwise replay on remount.
              setCreateRequest(null);
              setScreen("collections");
              setNavOpen(false);
              setPanel(null);
            }}
            onSharedLinks={() => {
              setScreen("shared-links");
              setNavOpen(false);
              setPanel(null);
            }}
            onPartner={openPartner}
            onScreen={(id) => {
              setScreen(id);
              setNavOpen(false);
              setPanel(null);
              setViewerId(null);
              if (id === "map") {
                setMapScope("all");
                setMapFocus(null);
              }
            }}
            onBuy={() => setScreen("buy")}
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
              else goExplore(null);
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
            onSave={() => {
              setScreen("collections");
              setNavOpen(false);
              setPanel(null);
              setCreateRequest({ kind: "album", key: Date.now() });
            }}
            onNewSpace={() => {
              setScreen("collections");
              setNavOpen(false);
              setPanel(null);
              setCreateRequest({ kind: "space", key: Date.now() });
            }}
            onCare={() => {
              setSettingsStart("care");
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
        {screen === "collections" && (
          <Collections
            assets={accessibleAssets}
            people={people}
            users={resources.users}
            state={collections}
            createRequest={createRequest}
            onChange={setCollections}
            onOpen={openCollectionById}
            onCreateLink={(id) => {
              setLinkTarget({
                type: "album",
                albumId: id,
                name: collectionName(id),
              });
              setPanel("share-link");
            }}
            onUpload={(id) => {
              setUploadTargetId(id);
              uploadInput.current?.click();
            }}
            onDownload={(id) =>
              startDownload(
                collectionAssetsOf(
                  findCollection(collections, id),
                  catalog,
                ).map((asset) => asset.id),
              )
            }
            onDeleted={(id, assetIds) =>
              assetIds?.length &&
              bulkAction("remove-from-album", assetIds, { albumId: id })
            }
            onShare={(id, userId, role) =>
              setToast(
                `Invited ${resources.users.find((user) => user.id === userId)?.name || "a person"} as ${role}.`,
              )
            }
          />
        )}
        {screen === "people-manage" && (
          <ManagePeople
            people={people}
            overrides={peopleOverrides}
            onSave={(next) => {
              changePeople(next);
              setScreen("people");
            }}
            onBack={() => setScreen("people")}
          />
        )}
        {screen === "map" && (
          <MapView
            assets={mapScope === "collection" ? scopedAssets : exploreAssets}
            onOpenAsset={(id) => openViewer(id, "explore")}
            focus={mapFocus}
            onQuery={(patch, title) => {
              if (patch?.bounds) {
                const bounds = patch.bounds;
                const ids = exploreAssets
                  .filter(
                    (asset) =>
                      asset.latitude <= bounds.north &&
                      asset.latitude >= bounds.south &&
                      asset.longitude <= bounds.east &&
                      asset.longitude >= bounds.west,
                  )
                  .map((asset) => asset.id);
                setCollection(title || "Map area");
                setSnapshotIds(ids);
                patchView({
                  scope: { kind: "library" },
                  query: { ...query, text: "", filter: {} },
                  view: "grid",
                });
                setScreen("library");
              } else exploreQuery(patch, title);
            }}
          />
        )}
        {screen === "places" && (
          <Places
            assets={exploreAssets}
            onQuery={exploreQuery}
            onOpenMap={(city) => {
              setMapFocus(city);
              setMapScope("all");
              setScreen("map");
            }}
          />
        )}
        {screen === "tags" && (
          <Tags
            tags={tags}
            assets={exploreAssets}
            overrides={tagOverrides}
            onChange={(next) => setTagOverrides(next)}
            onQuery={exploreQuery}
          />
        )}
        {screen === "folders" && (
          <Folders
            assets={exploreAssets}
            onOpenAsset={(id) => openViewer(id, "explore")}
            onQuery={(patch, name) => {
              setSearchBy("fullPath");
              exploreQuery({ text: patch?.text || "" }, name);
            }}
          />
        )}
        {screen === "memories" && (
          <Memories
            assets={exploreAssets}
            overrides={memoryOverrides}
            onChange={(next) => setMemoryOverrides(next)}
            onPlay={(id, memory) => setPlayingMemory(memory)}
          />
        )}
        {screen === "shared-links" && (
          <SharedLinks
            links={links}
            assets={catalog}
            collections={albumOptions.map(({ id, name }) => ({ id, name }))}
            onChange={setLinks}
            onOpenPublic={(link) => {
              setPublicLink(link);
              setScreen("public");
            }}
            onOpenAlbum={openCollectionById}
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
            overrides={peopleOverrides}
            onChange={changePeople}
            onOpenPerson={openPerson}
            onPerson={(id) => choosePerson(id, true)}
            onManage={() => setScreen("people-manage")}
          />
        )}
        {screen === "explore" && (
          <ExploreLibrary
            assets={exploreAssets}
            people={people}
            onQuery={exploreQuery}
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
              else if (title === "Places") setScreen("places");
              else if (title === "Memories") setScreen("memories");
              else navigate(title);
            }}
          />
        )}
        {LIBRARY_SCREENS.includes(screen) && (
          <>
            <main className="library">
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
                {screen === "person" && personView ? (
                  <>
                    <PersonHeader
                      person={personView}
                      assets={personAssetList}
                      overrides={peopleOverrides}
                      onChange={changePeople}
                      allPeople={people}
                      onOpenSettings={() => openSettings("sharing", "partner")}
                      onOpenAsset={(id) => openViewer(id)}
                      onSelectFeatured={(assetId) =>
                        setPersonFeatured(personView.id, assetId)
                      }
                      faces={personAssetList.flatMap((asset) =>
                        (asset.manualFaces || []).map((face) => ({
                          assetId: asset.id,
                          faceId: face.id,
                          box: face.box,
                          personId: face.personId,
                        })),
                      )}
                      onFaceAction={(assetId, action) => {
                        if (!action?.faceId) {
                          setToast(
                            "Only manually tagged faces can be corrected in this preview.",
                          );
                          return true;
                        }
                        return faceAction(
                          assetId,
                          action.type === "new-person"
                            ? {
                                type: "create",
                                faceId: action.faceId,
                                name: action.name,
                              }
                            : action,
                        );
                      }}
                      onBack={() => setScreen("people")}
                    />
                    <div className="collection-header compact">
                      {layoutSwitch}
                    </div>
                  </>
                ) : screen === "partner" ? (
                  <>
                    <PartnerHeader
                      partner={PARTNER}
                      count={visible.length}
                      settings={partnerSettings}
                      onChange={(patch) => {
                        if (patch?.sharing === false) {
                          setToast(`Stopped sharing with ${PARTNER.name}.`);
                          navigate("Library");
                        } else
                          setPartnerSettings((current) => ({
                            ...current,
                            ...patch,
                          }));
                      }}
                      onOpenSettings={() => openSettings("sharing", "partner")}
                    />
                    <div className="collection-header compact">
                      {layoutSwitch}
                    </div>
                  </>
                ) : currentCollection ? (
                  <>
                    <CollectionHeader
                      collection={currentCollection}
                      assets={scopedAssets}
                      allAssets={accessibleAssets}
                      people={people}
                      users={resources.users}
                      tags={tags}
                      state={collections}
                      onState={setCollections}
                      onChange={(patch) => {
                        setCollections((state) =>
                          updateCollection(state, currentCollection.id, patch),
                        );
                        if (patch?.name) setCollection(patch.name);
                      }}
                      onNavigate={(id) =>
                        id ? openCollectionById(id) : navigate("Library")
                      }
                      onAddPhotos={() => {
                        navigate("Library");
                        setToast(
                          "Select photos, then choose Add to album in the selection bar.",
                        );
                      }}
                      onUpload={() => {
                        setUploadTargetId(currentCollection.id);
                        uploadInput.current?.click();
                      }}
                      onShare={(userId, role) =>
                        setToast(
                          `Invited ${resources.users.find((user) => user.id === userId)?.name || "a person"} as ${role}.`,
                        )
                      }
                      onCreateLink={() => {
                        setLinkTarget({
                          type: "album",
                          albumId: currentCollection.id,
                          name: currentCollection.name,
                        });
                        setPanel("share-link");
                      }}
                      onManageLinks={() => setScreen("shared-links")}
                      onSlideshow={() =>
                        visible.length &&
                        openViewer(visible[0].id, "collection", true)
                      }
                      onDownload={() =>
                        startDownload(visible.map((asset) => asset.id))
                      }
                      onOpenMap={() => {
                        setMapScope("collection");
                        setMapFocus(null);
                        setScreen("map");
                      }}
                      onSelectCover={(assetId) =>
                        setCollectionCover(assetId, currentCollection.id)
                      }
                      onDelete={() => {
                        const result = deleteCollection(
                          collections,
                          currentCollection.id,
                          {
                            assets: catalog,
                          },
                        );
                        setCollections(result.state || result);
                        if (result.assetIds?.length)
                          bulkAction("remove-from-album", result.assetIds, {
                            albumId: currentCollection.id,
                          });
                        setToast(
                          currentCollection.kind === "collection"
                            ? "Collection deleted. Its albums are now on their own."
                            : "Album deleted. Your photos stay in the library.",
                        );
                        navigate("Library");
                      }}
                      onLeave={() => {
                        setCollections((state) =>
                          leaveCollection(
                            state,
                            currentCollection.id,
                            "taylor",
                          ),
                        );
                        setToast(`You left ${currentCollection.name}.`);
                        navigate("Library");
                      }}
                      onOpenActivity={() => setActivityOpen((value) => !value)}
                      onReevaluate={(ids) =>
                        setToast(countLabel(ids?.length || 0, "Matching now:"))
                      }
                      activity={activityFor(collections, currentCollection.id)}
                    />
                    <div className="collection-header compact">
                      {layoutSwitch}
                    </div>
                  </>
                ) : (
                  <div className="collection-header">
                    <div>
                      {/* Top-level destinations are their own context; a
                          "Library / All media" trail would only repeat the title. */}
                      {(session.state.scope.kind === "space" ||
                        session.state.scope.kind === "album") && (
                        <div className="breadcrumbs">
                          Library <span>/</span>{" "}
                          {session.state.scope.kind === "space"
                            ? "Shared spaces"
                            : "Albums"}
                        </div>
                      )}
                      <h1>{collection}</h1>
                    </div>
                    {layoutSwitch}
                  </div>
                )}
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
                  <div className="filter-control" ref={filterMenu}>
                    <Button
                      icon="mdiTuneVariant"
                      active={panel === "filters"}
                      aria-expanded={panel === "filters"}
                      onClick={() =>
                        panel === "filters"
                          ? setPanel(null)
                          : openFilters(filterSection || "people")
                      }
                    >
                      Filter
                      {activeChips.length + (query.text ? 1 : 0) > 0 && (
                        <span className="filter-badge">
                          {activeChips.length + (query.text ? 1 : 0)}
                        </span>
                      )}
                    </Button>
                    <Button
                      icon="mdiChevronDown"
                      className="filter-control-more"
                      aria-label="Choose a filter"
                      aria-haspopup="menu"
                      aria-expanded={filterMenuOpen}
                      onClick={() => setFilterMenuOpen((value) => !value)}
                    />
                    {filterMenuOpen && (
                      <div className="filter-menu" role="menu">
                        {[
                          ["people", "People", "mdiAccountMultipleOutline"],
                          ["date", "Date", "mdiCalendarRange"],
                          ["places", "Places", "mdiMapMarker"],
                          ["media", "Media", "mdiPlayBoxOutline"],
                          ["tags", "Tags", "mdiTagOutline"],
                          ["camera", "All filters", "mdiTuneVariant"],
                        ].map(([section, label, icon]) => (
                          <button
                            type="button"
                            role="menuitem"
                            key={section}
                            onClick={() => {
                              setFilterMenuOpen(false);
                              openFilters(section);
                            }}
                          >
                            <Icon name={icon} size={16} />
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
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
                  {session.layout === "work" &&
                    session.state.view === "grid" && (
                      <Button
                        icon="mdiFormatText"
                        aria-label={
                          showFilenames ? "Hide file names" : "Show file names"
                        }
                        title={
                          showFilenames ? "Hide file names" : "Show file names"
                        }
                        active={showFilenames}
                        onClick={() => {
                          const next = !showFilenames;
                          setShowFilenames(next);
                          try {
                            localStorage.setItem(
                              "frameleaf-work-filenames",
                              String(next),
                            );
                          } catch {}
                        }}
                      />
                    )}
                  <Button
                    icon="mdiDotsHorizontal"
                    aria-label="More library actions"
                    onClick={() => setPanel("actions")}
                  />
                </div>
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
                    rowScale={size / DEFAULT_THUMB_SIZE}
                    selected={new Set(session.selection)}
                    grouping={session.state.grouping}
                    order={
                      session.state.sort === "captured-asc" ? "asc" : "desc"
                    }
                    onGroupingChange={(grouping) => patchView({ grouping })}
                    onSelect={toggleSelect}
                    onSelectGroup={selectGroupIds}
                    onOpen={(id) => openViewer(id)}
                    onFavorite={favoriteAsset}
                    onEdit={editAsset}
                    onShare={shareAsset}
                    onMore={(id) => openViewer(id)}
                    ratings={(asset) => rate(asset)}
                    showCaptions={session.layout !== "browse"}
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
                    className={`media-grid ${session.state.view === "list" ? "media-list" : ""} ${showFilenames ? "show-filenames" : ""}`}
                    style={{ "--thumb-size": `${size}px` }}
                  >
                    {pageOf.visible.map(assetTile)}
                  </div>
                )}
                {pageOf.hasMore && session.layout !== "timeline" && (
                  <div className="load-more">
                    <Button onClick={() => setPage((value) => value + 1)}>
                      Show more ({pageOf.remaining} remaining)
                    </Button>
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
            {activityOpen && currentCollection && (
              <ActivityPanel
                activity={activityFor(collections, currentCollection.id)}
                users={resources.users}
                currentUserId="taylor"
                enabled={currentCollection.commentsEnabled !== false}
                onClose={() => setActivityOpen(false)}
                onLike={() =>
                  setCollections((state) =>
                    toggleLike(state, currentCollection.id, "taylor", null),
                  )
                }
                onComment={(text) =>
                  setCollections((state) =>
                    addActivity(state, currentCollection.id, {
                      userId: "taylor",
                      type: "comment",
                      text,
                      assetId: null,
                    }),
                  )
                }
                onDelete={(activityId) =>
                  setCollections((state) =>
                    removeActivity(state, currentCollection.id, activityId),
                  )
                }
              />
            )}
            {inspector &&
              !activityOpen &&
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
        {screen === "studio" && (
          <Studio
            assets={accessibleAssets}
            selectedId={selected?.id || null}
            onSelectAsset={(id) => {
              const asset = collectionAssets.find((item) => item.id === id);
              if (asset) open(asset);
            }}
            destination={destination}
            setDestination={setDestination}
            enqueue={(kind, payload = {}) => {
              const job = {
                ...createSimulatedJob(kind, selected, edit, payload?.cloud ? "cloud" : destination),
                name: payload?.project?.name || selected.name,
                ...(payload?.preview ? { preview: true } : {}),
                ...(payload?.estimate ? { estimate: payload.estimate } : {}),
                ...(payload?.settings ? { settings: payload.settings } : {}),
                ...(payload?.cloud ? { cloud: payload.cloud } : {}),
              };
              setJobs((current) => [job, ...current]);
              setToast(
                payload?.cloud
                  ? `${kind} sent to Frameleaf Cloud. Follow it in Activity.`
                  : `${kind} queued. Follow it in Activity.`,
              );
              return job.id;
            }}
            {...cloudActions}
            back={() => setScreen("library")}
            notify={setToast}
            people={people}
            onOpenActivity={() => setScreen("activity")}
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
            assets={accessibleAssets}
            onOpenAsset={(id) => openViewer(id)}
            onOpenSettings={openSettings}
            uploads={uploads}
            onOpenUploads={() => setUploadsMinimized(false)}
            notify={setToast}
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
      {/* Counts, selection and draft state only mean something where photos
          are browsed; Studio keeps its own save status. */}
      {["library", "person", "partner"].includes(screen) && (
        <footer className="bottom-bar">
          <span>
            {visible.length} of {collectionAssets.length} items <i />
            {session.selection.length} selected
            {session.selection.length > selectedVisible.length &&
              ` (${session.selection.length - selectedVisible.length} outside these results)`}
          </span>
          {/* Compare, Quick edit and Open in Studio live on the selection bar,
              which takes this bar's place while anything is selected. */}
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
          slideshowTitle={collection}
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
          people={people}
          faces={getAssetFaces(
            faceState,
            viewableAssets.find((asset) => asset.id === viewerId) || {},
          )}
          albums={albumOptions}
          tagOptions={tags}
          castDevices={CAST_DEVICES}
          ratings={(id) => {
            const asset = catalog.find((item) => item.id === id);
            return asset ? rate(asset) : 0;
          }}
          users={resources.users}
          albumId={
            session.state.scope.kind === "album" ? session.state.scope.id : null
          }
          onFavorite={favoriteAsset}
          onEdit={editAsset}
          onTrash={trashAsset}
          onShare={shareAsset}
          onAction={viewerAction}
          onUpdate={updateAsset}
          onFaceAction={faceAction}
          slideshow={slideshow}
          onSlideshowChange={setSlideshow}
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
        <ShareSheet
          assets={
            actionAssetId
              ? catalog.filter((asset) => asset.id === actionAssetId)
              : selectedVisible
          }
          people={people.filter(
            (person) => !isUnnamed(person) && !person.hidden,
          )}
          recipients={recipients}
          onRecipients={setRecipients}
          onCreateLink={(target) => {
            setLinkTarget(target);
            setPanel("share-link");
          }}
          onSendCopy={() =>
            sendCopy(
              actionAssetId
                ? [actionAssetId]
                : selectedVisible.map((asset) => asset.id),
            )
          }
          onClose={() => setPanel(null)}
          onAction={(kind, payload) => {
            const ids = (
              payload?.assetIds ||
              payload?.assets ||
              (actionAssetId ? [actionAssetId] : selectedVisible)
            ).map((item) => (typeof item === "string" ? item : item.id));
            if (kind === "save") {
              let ok = true;
              for (const id of ids)
                ok = mutateAsset(id, { sharedWith: recipients }) && ok;
              if (ok) {
                setPanel(null);
                setToast("Sharing preferences saved.");
              }
              return ok;
            }
            if (kind === "download") return startDownload(ids);
            if (kind === "copy") {
              setToast("Copied to the clipboard.");
              return true;
            }
            return false;
          }}
        />
      )}
      {panel === "share-link" && (
        <SharedLinkForm
          link={null}
          target={
            linkTarget || {
              type: "individual",
              assetIds: actionAssetId
                ? [actionAssetId]
                : selectedVisible.map((asset) => asset.id),
              name: actionAssetId
                ? catalog.find((asset) => asset.id === actionAssetId)?.name
                : `${selectedVisible.length} items`,
            }
          }
          links={links}
          assets={catalog}
          onSave={(input) => {
            const result = createSharedLink({ links }, input);
            setLinks(result.state.links);
            return result.link;
          }}
          onClose={() => {
            setPanel(null);
            setLinkTarget(null);
          }}
          onOpen={(link) => {
            setPanel(null);
            setLinkTarget(null);
            setPublicLink(link);
            setScreen("public");
          }}
        />
      )}
      {panel === "add-to-album" && (
        <Dialog
          title="Add to album"
          close={() => setPanel(null)}
          actions={
            <Button
              primary
              onClick={() => {
                const ids = actionAssetId
                  ? [actionAssetId]
                  : selectedVisible.map((asset) => asset.id);
                if (bulkAction("add-to-album", ids, { albumId: albumTarget }))
                  setPanel(null);
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
              {albumOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
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
      {screen === "library" && (
        <SelectionBar
          count={selectedVisible.length}
          total={visible.length}
          context={{
            albumId:
              session.state.scope.kind === "album"
                ? session.state.scope.id
                : undefined,
          }}
          assets={selectedVisible}
          tagOptions={tags}
          onAction={selectionAction}
          onClear={clearSelection}
          onSelectAll={selectAllVisible}
          // #1 one toolbar: while selecting, the library bar's own actions join the selection bar.
          leading={[
            {
              id: "compare",
              label: "Compare",
              icon: "mdiCompare",
              disabled: selectedVisible.length < 2,
              onClick: () => patchView({ view: "compare" }),
            },
            {
              id: "quick-edit",
              label: "Quick edit",
              icon: "mdiPencilOutline",
              onClick: () => setPanel("quick"),
            },
            {
              id: "studio",
              label: "Open in Studio",
              icon: "mdiOpenInNew",
              primary: true,
              onClick: () => setScreen("studio"),
            },
          ]}
        />
      )}
      {helpOpen && <ShortcutsHelp close={() => setHelpOpen(false)} />}
      {paletteQuery !== null && (
        <CommandPalette
          index={commandIndex}
          initialQuery={paletteQuery}
          onRun={runCommand}
          onClose={() => setPaletteQuery(null)}
        />
      )}
      {playingMemory && (
        <MemoryPlayer
          memory={playingMemory}
          assets={exploreAssets}
          people={people}
          overrides={memoryOverrides}
          onClose={() => setPlayingMemory(null)}
          onChange={(next) => setMemoryOverrides(next)}
          onShare={(ids) => {
            setPlayingMemory(null);
            dispatch({ type: "selection", ids });
            setActionAssetId(null);
            setScreen("library");
            setPanel("share");
          }}
          onViewInTimeline={(assetId) => {
            setPlayingMemory(null);
            mediaAction("view-in-timeline", assetId);
          }}
          onStudio={(memory, ids) => {
            setPlayingMemory(null);
            if (ids?.length) dispatch({ type: "selection", ids });
            setScreen("studio");
          }}
          onOpenAsset={(id) => {
            setPlayingMemory(null);
            openViewer(id, "explore");
          }}
          onFavoriteAsset={(id) => favoriteAsset(id)}
        />
      )}
      <input
        ref={uploadInput}
        type="file"
        multiple
        accept="image/*,video/*"
        hidden
        onChange={(event) => {
          addUploads(event.target.files, { albumId: uploadTargetId });
          setUploadTargetId(null);
          event.target.value = "";
        }}
      />
      {panel === "help" && <HelpFeedback onClose={() => setPanel(null)} />}
      {panel === "about" && <About onClose={() => setPanel(null)} />}
      {panel === "avatar" && (
        <AvatarEditor
          user={currentUser}
          photos={accessibleAssets.slice(0, 12)}
          initial={avatar}
          onSave={(value) => {
            setAvatar(value);
            setPanel(null);
            setToast("Avatar updated.");
          }}
          onClose={() => setPanel(null)}
        />
      )}
      <DragDropOverlay
        active={dragActive}
        onDrop={(files) => addUploads(files)}
      />
      {(uploads.length > 0 || downloads.length > 0) && (
        <PanelDock>
          {uploads.length > 0 && (
            <UploadPanel
              uploads={uploads}
              onChange={setUploads}
              concurrency={uploadConcurrency}
              onConcurrency={setUploadConcurrency}
              minimized={uploadsMinimized}
              onMinimize={setUploadsMinimized}
            />
          )}
          {downloads.length > 0 && (
            <DownloadPanel downloads={downloads} onChange={setDownloads} />
          )}
        </PanelDock>
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{typeof toast === "string" ? toast : toast.text}</span>
          {typeof toast === "object" && toast.action && (
            <button
              className="toast-action"
              onClick={() => {
                toast.action.run();
                setToast("");
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <Icon name="mdiClose" />
          </button>
        </div>
      )}
      {panel === "search" && (
        <SearchPalette
          query={query}
          searchBy={searchBy}
          collection={collection}
          scopedAssets={scopedAssets}
          allAssets={accessibleAssets}
          people={people}
          tags={tags}
          ratings={ratings}
          recent={recentSearches}
          commandIndex={commandIndex}
          onCommand={runCommand}
          onOpenPalette={(text) => {
            setPanel(null);
            setPaletteQuery(text || "");
          }}
          close={() => setPanel(null)}
          submit={applySearch}
          save={(...args) => {
            applySearch(...args);
            setPanel("save");
          }}
          openAsset={(id, ...args) => {
            applySearch(...args);
            setPendingOpen(id);
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
