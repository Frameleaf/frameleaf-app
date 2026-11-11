// Mirrors web/src/lib/frameleaf/media-address.ts (the extension cannot import from web/): keep the two in step.
/**
 * FL-1427 Creators: what a pasted address means, decided without asking.
 * A whole channel, account, profile or page is followed; one video or post is downloaded and its
 * creator is added, not followed. Anything that is not a page a Library can save from is `null`.
 * The Library still inspects the address; this only chooses which form to show while it does.
 */
export type MediaPlatform = 'youtube' | 'x' | 'pinterest' | 'facebook' | 'reddit' | 'bluesky' | 'other';
export type MediaAddress = {
  platform: MediaPlatform;
  action: 'follow' | 'download';
  what: 'channel' | 'account' | 'profile' | 'board' | 'page' | 'video' | 'short' | 'playlist' | 'post' | 'pin';
};

const follow = (platform: MediaPlatform, what: MediaAddress['what']): MediaAddress => ({
  platform,
  action: 'follow',
  what,
});
const download = (platform: MediaPlatform, what: MediaAddress['what']): MediaAddress => ({
  platform,
  action: 'download',
  what,
});

const youtube = (path: string[]) => {
  if (path[0] === 'watch' || path[0] === 'live') {
    return download('youtube', 'video');
  }
  if (path[0] === 'shorts') {
    return download('youtube', 'short');
  }
  if (path[0] === 'playlist') {
    return download('youtube', 'playlist');
  }
  if (path[0]?.startsWith('@') || ['channel', 'c', 'user'].includes(path[0])) {
    return follow('youtube', 'channel');
  }
  return null;
};

const pinterest = (site: string, path: string[]) => {
  if (path[0] === 'pin' || site === 'pin.it') {
    return download('pinterest', 'pin');
  }
  if (path.length === 1) {
    return follow('pinterest', 'profile');
  }
  return path.length === 2 ? follow('pinterest', 'board') : null;
};

const facebook = (site: string, path: string[]) => {
  const single =
    site === 'fb.watch' ||
    ['watch', 'reel', 'photo', 'share'].includes(path[0]) ||
    path.includes('videos') ||
    path.includes('posts');
  if (single) {
    return download('facebook', 'post');
  }
  return path.length === 1 ? follow('facebook', 'page') : null;
};

const reddit = (path: string[]) => {
  if (path[0] === 'user' || path[0] === 'u') {
    return path.length === 2 ? follow('reddit', 'account') : download('reddit', 'post');
  }
  return path.includes('comments') ? download('reddit', 'post') : null;
};

const bluesky = (path: string[]) => {
  if (path[0] !== 'profile') {
    return null;
  }
  return path[2] === 'post' ? download('bluesky', 'post') : follow('bluesky', 'account');
};

export const readMediaAddress = (text: string): MediaAddress | null => {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  const site = url.hostname.replace(/^(www|m|mobile)\./, '');
  const path = url.pathname.split('/').filter(Boolean);

  if (site === 'youtu.be') {
    return download('youtube', 'video');
  }
  if (site.endsWith('youtube.com')) {
    return youtube(path);
  }
  if (site === 'x.com' || site === 'twitter.com') {
    if (path[1] === 'status') {
      return download('x', 'post');
    }
    return path.length === 1 ? follow('x', 'account') : null;
  }
  if (site.endsWith('pinterest.com') || site === 'pin.it') {
    return pinterest(site, path);
  }
  if (site.endsWith('facebook.com') || site === 'fb.watch') {
    return facebook(site, path);
  }
  if (site.endsWith('reddit.com')) {
    return reddit(path);
  }
  if (site === 'bsky.app') {
    return bluesky(path);
  }
  return download('other', 'page');
};
