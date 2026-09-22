const cityCoordinates = {
  Banff: [51.1784, -115.5708],
  'Lake Louise': [51.4254, -116.1773],
  Jasper: [52.8737, -118.0814],
};
const sceneCity = {
  'trail-sign': 'Lake Louise',
  lake: 'Lake Louise',
  hiking: 'Banff',
  campfire: 'Banff',
  portrait: 'Lake Louise',
  forest: 'Jasper',
  cabin: 'Jasper',
  flowers: 'Banff',
  dog: 'Banff',
  creek: 'Banff',
  kayak: 'Lake Louise',
  summit: 'Banff',
  elk: 'Jasper',
};
/** Fictional capture facts so viewer, map, filters and editors have realistic metadata. */
function assetFacts(scene, type, i) {
  const apple = type === 'video' || i % 3 === 0;
  const [lat, lng] = cityCoordinates[sceneCity[scene]];
  const jitter = ((i * 7919) % 100) / 1000 - 0.05;
  const panorama = scene === 'summit';
  return {
    width: type === 'video' ? 3840 : panorama ? 12000 : apple ? 4032 : 6000,
    height: type === 'video' ? 2160 : panorama ? 3000 : apple ? 3024 : 4000,
    latitude: Number((lat + jitter).toFixed(5)),
    longitude: Number((lng + jitter * 1.4).toFixed(5)),
    fNumber: type === 'video' ? 1.8 : [2.8, 4, 5.6, 8][i % 4],
    exposureTime: type === 'video' ? '1/60' : ['1/500', '1/250', '1/1000', '1/125'][i % 4],
    iso: type === 'video' ? 200 : [100, 100, 200, 400][i % 4],
    focalLength: apple ? 24 : [24, 35, 50, 70][i % 4],
    frameRate: type === 'video' ? 29.97 : undefined,
    fileSizeInBytes:
      type === 'video'
        ? 118_000_000 + i * 21_500_000
        : panorama
          ? 48_300_000
          : 8_400_000 + (i % 7) * 2_150_000,
    libraryId: 'upload-taylor',
    checksum: `sha1-${(0x9a3f10 + i * 7919).toString(16)}`,
    ...(panorama ? { isPanorama: true } : {}),
    ...([3, 9].includes(i)
      ? { isLivePhoto: true, livePhotoVideo: '/media/lake-demo.mp4' }
      : {}),
    ...([2, 10].includes(i) ? { stackId: 'lake-stack', stackPrimary: i === 2 } : {}),
    ...(i === 16 ? { isOffline: true } : {}),
    enrichment: {
      description: {
        status: i % 4 === 1 ? 'manual' : 'generated',
        model: 'Florence-2 · local',
        confidence: Number((0.82 + (i % 5) * 0.03).toFixed(2)),
      },
      sensitive: {
        status: i === 19 ? 'needs-review' : 'reviewed',
        score: i === 19 ? 0.61 : Number(((i % 6) * 0.01).toFixed(2)),
      },
    },
  };
}
const samples = [
  ['lake', 'Lake morning.mov', 'video', 24, 3, ['Jamie']],
  ['hiking', 'Hiking with Jamie.jpg', 'photo', 0, 3, ['Jamie', 'Taylor']],
  ['lake', 'Moraine Lake.jpg', 'photo', 0, 4, []],
  [
    'campfire',
    'Campfire evening.jpg',
    'photo',
    0,
    3,
    ['Jamie', 'Emma', 'Taylor'],
  ],
  ['hiking', 'Ridge trail.jpg', 'photo', 0, 2, ['Jamie', 'Taylor']],
  ['portrait', 'Emma at the lake.jpg', 'photo', 0, 4, ['Emma']],
  ['forest', 'Forest trail.mov', 'video', 15, 2, []],
  ['cabin', 'Cabin life.jpg', 'photo', 0, 3, ['Emma']],
  ['flowers', 'Wildflowers.jpg', 'photo', 0, 2, []],
  ['dog', 'Dad and Max.jpg', 'photo', 0, 4, ['Taylor']],
  ['lake', 'Lake reflection.jpg', 'photo', 0, 3, []],
  ['creek', 'Glacier creek.jpg', 'photo', 0, 3, []],
  ['kayak', 'Kayaking.mov', 'video', 18, 4, ['Jamie']],
  ['summit', 'Summit view.jpg', 'photo', 0, 3, []],
  ['hiking', 'Family hike.jpg', 'photo', 0, 4, ['Jamie', 'Taylor']],
  ['cabin', 'Evening light.jpg', 'photo', 0, 2, []],
  ['elk', 'Elk in meadow.jpg', 'photo', 0, 3, []],
  ['portrait', 'Emma portrait.jpg', 'photo', 0, 4, ['Emma']],
  ['forest', 'Through the forest.jpg', 'photo', 0, 2, []],
  ['cabin', 'Cabin at dusk.jpg', 'photo', 0, 3, ['Taylor']],
  ['trail-sign', 'Trailhead directions.jpg', 'photo', 0, 0, []],
].map(([image, name, type, duration, rating, people], i) => ({
  id: String(i + 1),
  ...assetFacts(image, type, i),
  image: `/media/${image}.png`,
  name,
  type,
  duration,
  rating,
  people,
  date: `2026-08-${16 - Math.floor(i / 4)}`,
  favorite: i % 5 === 0,
  ownerId: 'taylor',
  ...(type === 'video' ? { mediaSrc: `/media/${image}-demo.mp4` } : {}),
  bestPhotosScore: [
    91, 73, 96, 82, 71, 94, 62, 84, 66, 95, 89, 75, 92, 93, 90, 68, 79, 87, 60,
    76, 30,
  ][i],
  addedAt: `2026-08-${18 - Math.floor(i / 5)}T12:00:00Z`,
  ...(i === 18 ? { isLocked: true } : i === 19 ? { isSuppressed: true } : {}),
}));
export const people = [
  { id: 'Jamie', name: 'Jamie', image: '/media/avatar-jamie.png' },
  { id: 'Emma', name: 'Emma', image: '/media/avatar-emma.png' },
  { id: 'Taylor', name: 'Taylor', image: '/media/avatar-taylor.png' },
];
const sceneDetails = {
  'trail-sign': [
    'A wooden trail sign beside a hiking path in a pine forest.',
    ['sign', 'hiking', 'trail', 'forest'],
    'Lake Louise',
  ],
  lake: [
    'Turquoise alpine lake below dramatic mountain peaks. A quiet reflection in clear water.',
    ['mountains', 'lake', 'landscape', 'reflection'],
    'Lake Louise',
  ],
  hiking: [
    'Family hiking together on a sunny mountain trail above the lake.',
    ['hiking', 'family', 'mountains', 'trail'],
    'Banff',
  ],
  campfire: [
    'Family gathered around a campfire at sunset in the mountains.',
    ['family', 'campfire', 'evening', 'camping'],
    'Banff',
  ],
  portrait: [
    'Emma wearing a knitted hat beside the lake, a smiling family portrait.',
    ['portrait', 'family', 'lake'],
    'Lake Louise',
  ],
  forest: [
    'Sunlight through a quiet pine forest with a walking trail.',
    ['forest', 'trail', 'trees', 'hiking'],
    'Jasper',
  ],
  cabin: [
    'A cozy cabin with warm lights in a pine forest at dusk.',
    ['cabin', 'evening', 'forest', 'travel'],
    'Jasper',
  ],
  flowers: [
    'Colorful alpine wildflowers in a meadow with mountains beyond.',
    ['flowers', 'meadow', 'mountains', 'nature'],
    'Banff',
  ],
  dog: [
    'Taylor and Max the golden retriever, enjoying a day outside.',
    ['dog', 'pet', 'family', 'portrait'],
    'Banff',
  ],
  creek: [
    'A glacier stream running over rocks through a green forest.',
    ['water', 'creek', 'forest', 'nature'],
    'Banff',
  ],
  kayak: [
    'Jamie kayaking on a turquoise lake surrounded by mountains.',
    ['kayaking', 'lake', 'adventure', 'mountains'],
    'Lake Louise',
  ],
  summit: [
    'Panoramic mountain summits and rocky peaks in sunshine.',
    ['mountains', 'summit', 'landscape'],
    'Banff',
  ],
  elk: [
    'An elk grazing in a mountain meadow near the forest.',
    ['wildlife', 'elk', 'meadow', 'nature'],
    'Jasper',
  ],
};
export const media = samples.map((asset, i) => {
  const scene = asset.image.split('/').at(-1).replace('.png', '');
  const [description, tags, city] = sceneDetails[scene];
  return {
    ...asset,
    description,
    tags,
    tagIds: tags,
    city,
    country: 'Canada',
    state: 'Alberta',
    personIds: asset.people,
    takenAt: `${asset.date}T07:14:00`,
    make: asset.type === 'video' || i % 3 === 0 ? 'Apple' : 'Sony',
    model: asset.type === 'video' || i % 3 === 0 ? 'iPhone 16 Pro' : 'α7 IV',
    lensModel:
      asset.type === 'video' || i % 3 === 0
        ? 'Main camera · 24mm'
        : 'FE 24–70mm F2.8 GM',
    originalPath: `/photos/2026/Rockies/${asset.name}`,
    originalFileName: asset.name,
    ocr: scene === 'trail-sign' ? 'LAKE AGNES 3.4 km' : '',
    albumIds: [
      'summer-rockies',
      'family',
      ...(['dog', 'portrait'].includes(scene) ? ['everyday'] : []),
    ],
    spaceIds: ['family-space'],
    visibility: i === 15 ? 'archive' : 'timeline',
  };
});
export const tags = [...new Set(media.flatMap((asset) => asset.tags))]
  .sort()
  .map((id) => ({ id, label: id }));
export function scopeMedia(assets, scope, snapshotIds = null) {
  const aliases = {
    'summer-in-the-rockies': 'summer-rockies',
    'family-space': 'family-space',
  };
  const id = aliases[scope.id] || scope.id;
  return assets.filter(
    (asset) =>
      (!snapshotIds || snapshotIds.includes(asset.id)) &&
      (scope.kind === 'library' ||
        ['library', 'favorites', 'recently-added'].includes(id) ||
        (scope.kind === 'space'
          ? asset.spaceIds.includes(id)
          : asset.albumIds.includes(id))),
  );
}
export const timecode = (seconds) =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
