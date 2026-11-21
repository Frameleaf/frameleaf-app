/**
 * FL-1427 Creators: what a pasted address means, decided without asking.
 * A whole channel, account, profile or page is followed; one video or post is downloaded and its
 * creator is added, not followed. Anything that is not a page a Library can save from is `null`.
 * The Library still inspects the address; this only chooses which form to show while it does.
 */
export type MediaPlatform =
  | 'youtube'
  | 'x'
  | 'pinterest'
  | 'facebook'
  | 'reddit'
  | 'bluesky'
  | 'redgifs'
  | 'instagram'
  | 'tiktok'
  | 'tumblr'
  | 'vimeo'
  | 'twitch'
  | 'imgur'
  | 'flickr'
  | 'deviantart'
  | 'other';
export type MediaAddress = {
  platform: MediaPlatform;
  action: 'follow' | 'download';
  what:
    | 'channel'
    | 'account'
    | 'profile'
    | 'board'
    | 'page'
    | 'subreddit'
    | 'blog'
    | 'video'
    | 'short'
    | 'reel'
    | 'clip'
    | 'playlist'
    | 'post'
    | 'pin'
    | 'image'
    | 'album';
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
  if (path.includes('comments')) {
    return download('reddit', 'post');
  }
  return path[0] === 'r' && path.length === 2 ? follow('reddit', 'subreddit') : null;
};

/** A name that is a site's own page (search, settings, sign-in), never someone's account. */
const own = (name: string | undefined, pages: string[]) => !name || pages.includes(name.toLowerCase());

const redgifs = (path: string[]) => {
  if (path[0] === 'users' && path[1]) {
    return follow('redgifs', 'profile');
  }
  return ['watch', 'ifr'].includes(path[0]) && path[1] ? download('redgifs', 'video') : null;
};

const instagram = (path: string[]) => {
  const at = ['p', 'reel', 'reels', 'tv'].includes(path[1]) ? 1 : 0;
  const named = path.length > at + 1;
  if (path[at] === 'p' && named) {
    return download('instagram', 'post');
  }
  if (['reel', 'reels', 'tv'].includes(path[at]) && named) {
    return download('instagram', 'reel');
  }
  const pages = ['explore', 'accounts', 'direct', 'stories', 'about', 'legal', 'developer', 'reels', 'p', 'tv'];
  return path.length === 1 && !own(path[0], pages) ? follow('instagram', 'account') : null;
};

const tiktok = (site: string, path: string[]) => {
  if (site === 'vm.tiktok.com' || site === 'vt.tiktok.com') {
    return path[0] ? download('tiktok', 'video') : null;
  }
  if (!path[0]?.startsWith('@')) {
    return null;
  }
  if (path[1] === 'video' && path[2]) {
    return download('tiktok', 'video');
  }
  if (path[1] === 'photo' && path[2]) {
    return download('tiktok', 'post');
  }
  return path.length === 1 ? follow('tiktok', 'account') : null;
};

const tumblr = (site: string, path: string[]) => {
  // someone.tumblr.com, or tumblr.com/someone
  const blog = site.endsWith('.tumblr.com');
  const rest = blog ? path : path.slice(1);
  if (
    !blog &&
    own(path[0], [
      'dashboard',
      'explore',
      'tagged',
      'search',
      'settings',
      'likes',
      'following',
      'inbox',
      'login',
      'register',
    ])
  ) {
    return null;
  }
  if (blog ? rest[0] === 'post' && rest[1] : /^\d+$/.test(rest[0] ?? '')) {
    return download('tumblr', 'post');
  }
  return rest.length === 0 ? follow('tumblr', 'blog') : null;
};

const vimeo = (path: string[]) => {
  if (/^\d+$/.test(path[0] ?? '')) {
    return download('vimeo', 'video');
  }
  if (path[0] === 'channels' && path[1]) {
    return /^\d+$/.test(path[2] ?? '') ? download('vimeo', 'video') : follow('vimeo', 'channel');
  }
  const pages = [
    'watch',
    'search',
    'features',
    'upload',
    'log_in',
    'join',
    'categories',
    'blog',
    'help',
    'ondemand',
    'showcase',
    'manage',
  ];
  return path.length === 1 && !own(path[0], pages) ? follow('vimeo', 'account') : null;
};

const twitch = (site: string, path: string[]) => {
  if (site === 'clips.twitch.tv') {
    return path[0] ? download('twitch', 'clip') : null;
  }
  if (path[0] === 'videos' && path[1]) {
    return download('twitch', 'video');
  }
  const pages = [
    'directory',
    'downloads',
    'jobs',
    'p',
    'search',
    'settings',
    'subscriptions',
    'turbo',
    'wallet',
    'inventory',
    'drops',
    'videos',
  ];
  if (own(path[0], pages)) {
    return null;
  }
  if (path[1] === 'clip' && path[2]) {
    return download('twitch', 'clip');
  }
  return path.length === 1 || (path.length === 2 && path[1] === 'videos') ? follow('twitch', 'channel') : null;
};

const imgur = (site: string, path: string[]) => {
  if (site === 'i.imgur.com') {
    return path[0] ? download('imgur', 'image') : null;
  }
  if (path[0] === 'user' && path[1]) {
    return path.length === 2 || path[2] === 'posts' ? follow('imgur', 'account') : null;
  }
  if (['a', 'gallery'].includes(path[0]) && path[1]) {
    return download('imgur', 'album');
  }
  return path.length === 1 && /^\w{5,8}$/.test(path[0]) ? download('imgur', 'image') : null;
};

const flickr = (site: string, path: string[]) => {
  if (site === 'flic.kr') {
    return path[0] ? download('flickr', 'image') : null;
  }
  if (path[0] !== 'photos' || !path[1] || own(path[1], ['tags', 'search'])) {
    return null;
  }
  if (path[2] === 'albums' && path[3]) {
    return download('flickr', 'album');
  }
  if (/^\d+$/.test(path[2] ?? '')) {
    return download('flickr', 'image');
  }
  return path.length === 2 ? follow('flickr', 'account') : null;
};

const deviantart = (path: string[]) => {
  const pages = [
    'search',
    'tag',
    'topic',
    'watch',
    'daily-deviations',
    'popular',
    'core-membership',
    'about',
    'notifications',
    'settings',
    'users',
    'join',
  ];
  if (own(path[0], pages)) {
    return null;
  }
  if (path[1] === 'art' && path[2]) {
    return download('deviantart', 'post');
  }
  return path.length === 1 || (path.length === 2 && path[1] === 'gallery') ? follow('deviantart', 'account') : null;
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
  if (site === 'redgifs.com') {
    return redgifs(path);
  }
  if (site === 'instagram.com') {
    return instagram(path);
  }
  if (['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'].includes(site)) {
    return tiktok(site, path);
  }
  if (site === 'tumblr.com' || site.endsWith('.tumblr.com')) {
    return tumblr(site, path);
  }
  if (site === 'vimeo.com') {
    return vimeo(path);
  }
  if (site === 'twitch.tv' || site === 'clips.twitch.tv') {
    return twitch(site, path);
  }
  if (site === 'imgur.com' || site === 'i.imgur.com') {
    return imgur(site, path);
  }
  if (site === 'flickr.com' || site === 'flic.kr') {
    return flickr(site, path);
  }
  if (site === 'deviantart.com') {
    return deviantart(path);
  }
  return download('other', 'page');
};
