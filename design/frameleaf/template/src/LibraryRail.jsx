import React, { useState } from "react";
import { Icon } from "./Icon";

const CLOSED_KEY = "frameleaf.rail.closedSections";
const readClosed = () => {
  try {
    const value = JSON.parse(localStorage.getItem(CLOSED_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

export function LibraryRail({
  collapsed = false,
  setCollapsed,
  navOpen = false,
  collection,
  screen,
  navigate,
  openPeople,
  openExplore,
  presets = [],
  onPreset,
  onSave,
  onNewSpace,
  onCare,
  onSettings,
  onTool,
  onTrash,
  collectionsTree = [],
  onCollection,
  onCollections,
  onSharedLinks,
  onPartner,
  onScreen,
  onBuy,
}) {
  const toggleLabel = collapsed ? "Expand navigation" : "Collapse navigation";
  // Sections fold away so the rail fits a laptop screen; remembered per device.
  const [closed, setClosed] = useState(readClosed);
  const toggleSection = (id) =>
    setClosed((current) => {
      const next = current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id];
      try {
        localStorage.setItem(CLOSED_KEY, JSON.stringify(next));
      } catch {
        /* per-device convenience only */
      }
      return next;
    });
  // The icon-only rail has no headings to reopen a section, so show everything.
  const open = (id) => collapsed || !closed.includes(id);
  const heading = (id, label, action) => (
    <div className="nav-heading">
      <button
        type="button"
        className="rail-heading-toggle rail-label"
        aria-expanded={open(id)}
        onClick={() => toggleSection(id)}
      >
        {label}
        <Icon name="mdiChevronDown" size={14} />
      </button>
      {action}
    </div>
  );
  const link = (
    destination,
    icon,
    onClick,
    { nested = false, active, label = destination } = {},
  ) => (
    <button
      key={destination}
      type="button"
      className={`rail-link${nested ? " nested" : ""}${(active ?? (screen === "library" && collection === destination)) ? " chosen" : ""}`}
      aria-label={destination}
      title={destination}
      aria-current={
        (active ?? (screen === "library" && collection === destination))
          ? "page"
          : undefined
      }
      onClick={onClick}
    >
      <Icon name={icon} />
      <span className="rail-label">{label}</span>
    </button>
  );
  const addButton = (label, onClick) => (
    <button
      type="button"
      className="button"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon name="mdiPlus" size={16} />
    </button>
  );

  return (
    <aside
      className={`sidebar${collapsed ? " rail-collapsed" : ""}${navOpen ? " mobile-open" : ""}`}
    >
      <div className="rail-header">
        <span className="rail-label">Library</span>
        <button
          type="button"
          className="rail-toggle"
          aria-label={toggleLabel}
          title={toggleLabel}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          <Icon
            name={collapsed ? "mdiChevronDoubleRight" : "mdiChevronDoubleLeft"}
          />
        </button>
      </div>
      <nav aria-label="Library navigation">
        {[
          ["Library", "mdiImageMultipleOutline"],
          ["Favorites", "mdiHeartOutline"],
          ["Recently added", "mdiClockOutline"],
          ["Best Photos", "mdiStarOutline"],
          ["Archive", "mdiArchiveOutline"],
          ["Locked", "mdiShieldLockOutline"],
        ].map(([title, icon]) => link(title, icon, () => navigate(title)))}

        {heading("explore", "Explore")}
        {open("explore") && (
          <>
            {link(
              "Explore",
              "mdiImageSearchOutline",
              () => openExplore("Explore"),
              { active: screen === "explore" },
            )}
            {link("People", "mdiAccountOutline", openPeople, {
              active: ["people", "person", "people-manage"].includes(screen),
            })}
            {link("Pets", "mdiPawOutline", () => openExplore("Pets"))}
            {link("Memories", "mdiHistory", () => onScreen?.("memories"), {
              active: screen === "memories",
            })}
            {link(
              "Places",
              "mdiMapMarkerMultipleOutline",
              () => onScreen?.("places"),
              { active: screen === "places" },
            )}
            {link("Map", "mdiMapOutline", () => onScreen?.("map"), {
              active: screen === "map",
            })}
            {link("Tags", "mdiTagMultipleOutline", () => onScreen?.("tags"), {
              active: screen === "tags",
            })}
            {link(
              "Folders",
              "mdiFolderMultipleOutline",
              () => onScreen?.("folders"),
              { active: screen === "folders" },
            )}
            {link("Documents", "mdiTextBoxSearchOutline", () =>
              openExplore("Documents"),
            )}
          </>
        )}

        {heading("albums", "Albums", addButton("New album", onSave))}
        {open("albums") && (
          <>
            {link("All albums", "mdiImageAlbum", onCollections, {
              active: screen === "collections",
            })}
            {collectionsTree
              .filter(({ collection: item }) => item.kind !== "space")
              .map(({ collection: item, depth }) =>
                link(
                  item.name,
                  item.icon || "mdiFolderOutline",
                  () => onCollection?.(item),
                  {
                    nested: depth > 0,
                    active:
                      (screen === "library" || screen === "person") &&
                      collection === item.name,
                  },
                ),
              )}
            {presets.map((item) => (
              <React.Fragment key={item.id}>
                {link(
                  item.name,
                  item.kind === "Album snapshot"
                    ? "mdiFolderOutline"
                    : item.kind === "Filter preset"
                      ? "mdiFilterOutline"
                      : "mdiFolderSearchOutline",
                  () => onPreset(item),
                  { nested: true },
                )}
              </React.Fragment>
            ))}
            {link("Shared links", "mdiLinkVariant", onSharedLinks, {
              active: screen === "shared-links",
            })}
          </>
        )}

        {heading(
          "spaces",
          "Shared spaces",
          addButton("New shared space", onNewSpace),
        )}
        {open("spaces") && (
          <>
            {collectionsTree
              .filter(({ collection: item }) => item.kind === "space")
              .map(({ collection: item }) =>
                link(
                  item.name,
                  item.icon || "mdiAccountMultipleOutline",
                  () => onCollection?.(item),
                  {
                    active: screen === "library" && collection === item.name,
                    label: item.name.replace(/ Space$/, ""),
                  },
                ),
              )}
            {!collectionsTree.some(
              ({ collection: item }) => item.kind === "space",
            ) &&
              link(
                "Family Space",
                "mdiAccountMultipleOutline",
                () => navigate("Family Space"),
                { label: "Family" },
              )}
            {link("Jamie's library", "mdiAccountOutline", onPartner, {
              active: screen === "partner",
            })}
          </>
        )}

        {heading("tools", "Tools")}
        {open("tools") && (
          <>
            {link("Workflows", "mdiTuneVariant", () => onTool?.("workflows"))}
            {link("Trash", "mdiDeleteOutline", onTrash)}
          </>
        )}
      </nav>
      <div className="sidebar-bottom">
        {link("Library Care", "mdiShieldCheckOutline", onCare, {
          active: screen === "care",
        })}
        {link("Settings", "mdiCogOutline", onSettings, {
          active: screen === "admin",
        })}
        {link("Support Frameleaf", "mdiHandHeartOutline", onBuy, {
          active: screen === "buy",
        })}
      </div>
    </aside>
  );
}
