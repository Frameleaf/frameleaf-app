const marker = '__FRAMELEAF_DESKTOP_LOCAL_OFFLINE_ALBUMS__';

export const hasLocalOfflineAlbums = () => Reflect.get(globalThis, marker) === true;

export const localOfflineSignOutPath = '/__frameleaf_desktop__/offline-albums/revoke';

export const offlineSessionExit = (destination: string) =>
  destination.split('?')[0] === '/auth/logout' && hasLocalOfflineAlbums() ? localOfflineSignOutPath : destination;
