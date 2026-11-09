// FL-1337: a thumbnail job that hands its photo to Library care returns Skipped, like a hidden asset or a partner
// copy does. Only the hand-off must hold back the follow-up work, so the media service notes the photo here and
// the job service takes the note when the job settles. Process-local and short-lived: nothing is persisted.
const handedToCare = new Set<string>();

export const noteHandedToCare = (assetId: string) => void handedToCare.add(assetId);

/** True once for a photo that was just handed to Library care. */
export const takeHandedToCare = (assetId: string) => handedToCare.delete(assetId);
