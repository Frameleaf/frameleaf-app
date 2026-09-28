import * as materialIcons from "@mdi/js";

/**
 * Albums, the collections that group them, and shared spaces as first-class
 * managed objects. A "collection" holds albums; an "album" holds photos; a
 * "space" is a shared top-level library that several people add to.
 * Pure module: every function takes state and returns a new state (or a value)
 * without touching the DOM. Persistence helpers live at the bottom.
 */
export const collectionsKey = "frameleaf:collections:v1";

/** Curated, categorised icons offered first; any Material icon name is still valid. */
export const collectionIconGroups = [
  {
    label: "Albums and photos",
    icons: [
      { name: "mdiImageAlbum", label: "Album" },
      { name: "mdiImageMultipleOutline", label: "Photos" },
      { name: "mdiFolderOutline", label: "Folder" },
      { name: "mdiFolderMultipleOutline", label: "Folders" },
      { name: "mdiCameraOutline", label: "Camera" },
      { name: "mdiVideoOutline", label: "Video" },
      { name: "mdiFilmstrip", label: "Film" },
      { name: "mdiMovieOpenOutline", label: "Movie" },
      { name: "mdiPanoramaOutline", label: "Panorama" },
      { name: "mdiCameraBurst", label: "Burst" },
      { name: "mdiDrone", label: "Drone" },
      { name: "mdiBookOpenPageVariantOutline", label: "Scrapbook" },
      { name: "mdiStarOutline", label: "Star" },
      { name: "mdiHeartOutline", label: "Heart" },
      { name: "mdiBookmarkOutline", label: "Bookmark" },
      { name: "mdiHistory", label: "Memories" },
      { name: "mdiClockOutline", label: "Time" },
      { name: "mdiCalendarRange", label: "Dates" },
    ],
  },
  {
    label: "People and pets",
    icons: [
      { name: "mdiAccountOutline", label: "Person" },
      { name: "mdiAccountMultipleOutline", label: "People" },
      { name: "mdiAccountGroupOutline", label: "Group" },
      { name: "mdiHumanMaleFemaleChild", label: "Family" },
      { name: "mdiBabyFaceOutline", label: "Baby" },
      { name: "mdiHumanMaleChild", label: "Parent and child" },
      { name: "mdiBabyCarriage", label: "Stroller" },
      { name: "mdiPawOutline", label: "Pets" },
      { name: "mdiDog", label: "Dog" },
      { name: "mdiCat", label: "Cat" },
      { name: "mdiHorse", label: "Horse" },
      { name: "mdiBird", label: "Bird" },
      { name: "mdiFish", label: "Fish" },
      { name: "mdiRabbit", label: "Rabbit" },
      { name: "mdiCow", label: "Cow" },
      { name: "mdiSheep", label: "Sheep" },
      { name: "mdiPig", label: "Pig" },
      { name: "mdiDuck", label: "Duck" },
      { name: "mdiPenguin", label: "Penguin" },
      { name: "mdiOwl", label: "Owl" },
      { name: "mdiButterfly", label: "Butterfly" },
      { name: "mdiBee", label: "Bee" },
      { name: "mdiLadybug", label: "Ladybug" },
      { name: "mdiTurtle", label: "Turtle" },
      { name: "mdiEmoticonHappyOutline", label: "Smile" },
    ],
  },
  {
    label: "Nature and seasons",
    icons: [
      { name: "mdiWhiteBalanceSunny", label: "Sun" },
      { name: "mdiWeatherSunset", label: "Sunset" },
      { name: "mdiWeatherNight", label: "Night" },
      { name: "mdiMoonWaningCrescent", label: "Moon" },
      { name: "mdiWeatherPartlyCloudy", label: "Clouds" },
      { name: "mdiWeatherRainy", label: "Rain" },
      { name: "mdiWeatherLightning", label: "Storm" },
      { name: "mdiWeatherWindy", label: "Wind" },
      { name: "mdiSnowflake", label: "Snow" },
      { name: "mdiLeaf", label: "Leaf" },
      { name: "mdiTree", label: "Tree" },
      { name: "mdiPineTree", label: "Pine" },
      { name: "mdiForest", label: "Forest" },
      { name: "mdiPalmTree", label: "Palm" },
      { name: "mdiFlower", label: "Flower" },
      { name: "mdiFlowerTulip", label: "Tulip" },
      { name: "mdiCactus", label: "Cactus" },
      { name: "mdiMushroom", label: "Mushroom" },
      { name: "mdiSprout", label: "Sprout" },
      { name: "mdiGrass", label: "Grass" },
      { name: "mdiImageFilterHdr", label: "Mountains" },
      { name: "mdiTerrain", label: "Terrain" },
      { name: "mdiVolcano", label: "Volcano" },
      { name: "mdiWaves", label: "Waves" },
      { name: "mdiBeach", label: "Beach" },
      { name: "mdiIsland", label: "Island" },
      { name: "mdiWater", label: "Water" },
      { name: "mdiFire", label: "Fire" },
      { name: "mdiCampfire", label: "Campfire" },
      { name: "mdiTent", label: "Tent" },
      { name: "mdiStarFourPoints", label: "Sparkle" },
    ],
  },
  {
    label: "Travel and places",
    icons: [
      { name: "mdiEarth", label: "Travel" },
      { name: "mdiCompassOutline", label: "Adventure" },
      { name: "mdiMapOutline", label: "Map" },
      { name: "mdiMapMarkerOutline", label: "Place" },
      { name: "mdiFlagOutline", label: "Flag" },
      { name: "mdiRoutes", label: "Route" },
      { name: "mdiRoadVariant", label: "Road" },
      { name: "mdiAirplane", label: "Flight" },
      { name: "mdiAirplaneTakeoff", label: "Departure" },
      { name: "mdiTrain", label: "Train" },
      { name: "mdiSubwayVariant", label: "Metro" },
      { name: "mdiBus", label: "Bus" },
      { name: "mdiCar", label: "Car" },
      { name: "mdiMotorbike", label: "Motorbike" },
      { name: "mdiBike", label: "Bike" },
      { name: "mdiSailBoat", label: "Sailing" },
      { name: "mdiFerry", label: "Ferry" },
      { name: "mdiRocketLaunchOutline", label: "Rocket" },
      { name: "mdiHiking", label: "Hiking" },
      { name: "mdiWalk", label: "Walk" },
      { name: "mdiBagSuitcase", label: "Suitcase" },
      { name: "mdiBagPersonal", label: "Backpack" },
      { name: "mdiPassport", label: "Passport" },
      { name: "mdiBinoculars", label: "Binoculars" },
      { name: "mdiBedOutline", label: "Stay" },
      { name: "mdiCityVariantOutline", label: "City" },
      { name: "mdiCastle", label: "Castle" },
      { name: "mdiBridge", label: "Bridge" },
      { name: "mdiLighthouse", label: "Lighthouse" },
      { name: "mdiChurchOutline", label: "Church" },
      { name: "mdiMosque", label: "Mosque" },
      { name: "mdiEiffelTower", label: "Landmark" },
      { name: "mdiPyramid", label: "Pyramid" },
      { name: "mdiBankOutline", label: "Museum" },
    ],
  },
  {
    label: "Events and celebrations",
    icons: [
      { name: "mdiCakeVariantOutline", label: "Birthday" },
      { name: "mdiPartyPopper", label: "Party" },
      { name: "mdiGiftOutline", label: "Gift" },
      { name: "mdiBalloon", label: "Balloon" },
      { name: "mdiRing", label: "Wedding" },
      { name: "mdiCalendarHeart", label: "Anniversary" },
      { name: "mdiCalendarStar", label: "Occasion" },
      { name: "mdiPineTreeVariant", label: "Christmas" },
      { name: "mdiHalloween", label: "Halloween" },
      { name: "mdiFirework", label: "Fireworks" },
      { name: "mdiSchoolOutline", label: "Graduation" },
      { name: "mdiTrophyOutline", label: "Trophy" },
      { name: "mdiMedalOutline", label: "Medal" },
      { name: "mdiTicketOutline", label: "Tickets" },
      { name: "mdiTheater", label: "Theatre" },
      { name: "mdiMusicNote", label: "Music" },
      { name: "mdiMicrophoneOutline", label: "Microphone" },
      { name: "mdiGuitarAcoustic", label: "Guitar" },
      { name: "mdiPiano", label: "Piano" },
      { name: "mdiHeadphones", label: "Headphones" },
      { name: "mdiGlassCocktail", label: "Cocktail" },
      { name: "mdiGlassWine", label: "Wine" },
      { name: "mdiBeer", label: "Beer" },
      { name: "mdiCandle", label: "Candle" },
    ],
  },
  {
    label: "Hobbies and sports",
    icons: [
      { name: "mdiSoccer", label: "Soccer" },
      { name: "mdiBasketball", label: "Basketball" },
      { name: "mdiFootball", label: "Football" },
      { name: "mdiBaseball", label: "Baseball" },
      { name: "mdiTennis", label: "Tennis" },
      { name: "mdiGolf", label: "Golf" },
      { name: "mdiHockeySticks", label: "Hockey" },
      { name: "mdiVolleyball", label: "Volleyball" },
      { name: "mdiSki", label: "Ski" },
      { name: "mdiSnowboard", label: "Snowboard" },
      { name: "mdiSkateboard", label: "Skateboard" },
      { name: "mdiSurfing", label: "Surfing" },
      { name: "mdiSwim", label: "Swim" },
      { name: "mdiKayaking", label: "Kayak" },
      { name: "mdiDivingScuba", label: "Diving" },
      { name: "mdiParachute", label: "Skydiving" },
      { name: "mdiRun", label: "Run" },
      { name: "mdiDumbbell", label: "Gym" },
      { name: "mdiYoga", label: "Yoga" },
      { name: "mdiKarate", label: "Martial arts" },
      { name: "mdiBowling", label: "Bowling" },
      { name: "mdiBilliards", label: "Billiards" },
      { name: "mdiTarget", label: "Archery" },
      { name: "mdiChessKnight", label: "Chess" },
      { name: "mdiCardsOutline", label: "Cards" },
      { name: "mdiDiceMultipleOutline", label: "Dice" },
      { name: "mdiGamepadVariantOutline", label: "Games" },
      { name: "mdiPuzzleOutline", label: "Puzzle" },
      { name: "mdiPaletteOutline", label: "Art" },
      { name: "mdiBrush", label: "Painting" },
      { name: "mdiPencilOutline", label: "Drawing" },
      { name: "mdiBookOpenVariant", label: "Reading" },
      { name: "mdiChefHat", label: "Cooking" },
      { name: "mdiHammerWrench", label: "Workshop" },
      { name: "mdiWateringCan", label: "Garden" },
      { name: "mdiTelescope", label: "Astronomy" },
      { name: "mdiRobotOutline", label: "Robotics" },
      { name: "mdiCubeOutline", label: "Models" },
    ],
  },
  {
    label: "Food and drink",
    icons: [
      { name: "mdiFoodOutline", label: "Food" },
      { name: "mdiSilverwareForkKnife", label: "Dining" },
      { name: "mdiPizza", label: "Pizza" },
      { name: "mdiHamburger", label: "Burger" },
      { name: "mdiNoodles", label: "Noodles" },
      { name: "mdiFoodCroissant", label: "Bakery" },
      { name: "mdiCupcake", label: "Cupcake" },
      { name: "mdiIceCream", label: "Ice cream" },
      { name: "mdiFruitCherries", label: "Fruit" },
      { name: "mdiCarrot", label: "Vegetables" },
      { name: "mdiCoffeeOutline", label: "Coffee" },
      { name: "mdiTeaOutline", label: "Tea" },
      { name: "mdiBottleWineOutline", label: "Bottle" },
      { name: "mdiGrill", label: "Barbecue" },
    ],
  },
  {
    label: "Home and work",
    icons: [
      { name: "mdiHomeOutline", label: "Home" },
      { name: "mdiHomeVariantOutline", label: "House" },
      { name: "mdiSofa", label: "Indoors" },
      { name: "mdiOfficeBuildingOutline", label: "Office" },
      { name: "mdiBriefcaseOutline", label: "Work" },
      { name: "mdiLaptop", label: "Laptop" },
      { name: "mdiMonitor", label: "Screen" },
      { name: "mdiCellphone", label: "Phone" },
      { name: "mdiTools", label: "Tools" },
      { name: "mdiHammer", label: "Build" },
      { name: "mdiWrenchOutline", label: "Repair" },
      { name: "mdiFormatPaint", label: "Renovation" },
      { name: "mdiBookshelf", label: "Bookshelf" },
      { name: "mdiStoreOutline", label: "Shop" },
      { name: "mdiShoppingOutline", label: "Shopping" },
      { name: "mdiCartOutline", label: "Cart" },
      { name: "mdiHospitalBoxOutline", label: "Health" },
      { name: "mdiMedicalBag", label: "Medical" },
      { name: "mdiTruckOutline", label: "Moving" },
      { name: "mdiPackageVariantClosed", label: "Box" },
      { name: "mdiKeyOutline", label: "Keys" },
      { name: "mdiFileDocumentOutline", label: "Files" },
      { name: "mdiTextBoxOutline", label: "Documents" },
      { name: "mdiReceiptTextOutline", label: "Receipts" },
      { name: "mdiArchiveOutline", label: "Archive" },
    ],
  },
  {
    label: "Symbols",
    icons: [
      { name: "mdiTagOutline", label: "Tag" },
      { name: "mdiLabelOutline", label: "Label" },
      { name: "mdiCircleOutline", label: "Circle" },
      { name: "mdiSquareOutline", label: "Square" },
      { name: "mdiTriangleOutline", label: "Triangle" },
      { name: "mdiHexagonOutline", label: "Hexagon" },
      { name: "mdiDiamondStone", label: "Gem" },
      { name: "mdiCrownOutline", label: "Crown" },
      { name: "mdiShieldOutline", label: "Shield" },
      { name: "mdiLightbulbOutline", label: "Idea" },
      { name: "mdiInfinity", label: "Infinity" },
      { name: "mdiPeace", label: "Peace" },
      { name: "mdiHandHeartOutline", label: "Care" },
      { name: "mdiLockOutline", label: "Private" },
      { name: "mdiEyeOffOutline", label: "Hidden" },
      { name: "mdiFlash", label: "Flash" },
      { name: "mdiAutoFix", label: "Magic" },
      { name: "mdiCheckDecagramOutline", label: "Verified" },
    ],
  },
];
export const collectionIcons = collectionIconGroups.flatMap((group) => group.icons);
export const collectionIconNames = collectionIcons.map((icon) => icon.name);
/** Any name in the Material Design Icons catalogue is a valid collection icon; anything else is not. */
export const isIconName = (value) =>
  typeof value === "string" &&
  /^mdi[A-Za-z0-9]{1,60}$/.test(value) &&
  Object.hasOwn(materialIcons, value) &&
  typeof materialIcons[value] === "string";
export const memberRoles = ["owner", "editor", "viewer"];
export const displayOrders = ["newest", "oldest"];
export const collectionKinds = ["album", "collection", "space"];
/** Customer-facing noun for a node: album, collection or shared space. */
export const kindLabel = (collection) =>
  collection?.kind === "space"
    ? "shared space"
    : collection?.kind === "collection"
      ? "collection"
      : "album";
export const defaultIconFor = (kind) =>
  kind === "space"
    ? "mdiAccountMultipleOutline"
    : kind === "collection"
      ? "mdiFolderMultipleOutline"
      : "mdiImageAlbum";
export const collectionTabs = ["all", "owned", "shared"];
export const collectionSorts = [
  "title",
  "items",
  "modified",
  "created",
  "recent-photo",
  "oldest-photo",
  "owner",
  "shared",
];
export const collectionGroups = ["none", "owner", "year"];
export const smartMediaTypes = ["any", "photo", "video"];
export const activityTypes = ["like", "comment"];

const NAME_LIMIT = 120;
const TEXT_LIMIT = 2000;
const ID_LIMIT = 64;
const MEMBER_LIMIT = 50;
const LINK_LIMIT = 20;
const ACTIVITY_LIMIT = 500;

/* ---------- validation helpers ---------- */
const record = (value) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const field = (value, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
};
const line = (value, limit) =>
  typeof value === "string" &&
  value.length <= limit &&
  !/[\u0000-\u001f]/.test(value);
const paragraph = (value, limit) =>
  typeof value === "string" &&
  value.length <= limit &&
  !/[\u0000-\u0008\u000b-\u001f]/.test(value);
const RESERVED = /^(__proto__|constructor|prototype)$/;
const identifier = (value) =>
  line(value, ID_LIMIT) && value.trim() !== "" && !RESERVED.test(value.trim());
const stamp = (value) =>
  line(value, 40) && Number.isFinite(Date.parse(value)) ? value : null;
const day = (value) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null;
const fail = (message) => {
  throw new Error(message);
};
const stringList = (value, limit = 64) =>
  Array.isArray(value)
    ? [...new Set(value.filter((id) => identifier(id)).map((id) => id.trim()))]
        .slice(0, limit)
    : [];

/* ---------- smart rules ---------- */
export function normalizeRule(rule) {
  const source = record(rule) ? rule : {};
  const type = field(source, "type");
  return {
    personIds: stringList(field(source, "personIds")),
    tagIds: stringList(field(source, "tagIds")),
    from: day(field(source, "from")),
    to: day(field(source, "to")),
    type: smartMediaTypes.includes(type) ? type : "any",
  };
}
export function ruleIsEmpty(rule) {
  const r = normalizeRule(rule);
  return (
    !r.personIds.length && !r.tagIds.length && !r.from && !r.to && r.type === "any"
  );
}
const liveAsset = (asset) =>
  asset && !["Trashed", "Deleted"].includes(asset.status);
export function reevaluateSmart(rule, assets = []) {
  const r = normalizeRule(rule);
  return assets
    .filter(
      (asset) =>
        liveAsset(asset) &&
        (!r.personIds.length ||
          r.personIds.some((id) => (asset.personIds || []).includes(id))) &&
        (!r.tagIds.length ||
          r.tagIds.some((id) =>
            (asset.tagIds || asset.tags || []).includes(id),
          )) &&
        (!r.from || (asset.date || "") >= r.from) &&
        (!r.to || (asset.date || "") <= r.to) &&
        (r.type === "any" || asset.type === r.type),
    )
    .map((asset) => asset.id);
}

/* ---------- seed ---------- */
const SEED_STAMP = "2026-09-14T09:30:00.000Z";
const owner = (userId) => ({ userId, role: "owner" });
export function createCollectionsState() {
  const base = {
    description: "",
    coverAssetId: null,
    displayOrder: "newest",
    commentsEnabled: true,
    showOwnerBadges: true,
    smart: null,
    kind: "album",
    links: [],
  };
  return {
    version: 1,
    collections: [
      {
        ...base,
        id: "family",
        name: "Family",
        description: "Everything with the three of us in it.",
        icon: "mdiFolderMultipleOutline",
        kind: "collection",
        parentId: null,
        coverAssetId: "4",
        ownerId: "taylor",
        members: [owner("taylor"), { userId: "jamie", role: "editor" }, { userId: "emma", role: "viewer" }],
        createdAt: "2026-06-02T18:12:00.000Z",
        updatedAt: SEED_STAMP,
        links: [
          {
            id: "link-family-1",
            createdAt: "2026-08-20T10:00:00.000Z",
            expiresAt: null,
            allowUpload: false,
            allowDownload: true,
            showMetadata: true,
            hasPassword: false,
          },
        ],
      },
      {
        ...base,
        id: "summer-rockies",
        name: "Summer in the Rockies",
        description: "Lake Louise, Banff and Jasper, August 2026.",
        icon: "mdiWhiteBalanceSunny",
        parentId: "family",
        coverAssetId: "3",
        ownerId: "taylor",
        members: [owner("taylor"), { userId: "jamie", role: "editor" }],
        createdAt: "2026-08-12T21:40:00.000Z",
        updatedAt: "2026-09-10T16:05:00.000Z",
      },
      {
        ...base,
        id: "winter-2026",
        name: "Winter 2026",
        description: "Snow days, still to come.",
        icon: "mdiSnowflake",
        parentId: "family",
        ownerId: "taylor",
        members: [owner("taylor")],
        createdAt: "2026-09-01T08:00:00.000Z",
        updatedAt: "2026-09-01T08:00:00.000Z",
      },
      {
        ...base,
        id: "everyday",
        name: "Everyday",
        description: "Portraits and small moments around the house.",
        icon: "mdiCameraOutline",
        parentId: "family",
        coverAssetId: "10",
        ownerId: "taylor",
        members: [owner("taylor"), { userId: "emma", role: "viewer" }],
        createdAt: "2026-07-14T12:00:00.000Z",
        updatedAt: "2026-09-04T19:22:00.000Z",
      },
      {
        ...base,
        id: "trail-camera",
        name: "Trail camera",
        description: "Wildlife and pets caught on the trail, kept up to date automatically.",
        icon: "mdiPawOutline",
        parentId: null,
        ownerId: "jamie",
        members: [owner("jamie"), { userId: "taylor", role: "viewer" }],
        createdAt: "2026-08-19T07:45:00.000Z",
        updatedAt: "2026-09-12T07:45:00.000Z",
        smart: { rule: normalizeRule({ tagIds: ["wildlife", "pet", "dog", "elk"] }) },
      },
      {
        ...base,
        id: "lake-days",
        name: "Lake days",
        description: "Anything on or beside the water.",
        icon: "mdiCompassOutline",
        parentId: null,
        ownerId: "taylor",
        members: [owner("taylor")],
        createdAt: "2026-08-22T15:10:00.000Z",
        updatedAt: "2026-08-22T15:10:00.000Z",
        smart: { rule: normalizeRule({ tagIds: ["lake", "kayaking", "water"], type: "any" }) },
      },
      {
        ...base,
        id: "family-space",
        name: "Family Space",
        description: "A shared space the whole household adds to.",
        icon: "mdiAccountMultipleOutline",
        parentId: null,
        coverAssetId: "15",
        ownerId: "taylor",
        members: [owner("taylor"), { userId: "jamie", role: "editor" }, { userId: "emma", role: "editor" }],
        createdAt: "2026-05-20T10:00:00.000Z",
        updatedAt: "2026-09-13T20:15:00.000Z",
        kind: "space",
      },
    ],
    activity: {
      "summer-rockies": [
        { id: "act-1", userId: "jamie", type: "like", assetId: "3", text: "", at: "2026-09-08T14:02:00.000Z" },
        { id: "act-2", userId: "emma", type: "comment", assetId: "3", text: "The reflection shot is my favourite from the whole trip.", at: "2026-09-08T18:30:00.000Z" },
        { id: "act-3", userId: "jamie", type: "comment", assetId: null, text: "Can we add the kayak video here too?", at: "2026-09-10T16:05:00.000Z" },
        { id: "act-4", userId: "taylor", type: "comment", assetId: null, text: "Added. Let me know if any are missing.", at: "2026-09-10T16:20:00.000Z" },
      ],
      family: [
        { id: "act-5", userId: "emma", type: "like", assetId: null, text: "", at: "2026-09-02T11:00:00.000Z" },
      ],
      "family-space": [
        { id: "act-6", userId: "jamie", type: "comment", assetId: null, text: "Uploaded the hike photos from my phone.", at: "2026-09-13T20:15:00.000Z" },
      ],
    },
  };
}

/* ---------- parsing ---------- */
function parseMember(value) {
  if (!record(value)) return null;
  const userId = field(value, "userId");
  const role = field(value, "role");
  if (!identifier(userId) || !memberRoles.includes(role)) return null;
  return { userId: userId.trim(), role };
}
function parseLink(value) {
  if (!record(value)) return null;
  const id = field(value, "id");
  const createdAt = stamp(field(value, "createdAt"));
  if (!identifier(id) || !createdAt) return null;
  const expires = field(value, "expiresAt");
  return {
    id: id.trim(),
    createdAt,
    expiresAt: expires === null || expires === undefined ? null : stamp(expires),
    allowUpload: field(value, "allowUpload") === true,
    allowDownload: field(value, "allowDownload") !== false,
    showMetadata: field(value, "showMetadata") !== false,
    hasPassword: field(value, "hasPassword") === true,
  };
}
function parseCollection(value) {
  if (!record(value)) return null;
  const id = field(value, "id");
  const name = field(value, "name");
  const ownerId = field(value, "ownerId");
  if (!identifier(id) || !line(name, NAME_LIMIT) || !name.trim() || !identifier(ownerId))
    return null;
  const createdAt = stamp(field(value, "createdAt")) || SEED_STAMP;
  const updatedAt = stamp(field(value, "updatedAt")) || createdAt;
  const icon = field(value, "icon");
  const kind = field(value, "kind");
  const parentId = field(value, "parentId");
  const cover = field(value, "coverAssetId");
  const order = field(value, "displayOrder");
  const description = field(value, "description");
  const smart = field(value, "smart");
  const rawMembers = field(value, "members");
  const members = [];
  for (const entry of Array.isArray(rawMembers) ? rawMembers : []) {
    const member = parseMember(entry);
    if (member && !members.some((m) => m.userId === member.userId))
      members.push(member);
    if (members.length >= MEMBER_LIMIT) break;
  }
  const trimmedOwner = ownerId.trim();
  const ownerEntry = members.find((m) => m.userId === trimmedOwner);
  if (ownerEntry) ownerEntry.role = "owner";
  else members.unshift(owner(trimmedOwner));
  for (const member of members)
    if (member.userId !== trimmedOwner && member.role === "owner")
      member.role = "editor";
  const rawLinks = field(value, "links");
  const links = [];
  for (const entry of Array.isArray(rawLinks) ? rawLinks : []) {
    const link = parseLink(entry);
    if (link && !links.some((l) => l.id === link.id)) links.push(link);
    if (links.length >= LINK_LIMIT) break;
  }
  return {
    id: id.trim(),
    name: name.trim(),
    description: paragraph(description, TEXT_LIMIT) ? description : "",
    icon: isIconName(icon) ? icon : "mdiFolderOutline",
    parentId: identifier(parentId) ? parentId.trim() : null,
    coverAssetId: identifier(cover) ? cover.trim() : null,
    ownerId: trimmedOwner,
    members,
    createdAt,
    updatedAt,
    displayOrder: displayOrders.includes(order) ? order : "newest",
    commentsEnabled: field(value, "commentsEnabled") !== false,
    showOwnerBadges: field(value, "showOwnerBadges") !== false,
    smart: record(smart) ? { rule: normalizeRule(field(smart, "rule")) } : null,
    kind: collectionKinds.includes(kind) ? kind : "album",
    links,
  };
}
function parseActivity(value) {
  if (!record(value)) return null;
  const id = field(value, "id");
  const userId = field(value, "userId");
  const type = field(value, "type");
  const at = stamp(field(value, "at"));
  const text = field(value, "text");
  const assetId = field(value, "assetId");
  if (!identifier(id) || !identifier(userId) || !activityTypes.includes(type) || !at)
    return null;
  if (type === "comment" && !(paragraph(text, TEXT_LIMIT) && text.trim())) return null;
  return {
    id: id.trim(),
    userId: userId.trim(),
    type,
    assetId: identifier(assetId) ? assetId.trim() : null,
    text: type === "comment" ? text : "",
    at,
  };
}
export function parseCollections(raw) {
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return createCollectionsState();
  }
  if (!record(data) || field(data, "version") !== 1 || !Array.isArray(field(data, "collections")))
    return createCollectionsState();
  const collections = [];
  for (const entry of data.collections) {
    const collection = parseCollection(entry);
    if (collection && !collections.some((c) => c.id === collection.id))
      collections.push(collection);
  }
  // Earlier saves nested albums inside albums: an album that holds albums is a collection.
  for (const collection of collections)
    if (
      collection.kind === "album" &&
      !collection.smart &&
      collections.some((child) => child.parentId === collection.id && child.kind === "album")
    )
      collection.kind = "collection";
  // Only albums nest, only inside a collection, and never in a cycle.
  const byId = new Map(collections.map((c) => [c.id, c]));
  for (const collection of collections) {
    const parent = byId.get(collection.parentId);
    if (
      !parent ||
      parent.kind !== "collection" ||
      collection.kind !== "album" ||
      parent.id === collection.id
    )
      collection.parentId = null;
  }
  for (const collection of collections) {
    const seen = new Set([collection.id]);
    let cursor = byId.get(collection.parentId);
    while (cursor) {
      if (seen.has(cursor.id)) {
        collection.parentId = null;
        break;
      }
      seen.add(cursor.id);
      cursor = byId.get(cursor.parentId);
    }
  }
  const activity = {};
  const rawActivity = field(data, "activity");
  if (record(rawActivity))
    for (const id of Object.keys(rawActivity)) {
      if (!byId.has(id) || !Array.isArray(field(rawActivity, id))) continue;
      const entries = [];
      for (const entry of field(rawActivity, id)) {
        const item = parseActivity(entry);
        if (item && !entries.some((e) => e.id === item.id)) entries.push(item);
        if (entries.length >= ACTIVITY_LIMIT) break;
      }
      activity[id] = entries;
    }
  return { version: 1, collections, activity };
}

/* ---------- lookups ---------- */
export const findCollection = (state, id) =>
  state.collections.find((c) => c.id === id) || null;
export const roleOf = (collection, userId) =>
  collection?.members.find((m) => m.userId === userId)?.role || null;
export const isMember = (collection, userId) => roleOf(collection, userId) !== null;
export const canEdit = (collection, userId) =>
  ["owner", "editor"].includes(roleOf(collection, userId));
export const isOwner = (collection, userId) => collection?.ownerId === userId;

export function collectionAssets(collection, assets = []) {
  if (!collection) return [];
  let items;
  if (collection.smart) {
    const ids = new Set(reevaluateSmart(collection.smart.rule, assets));
    items = assets.filter((asset) => ids.has(asset.id));
  } else if (collection.kind === "space")
    items = assets.filter(
      (asset) => liveAsset(asset) && (asset.spaceIds || []).includes(collection.id),
    );
  else
    items = assets.filter(
      (asset) => liveAsset(asset) && (asset.albumIds || []).includes(collection.id),
    );
  const key = (asset) => asset.takenAt || asset.date || "";
  return [...items].sort((a, b) =>
    collection.displayOrder === "oldest"
      ? key(a).localeCompare(key(b))
      : key(b).localeCompare(key(a)),
  );
}
export const itemCount = (collection, assets) => collectionAssets(collection, assets).length;
export function assetDates(assets = []) {
  const keys = assets.map((a) => a.takenAt || a.date || "").filter(Boolean).sort();
  return { earliest: keys[0] || null, latest: keys.at(-1) || null };
}
export function coverAsset(collection, assets = []) {
  const items = collectionAssets(collection, assets);
  return (
    items.find((asset) => asset.id === collection?.coverAssetId) ||
    [...items].sort((a, b) => (b.takenAt || "").localeCompare(a.takenAt || ""))[0] ||
    null
  );
}
export function ancestors(state, id) {
  const chain = [];
  const seen = new Set();
  let cursor = findCollection(state, findCollection(state, id)?.parentId);
  while (cursor && !seen.has(cursor.id)) {
    chain.unshift(cursor);
    seen.add(cursor.id);
    cursor = findCollection(state, cursor.parentId);
  }
  return chain;
}
export function descendantIds(state, id) {
  const result = new Set();
  const walk = (parentId) => {
    for (const c of state.collections)
      if (c.parentId === parentId && !result.has(c.id)) {
        result.add(c.id);
        walk(c.id);
      }
  };
  walk(id);
  return result;
}
export function tree(state, visibleIds = null) {
  const visible = visibleIds ? new Set(visibleIds) : null;
  const order = visible ? new Map([...visible].map((id, index) => [id, index])) : null;
  const pool = state.collections
    .filter((c) => !visible || visible.has(c.id))
    .sort((a, b) => (order ? order.get(a.id) - order.get(b.id) : 0));
  const ids = new Set(pool.map((c) => c.id));
  const build = (parentId, depth) =>
    pool
      .filter((c) => (parentId === null ? !ids.has(c.parentId) : c.parentId === parentId))
      .map((c) => ({ collection: c, depth, children: build(c.id, depth + 1) }));
  return build(null, 0);
}

/* ---------- listing ---------- */
const userName = (users, id) =>
  users?.find((u) => u.id === id)?.name ||
  (id ? id[0].toUpperCase() + id.slice(1) : "Unknown");
export function listCollections(state, filter = {}, assets = [], users = []) {
  const {
    tab = "all",
    search = "",
    sort = "modified",
    groupBy = "none",
    userId = "taylor",
    direction = null,
  } = filter;
  const term = search.trim().toLowerCase();
  const entries = state.collections
    .filter((c) => isMember(c, userId))
    .filter((c) =>
      tab === "owned" ? c.ownerId === userId : tab === "shared" ? c.members.length > 1 : true,
    )
    .filter(
      (c) =>
        !term ||
        c.name.toLowerCase().includes(term) ||
        c.description.toLowerCase().includes(term),
    )
    .map((c) => {
      const items = collectionAssets(c, assets);
      const dates = assetDates(items);
      return {
        collection: c,
        itemCount: items.length,
        latestAt: dates.latest,
        earliestAt: dates.earliest,
        coverAssetId: coverAsset(c, items)?.id ?? null,
        mine: c.ownerId === userId,
        shared: c.members.length > 1,
        role: roleOf(c, userId),
      };
    });
  const compare = {
    title: (a, b) => a.collection.name.localeCompare(b.collection.name),
    items: (a, b) => b.itemCount - a.itemCount || a.collection.name.localeCompare(b.collection.name),
    modified: (a, b) => b.collection.updatedAt.localeCompare(a.collection.updatedAt),
    created: (a, b) => b.collection.createdAt.localeCompare(a.collection.createdAt),
    "recent-photo": (a, b) =>
      (b.latestAt || "").localeCompare(a.latestAt || "") ||
      a.collection.name.localeCompare(b.collection.name),
    "oldest-photo": (a, b) =>
      a.earliestAt && b.earliestAt
        ? a.earliestAt.localeCompare(b.earliestAt)
        : (a.earliestAt ? -1 : 0) - (b.earliestAt ? -1 : 0),
    owner: (a, b) =>
      userName(users, a.collection.ownerId).localeCompare(userName(users, b.collection.ownerId)) ||
      a.collection.name.localeCompare(b.collection.name),
    shared: (a, b) =>
      b.collection.members.length - a.collection.members.length ||
      a.collection.name.localeCompare(b.collection.name),
  }[collectionSorts.includes(sort) ? sort : "modified"];
  entries.sort(compare);
  if (direction === "desc") entries.reverse();
  if (groupBy === "owner") {
    const groups = new Map();
    for (const entry of entries) {
      const key = entry.collection.ownerId;
      if (!groups.has(key))
        groups.set(key, {
          key,
          label: key === userId ? "Mine" : `Shared by ${userName(users, key)}`,
          entries: [],
        });
      groups.get(key).entries.push(entry);
    }
    return [...groups.values()].sort((a, b) =>
      a.key === userId ? -1 : b.key === userId ? 1 : a.label.localeCompare(b.label),
    );
  }
  if (groupBy === "year") {
    const groups = new Map();
    for (const entry of entries) {
      const key = (entry.latestAt || entry.collection.createdAt).slice(0, 4);
      if (!groups.has(key)) groups.set(key, { key, label: key, entries: [] });
      groups.get(key).entries.push(entry);
    }
    return [...groups.values()].sort((a, b) => b.key.localeCompare(a.key));
  }
  return [{ key: "all", label: null, entries }];
}

/* ---------- mutations ---------- */
const nowStamp = () => new Date().toISOString();
const replace = (state, id, patch) => ({
  ...state,
  collections: state.collections.map((c) => (c.id === id ? { ...c, ...patch } : c)),
});
const mustFind = (state, id) => findCollection(state, id) || fail("That collection no longer exists.");
export function slugify(name) {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "album"
  );
}
function uniqueId(state, name) {
  const base = slugify(name);
  let id = base;
  let n = 2;
  while (findCollection(state, id) || RESERVED.test(id)) id = `${base}-${n++}`;
  return id;
}
function assertParent(state, id, parentId, kind = "album") {
  if (parentId === null || parentId === undefined) return null;
  if (kind === "space") fail("Spaces cannot be nested.");
  if (kind === "collection")
    fail("Collections cannot be nested inside another collection.");
  const parent = findCollection(state, parentId);
  if (!parent) fail("Choose an existing collection.");
  if (id && parent.id === id) fail("An album cannot be nested inside itself.");
  if (parent.smart) fail("Smart albums cannot hold other albums.");
  if (parent.kind !== "collection")
    fail("Put albums inside a collection, not inside another album or space.");
  if (id && descendantIds(state, id).has(parent.id))
    fail("An album cannot be moved into one of its own children.");
  return parent.id;
}
export function createCollection(state, input = {}, now = nowStamp()) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) fail("Give it a name.");
  if (name.length > NAME_LIMIT) fail("Keep the name under 120 characters.");
  const ownerId = identifier(input.ownerId) ? input.ownerId : "taylor";
  const kind = collectionKinds.includes(input.kind) ? input.kind : "album";
  const smart = input.smart ? { rule: normalizeRule(input.smart.rule ?? input.smart) } : null;
  if (smart && kind !== "album") fail("Only albums can be smart.");
  if (smart && ruleIsEmpty(smart.rule)) fail("Add at least one rule to a smart album.");
  const id = identifier(input.id) && !findCollection(state, input.id) ? input.id : uniqueId(state, name);
  const parentId = assertParent(state, null, input.parentId ?? null, kind);
  const collection = parseCollection({
    id,
    name,
    description: input.description ?? "",
    icon: isIconName(input.icon) ? input.icon : defaultIconFor(kind),
    parentId,
    coverAssetId: input.coverAssetId ?? null,
    ownerId,
    members: [owner(ownerId), ...(Array.isArray(input.members) ? input.members : [])],
    createdAt: now,
    updatedAt: now,
    displayOrder: input.displayOrder,
    commentsEnabled: input.commentsEnabled,
    showOwnerBadges: input.showOwnerBadges,
    smart,
    kind,
    links: [],
  });
  if (!collection) fail("Choose a valid name.");
  return {
    state: { ...state, collections: [...state.collections, collection] },
    collection,
  };
}
export function updateCollection(state, id, patch = {}, now = nowStamp()) {
  const current = mustFind(state, id);
  if (!record(patch)) fail("Choose a supported collection change.");
  const next = {};
  if ("name" in patch) {
    const name = typeof patch.name === "string" ? patch.name.trim() : "";
    if (!name) fail("Give it a name.");
    if (name.length > NAME_LIMIT) fail("Keep the name under 120 characters.");
    next.name = name;
  }
  if ("description" in patch) {
    if (!paragraph(patch.description ?? "", TEXT_LIMIT))
      fail("Keep the description under 2000 characters.");
    next.description = patch.description ?? "";
  }
  if ("icon" in patch) {
    if (!isIconName(patch.icon)) fail("Choose an icon from the list.");
    next.icon = patch.icon;
  }
  if ("coverAssetId" in patch)
    next.coverAssetId = identifier(patch.coverAssetId) ? patch.coverAssetId : null;
  if ("displayOrder" in patch) {
    if (!displayOrders.includes(patch.displayOrder)) fail("Choose a display order.");
    next.displayOrder = patch.displayOrder;
  }
  for (const key of ["commentsEnabled", "showOwnerBadges"])
    if (key in patch) {
      if (typeof patch[key] !== "boolean") fail("Choose on or off.");
      next[key] = patch[key];
    }
  if ("smart" in patch) {
    if (patch.smart === null) next.smart = null;
    else {
      const rule = normalizeRule(patch.smart.rule ?? patch.smart);
      if (current.kind !== "album")
        fail("Only albums can be smart. This collection holds nested albums.");
      if (ruleIsEmpty(rule)) fail("Add at least one rule to a smart album.");
      if (descendantIds(state, id).size)
        fail("Move the nested albums out before making this a smart album.");
      next.smart = { rule };
    }
  }
  if ("parentId" in patch)
    next.parentId = assertParent(state, id, patch.parentId, current.kind);
  const known = new Set([
    "name", "description", "icon", "coverAssetId", "displayOrder",
    "commentsEnabled", "showOwnerBadges", "smart", "parentId",
  ]);
  for (const key of Object.keys(patch))
    if (!known.has(key)) fail(`"${key}" is not a collection setting.`);
  if (!Object.keys(next).length) fail("Choose a supported collection change.");
  return replace(state, id, { ...next, updatedAt: now });
}
export function moveCollection(state, id, parentId, now = nowStamp()) {
  const current = mustFind(state, id);
  const next = assertParent(state, id, parentId, current.kind);
  if (next === current.parentId) return state;
  return replace(state, id, { parentId: next, updatedAt: now });
}
/**
 * Removes an album, collection or space. A removed collection's albums move
 * back to the top level. Assets are never touched: the returned `assetIds` are the library
 * items that referenced the collection so the caller can drop the reference
 * (e.g. `changeLibraryAssets(assetIds, { albumIds })`) while keeping the media.
 */
export function deleteCollection(state, id, { keepAssets = true, assets = [] } = {}) {
  const current = mustFind(state, id);
  if (!keepAssets) fail("Collections can only be removed while keeping their photos.");
  const assetIds = current.smart ? [] : collectionAssets(current, assets).map((a) => a.id);
  const { [id]: _removed, ...activity } = state.activity || {};
  return {
    state: {
      ...state,
      collections: state.collections
        .filter((c) => c.id !== id)
        .map((c) => (c.parentId === id ? { ...c, parentId: current.parentId } : c)),
      activity,
    },
    assetIds,
  };
}
export function setCover(state, id, assetId, now = nowStamp()) {
  mustFind(state, id);
  return replace(state, id, {
    coverAssetId: identifier(assetId) ? assetId : null,
    updatedAt: now,
  });
}
export function inviteMember(state, id, userId, role = "viewer", now = nowStamp()) {
  const current = mustFind(state, id);
  if (!identifier(userId)) fail("Choose a person to invite.");
  if (!["editor", "viewer"].includes(role)) fail("Choose Editor or Viewer.");
  if (isMember(current, userId)) fail("They already have access to this collection.");
  if (current.members.length >= MEMBER_LIMIT) fail("This collection has reached its member limit.");
  return replace(state, id, {
    members: [...current.members, { userId, role }],
    updatedAt: now,
  });
}
export function changeRole(state, id, userId, role, now = nowStamp()) {
  const current = mustFind(state, id);
  if (!["editor", "viewer"].includes(role)) fail("Choose Editor or Viewer.");
  if (userId === current.ownerId) fail("The owner's role cannot be changed.");
  if (!isMember(current, userId)) fail("They do not have access to this collection.");
  return replace(state, id, {
    members: current.members.map((m) => (m.userId === userId ? { ...m, role } : m)),
    updatedAt: now,
  });
}
export function removeMember(state, id, userId, now = nowStamp()) {
  const current = mustFind(state, id);
  if (userId === current.ownerId) fail("The owner cannot be removed. Delete the collection instead.");
  if (!isMember(current, userId)) fail("They do not have access to this collection.");
  return replace(state, id, {
    members: current.members.filter((m) => m.userId !== userId),
    updatedAt: now,
  });
}
export function leaveCollection(state, id, userId, now = nowStamp()) {
  const current = mustFind(state, id);
  if (userId === current.ownerId) fail("Owners cannot leave their own collection. Delete it instead.");
  return removeMember(state, id, userId, now);
}
export function addActivity(state, id, entry = {}, now = nowStamp()) {
  const current = mustFind(state, id);
  if (!current.commentsEnabled) fail("Comments and likes are turned off for this collection.");
  const list = state.activity?.[id] || [];
  const item = parseActivity({
    id: entry.id || `act-${Date.parse(now).toString(36)}-${list.length + 1}`,
    userId: entry.userId,
    type: entry.type,
    assetId: entry.assetId ?? null,
    text: entry.text ?? "",
    at: entry.at || now,
  });
  if (!item) fail(entry.type === "comment" ? "Write a comment first." : "Choose a valid activity.");
  if (item.type === "like" && list.some((a) => a.type === "like" && a.userId === item.userId && a.assetId === item.assetId))
    return state;
  if (list.length >= ACTIVITY_LIMIT) fail("This collection has reached its activity limit.");
  return {
    ...state,
    collections: state.collections.map((c) => (c.id === id ? { ...c, updatedAt: now } : c)),
    activity: { ...(state.activity || {}), [id]: [...list, item] },
  };
}
export function removeActivity(state, id, activityId) {
  mustFind(state, id);
  const list = state.activity?.[id] || [];
  if (!list.some((a) => a.id === activityId)) return state;
  return {
    ...state,
    activity: { ...(state.activity || {}), [id]: list.filter((a) => a.id !== activityId) },
  };
}
export function toggleLike(state, id, userId, assetId = null, now = nowStamp()) {
  const existing = (state.activity?.[id] || []).find(
    (a) => a.type === "like" && a.userId === userId && a.assetId === (assetId ?? null),
  );
  return existing
    ? removeActivity(state, id, existing.id)
    : addActivity(state, id, { userId, type: "like", assetId }, now);
}
export function toggleComments(state, id, now = nowStamp()) {
  const current = mustFind(state, id);
  return replace(state, id, { commentsEnabled: !current.commentsEnabled, updatedAt: now });
}
export function createLink(state, id, options = {}, now = nowStamp()) {
  const current = mustFind(state, id);
  if (current.links.length >= LINK_LIMIT) fail("This collection has reached its link limit.");
  const link = parseLink({
    id: options.id || `link-${id}-${current.links.length + 1}-${Date.parse(now).toString(36)}`,
    createdAt: now,
    expiresAt: options.expiresAt ?? null,
    allowUpload: options.allowUpload === true,
    allowDownload: options.allowDownload !== false,
    showMetadata: options.showMetadata !== false,
    hasPassword: options.hasPassword === true,
  });
  return {
    state: replace(state, id, { links: [...current.links, link], updatedAt: now }),
    link,
  };
}
export function removeLink(state, id, linkId, now = nowStamp()) {
  const current = mustFind(state, id);
  if (!current.links.some((l) => l.id === linkId)) return state;
  return replace(state, id, { links: current.links.filter((l) => l.id !== linkId), updatedAt: now });
}
export function activityFor(state, id, assetId = undefined) {
  const list = state.activity?.[id] || [];
  return assetId === undefined ? list : list.filter((a) => a.assetId === (assetId ?? null));
}
export function activitySummary(state, id, userId) {
  const list = state.activity?.[id] || [];
  return {
    likes: list.filter((a) => a.type === "like").length,
    comments: list.filter((a) => a.type === "comment").length,
    liked: list.some((a) => a.type === "like" && a.userId === userId && a.assetId === null),
  };
}

/* ---------- persistence ---------- */
export function loadCollections(storage = globalThis.localStorage) {
  if (!storage) return createCollectionsState();
  try {
    return parseCollections(storage.getItem(collectionsKey));
  } catch {
    return createCollectionsState();
  }
}
export function saveCollections(state, storage = globalThis.localStorage) {
  if (!storage) return false;
  try {
    storage.setItem(collectionsKey, JSON.stringify(parseCollections(state)));
    return true;
  } catch {
    return false;
  }
}

/* ---------- formatting ---------- */
const monthDay = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const monthDayYear = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const parseLocal = (value) => {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isFinite(date.getTime()) ? date : null;
};
export const plural = (count, word, words = `${word}s`) =>
  `${count} ${count === 1 ? word : words}`;
export function formatDate(value) {
  const date = parseLocal(value);
  return date ? monthDayYear.format(date) : "";
}
export function formatDateRange(earliest, latest) {
  const a = parseLocal(earliest);
  const b = parseLocal(latest);
  if (!a && !b) return "";
  if (!a || !b || a.toDateString() === b.toDateString())
    return monthDayYear.format(a || b);
  if (a.getFullYear() === b.getFullYear())
    return `${monthDay.format(a)} – ${monthDayYear.format(b)}`;
  return `${monthDayYear.format(a)} – ${monthDayYear.format(b)}`;
}
export function timeAgo(value, now = Date.now()) {
  const date = parseLocal(value);
  if (!date) return "";
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? "yesterday" : `${days} days ago`;
  return monthDayYear.format(date);
}
