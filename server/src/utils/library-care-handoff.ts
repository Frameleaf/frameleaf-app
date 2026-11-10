// FL-1337: a thumbnail job that hands its photo to Library care returns Skipped, like a hidden asset or a partner
// copy does. Only the hand-off must hold back the follow-up work, so the media service notes the photo here and
// the job service takes the note when the job settles. Process-local and short-lived: nothing is persisted.
const handedToCare = new Set<string>();

// The media service notes the id the database returns (lower case); the job service takes the id the job was queued
// with, which a client may have sent in upper case. Both are keyed in lower case, so the note is always taken.
const key = (assetId: string) => assetId.toLowerCase();

export const noteHandedToCare = (assetId: string) => void handedToCare.add(key(assetId));

/** True once for a photo that was just handed to Library care. */
export const takeHandedToCare = (assetId: string) => handedToCare.delete(key(assetId));
