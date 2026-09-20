import React from "react";
import { Icon } from "./Icon";

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
  onCare,
  onSettings,
  onTool,
  onTrash,
}) {
  const toggleLabel = collapsed ? "Expand navigation" : "Collapse navigation";
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

        <div className="nav-heading">
          <span className="rail-label">Collections</span>
        </div>
        {link("Create collection", "mdiPlus", onSave, { active: false })}
        {link("Family", "mdiFolderMultipleOutline", () => navigate("Family"))}
        {[
          ["Summer in the Rockies", "mdiWhiteBalanceSunny"],
          ["Winter 2026", "mdiCalendarRange"],
          ["Everyday", "mdiCameraOutline"],
        ].map(([title, icon]) =>
          link(title, icon, () => navigate(title), { nested: true }),
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

        <div className="nav-heading">
          <span className="rail-label">Shared Spaces</span>
        </div>
        {link(
          "Family Space",
          "mdiAccountMultipleOutline",
          () => navigate("Family Space"),
          { label: "Family" },
        )}

        <div className="nav-heading">
          <span className="rail-label">Explore</span>
        </div>
        {link(
          "Explore",
          "mdiImageSearchOutline",
          () => openExplore("Explore"),
          { active: screen === "explore" },
        )}
        {link("People", "mdiAccountOutline", openPeople, {
          active: screen === "people",
        })}
        {[
          ["Pets", "mdiPawOutline"],
          ["Places", "mdiMapOutline"],
          ["Memories", "mdiHistory"],
          ["Documents", "mdiTextBoxSearchOutline"],
        ].map(([title, icon]) => link(title, icon, () => openExplore(title)))}
        <div className="nav-heading">
          <span className="rail-label">Tools</span>
        </div>
        {[["Workflows", "mdiTuneVariant", "workflows"]].map(
          ([title, icon, section]) =>
            link(title, icon, () => onTool?.(section)),
        )}
        {link("Trash", "mdiDeleteOutline", onTrash)}
      </nav>
      <div className="sidebar-bottom">
        {link("Library Care", "mdiShieldCheckOutline", onCare, {
          active: screen === "care",
        })}
        {link("Settings", "mdiCogOutline", onSettings, {
          active: screen === "admin",
        })}
      </div>
    </aside>
  );
}
