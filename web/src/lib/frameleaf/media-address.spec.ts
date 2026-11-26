import { readMediaAddress } from '$lib/frameleaf/media-address';

describe('readMediaAddress', () => {
  it.each([
    ['https://www.youtube.com/@maraellis', 'youtube', 'channel'],
    ['https://youtube.com/channel/UC123', 'youtube', 'channel'],
    ['https://x.com/northtimber', 'x', 'account'],
    ['https://twitter.com/northtimber', 'x', 'account'],
    ['https://www.pinterest.com/valleylight', 'pinterest', 'profile'],
    ['https://www.pinterest.com/valleylight/mountain-rooms', 'pinterest', 'board'],
    ['https://www.facebook.com/alpinelodge', 'facebook', 'page'],
    ['https://www.reddit.com/user/someone', 'reddit', 'account'],
    ['https://bsky.app/profile/someone.bsky.social', 'bluesky', 'account'],
    ['https://www.reddit.com/r/woodworking', 'reddit', 'subreddit'],
    ['https://www.redgifs.com/users/someone', 'redgifs', 'profile'],
    ['https://www.instagram.com/northtimber/', 'instagram', 'account'],
    ['https://www.tiktok.com/@northtimber', 'tiktok', 'account'],
    ['https://northtimber.tumblr.com/', 'tumblr', 'blog'],
    ['https://www.tumblr.com/northtimber', 'tumblr', 'blog'],
    ['https://vimeo.com/northtimber', 'vimeo', 'account'],
    ['https://vimeo.com/channels/staffpicks', 'vimeo', 'channel'],
    ['https://www.twitch.tv/northtimber', 'twitch', 'channel'],
    ['https://www.twitch.tv/northtimber/videos', 'twitch', 'channel'],
    ['https://imgur.com/user/northtimber', 'imgur', 'account'],
    ['https://www.flickr.com/photos/northtimber/', 'flickr', 'account'],
    ['https://www.deviantart.com/northtimber', 'deviantart', 'account'],
    ['https://www.deviantart.com/northtimber/gallery', 'deviantart', 'account'],
  ])('follows a whole channel, account, profile or page: %s', (address, platform, what) => {
    expect(readMediaAddress(address)).toEqual({ platform, action: 'follow', what });
  });

  it.each([
    ['https://www.youtube.com/watch?v=abc', 'youtube', 'video'],
    ['https://youtu.be/abc', 'youtube', 'video'],
    ['https://m.youtube.com/shorts/abc', 'youtube', 'short'],
    ['https://www.youtube.com/playlist?list=PL1', 'youtube', 'playlist'],
    ['https://x.com/northtimber/status/184', 'x', 'post'],
    ['https://www.pinterest.com/pin/123/', 'pinterest', 'pin'],
    ['https://www.facebook.com/alpinelodge/videos/99', 'facebook', 'post'],
    ['https://fb.watch/abc', 'facebook', 'post'],
    ['https://www.reddit.com/r/woodworking/comments/1/x/', 'reddit', 'post'],
    ['https://bsky.app/profile/someone.bsky.social/post/3k', 'bluesky', 'post'],
    ['https://alpinelodge.example/rooms/loft', 'other', 'page'],
  ])('downloads one video or post and never follows: %s', (address, platform, what) => {
    expect(readMediaAddress(address)).toEqual({ platform, action: 'download', what });
  });

  it.each([
    '',
    'maraellis',
    'javascript:alert(1)',
    'ftp://example.com/a',
    'https://www.youtube.com/',
    'https://x.com/a/b/c',
    'https://www.instagram.com/explore/',
    'https://www.tiktok.com/explore',
    'https://www.tumblr.com/dashboard',
    'https://www.twitch.tv/directory',
    'https://vimeo.com/search',
    'https://www.deviantart.com/search',
    'https://www.flickr.com/photos/tags/larch',
  ])('refuses what is not a page rather than guessing: %s', (address) => {
    expect(readMediaAddress(address)).toBeNull();
  });
});
