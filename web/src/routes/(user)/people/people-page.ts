/** The People grid reads people in the largest page `GET /people` allows (`size` max 1000). */
export const PEOPLE_PAGE_SIZE: number = 1000;
/** The grid stops reading after this many people and says it is showing only the first ones. */
export const PEOPLE_CAP: number = 5000;
/** How often the page re-reads People while photos still wait for face recognition (FL-1419). */
export const WAITING_REFRESH_MS: number = 30_000;
