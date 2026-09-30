// Design-only policies. No real gallery session, authentication or media transfer occurs.
export function changeProofSelection(selection, id, gallery = {}) {
  if (gallery.submitted)
    return { selection, error: "Your selections have been submitted." };
  if (selection.includes(id))
    return { selection: selection.filter((item) => item !== id) };
  const limit = Number(gallery.selectionLimit) || 12;
  if (selection.length >= limit)
    return { selection, error: `Choose up to ${limit} photos.` };
  return { selection: [...selection, id] };
}
export function proofAccess(gallery = {}, unlocked) {
  if (gallery.expired) return "expired";
  if (gallery.offline) return "offline";
  return gallery.password && !unlocked ? "locked" : "open";
}
export function publicPhoto({ id, image, name, previewFilter }) {
  return {
    id,
    image,
    name,
    ...(typeof previewFilter === "string" ? { previewFilter } : {}),
  };
}
