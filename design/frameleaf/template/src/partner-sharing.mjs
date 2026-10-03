/**
 * Partner sharing v2: a partner receives their own copies of what you share.
 * Copies follow your edits until the partner changes that detail themselves.
 */

/** What a partner receives, in the order the partner card lists it. */
export const PARTNER_SHARED_ITEMS = [
  { id: "assets", label: "Photos and videos", icon: "mdiImageMultipleOutline" },
  { id: "albums", label: "Albums you own", icon: "mdiImageAlbum" },
  { id: "tags", label: "Tags", icon: "mdiTagOutline" },
  { id: "people", label: "People", icon: "mdiAccountMultipleOutline" },
  {
    id: "details",
    label: "Descriptions and locations",
    icon: "mdiMapMarkerOutline",
  },
  { id: "locked", label: "Locked items", icon: "mdiLockOutline" },
];

const BACKFILL_STATES = ["queued", "running", "done", "stopped"];
const count = (value) =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
const number = (value) => value.toLocaleString("en-US");

/** Progress of the first copy into a partner's library, for the partner card. */
export function backfillProgress(backfill) {
  if (!backfill || typeof backfill !== "object") return null;
  const state = BACKFILL_STATES.includes(backfill.state)
    ? backfill.state
    : "queued";
  const total = count(backfill.total);
  const done = count(backfill.done);
  const percent =
    state === "done"
      ? 100
      : total
        ? Math.min(100, Math.floor((done / total) * 100))
        : 0;
  const items = (n) => `${number(n)} ${n === 1 ? "item" : "items"}`;
  const label =
    state === "running"
      ? `Copying ${number(Math.min(done, total))} of ${items(total)}`
      : state === "done"
        ? `Up to date · ${items(Math.max(done, total))} copied`
        : state === "stopped"
          ? `Stopped · ${items(done)} already copied stay in their library`
          : "Waiting to start";
  return { state, percent, label };
}

const titleCase = (value) =>
  value.charAt(0).toUpperCase() + value.slice(1).replace(/[-_]+/g, " ");
const possessive = (name) => (/s$/i.test(name) ? `${name}’` : `${name}’s`);

/** "From Jamie’s library" for an item that arrived through partner sharing. */
export function originLabel(origin, users = []) {
  if (!origin || typeof origin !== "object") return null;
  const id =
    typeof origin.rootOwnerId === "string" ? origin.rootOwnerId.trim() : "";
  const name =
    (typeof origin.rootOwnerName === "string" && origin.rootOwnerName.trim()) ||
    users.find((user) => user?.id === id)?.name ||
    (id ? titleCase(id) : "");
  return name ? `From ${possessive(name)} library` : null;
}

/** Sanitise a stored origin reference. */
export function parseOrigin(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id =
    typeof value.rootOwnerId === "string" ? value.rootOwnerId.trim() : "";
  return id && id.length <= 120 ? { rootOwnerId: id } : null;
}
