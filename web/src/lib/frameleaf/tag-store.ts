import { getAllTags, type TagResponseDto } from '@frameleaf/sdk';
import { sessionCache } from '$lib/frameleaf/session-cache';

const tags = sessionCache<TagResponseDto[]>(() => getAllTags());

/**
 * FL-1802: the account's tags, read once and shared by every screen that lists them (the Tags page,
 * the tag pickers, the filter panel). Call `invalidateTags` after creating, renaming, moving,
 * recolouring or deleting a tag; the next reader asks the server again.
 */
export const loadAllTags = (): Promise<TagResponseDto[]> => tags.get();
export const invalidateTags = () => tags.invalidate();
