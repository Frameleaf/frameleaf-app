// Fictional studio data. RAW labels and client activity demonstrate a workflow;
// the generated PNGs are not sensor data, finished exports, or real client work.
export const photographyStorageKey = "frameleaf:photography:v1";

export const demoPhotos = [
  [
    "portrait-1",
    "portrait",
    "The afternoon portrait",
    5,
    true,
    "portrait-session",
  ],
  ["portrait-2", "hiking", "A walk together", 4, true, "portrait-session"],
  ["portrait-3", "lake", "By the water", 4, false, "portrait-session"],
  ["portrait-4", "flowers", "Little details", 3, false, "portrait-session"],
  ["portrait-5", "dog", "The family companion", 2, false, "portrait-session"],
  ["portrait-6", "campfire", "Last light", 0, false, "portrait-session"],
  ["alpine-1", "summit", "At the summit", 5, true, "alpine-story"],
  ["alpine-2", "hiking", "Into the mountains", 4, true, "alpine-story"],
  ["alpine-3", "lake", "Morning stillness", 5, true, "alpine-story"],
  ["alpine-4", "creek", "The river crossing", 3, false, "alpine-story"],
  ["alpine-5", "forest", "Among the trees", 0, false, "alpine-story"],
  ["alpine-6", "cabin", "A place to pause", 2, false, "alpine-story"],
  ["botanical-1", "flowers", "Summer stems", 5, true, "botanical-study"],
  ["botanical-2", "forest", "Soft green", 4, true, "botanical-study"],
  ["botanical-3", "creek", "Water and texture", 3, false, "botanical-study"],
  ["botanical-4", "elk", "A passing visitor", 0, false, "botanical-study"],
].map(([id, image, name, rating, edited, shootId], index) => ({
  id,
  image: `/media/${image}.png`,
  name,
  fileName: `CL_${String(4021 + index).padStart(4, "0")}.CR3`,
  rating,
  raw: true,
  extension: "CR3",
  edited,
  selected: rating >= 4,
  rejected: false,
  deliverable: edited,
  camera: "Canon EOS R5",
  shootId,
}));

export const demoShoots = [
  {
    id: "portrait-session",
    name: "An afternoon together",
    client: "Jamie & family",
    type: "Family portrait",
    date: "2026-09-24",
    status: "Proofing",
    cover: "/media/portrait.png",
  },
  {
    id: "alpine-story",
    name: "The alpine story",
    client: "Northbound Journal",
    type: "Editorial",
    date: "2026-09-20",
    status: "Edited",
    cover: "/media/hiking.png",
  },
  {
    id: "botanical-study",
    name: "A botanical study",
    client: "Field Notes",
    type: "Commercial",
    date: "2026-09-16",
    status: "Selected",
    cover: "/media/flowers.png",
  },
];

export const defaultBrand = {
  name: "Cedar & Light",
  tagline: "People, places, and the light between.",
  email: "hello@cedarandlight.example",
  phone: "+1 403 555 0142",
  logo: "CL",
  logoImage: "",
  color: "#577059",
  background: "#f5f3ed",
  textColor: "#263329",
  font: "editorial",
  watermarkColor: "#ffffff",
  watermarkOpacity: 45,
  watermarkPosition: "bottom-right",
  watermarkSize: 6,
};

export const shootStages = [
  "Imported",
  "Selected",
  "Edited",
  "Proofing",
  "Delivered",
];

export function createProofGallery(shootId) {
  return {
    id: shootId,
    shootId,
    password: "cedar",
    downloadAllowed: false,
    watermark: true,
    selectionLimit: 3,
    expires: "2026-10-31",
    expired: false,
    invite: "jamie@example.com",
    invited: false,
    clientSelected: [],
    submitted: false,
    comments: [],
    approved: false,
    delivered: false,
    zipReady: false,
    export: {
      format: "JPEG",
      longEdge: "3840",
      quality: 90,
      colorSpace: "sRGB",
      watermark: false,
    },
  };
}

export function createStudioState() {
  const photos = demoPhotos.map((photo) => ({ ...photo }));
  const shoots = demoShoots.map((shoot) => ({ ...shoot }));
  const gallery = createProofGallery(shoots[0].id);
  gallery.clientSelected = ["portrait-1", "portrait-2"];
  gallery.comments = [
    {
      id: "comment-1",
      photoId: "portrait-1",
      author: "Jamie",
      text: "This one is my favourite. Could we have a warm version?",
    },
  ];
  return {
    version: 1,
    photos,
    shoots,
    brand: { ...defaultBrand },
    galleries: { [shoots[0].id]: gallery },
    website: {
      layout: "editorial",
      coverId: "portrait-1",
      order: photos.filter((photo) => photo.selected).map((photo) => photo.id),
      about:
        "I'm a portrait and editorial photographer based in Alberta. I make space for people to be themselves, and let the light do the rest.",
      contact:
        "Tell me a little about the story you would like to make together.",
      published: false,
    },
    publishing: {
      mode: "self-hosted",
      domain: "cedarandlight.example",
      server: "Studio server",
      online: true,
      billing: "monthly",
      backup: false,
      published: false,
    },
  };
}

export const initialStudioState = createStudioState();

export function photosForShoot(state, shootId) {
  return state.photos.filter((photo) => photo.shootId === shootId);
}

export function proofPhotos(state, shootId) {
  return photosForShoot(state, shootId).filter(
    (photo) => photo.selected && !photo.rejected,
  );
}

// Keep selection limits and shoot boundaries enforced even in the local demo.
export function toggleClientSelection(gallery, photoId, allowedIds) {
  if (
    gallery.expired ||
    gallery.submitted ||
    gallery.delivered ||
    !allowedIds.includes(photoId)
  )
    return gallery;
  const selected = gallery.clientSelected.filter((id) =>
    allowedIds.includes(id),
  );
  const exists = selected.includes(photoId);
  if (!exists && selected.length >= gallery.selectionLimit) return gallery;
  return {
    ...gallery,
    clientSelected: exists
      ? selected.filter((id) => id !== photoId)
      : [...selected, photoId],
    approved: false,
    zipReady: false,
  };
}

export function applyClientFeedback(state, galleryId, feedback) {
  const entry = Object.entries(state.galleries).find(
    ([key, gallery]) => key === galleryId || gallery.id === galleryId,
  );
  if (!entry) return state;
  const [shootId, gallery] = entry;
  if (
    gallery.expired ||
    gallery.delivered ||
    (gallery.expires && gallery.expires < new Date().toISOString().slice(0, 10))
  )
    return state;
  const allowed = proofPhotos(state, shootId).map((photo) => photo.id);
  const clientSelected = Array.isArray(feedback.clientSelected)
    ? [...new Set(feedback.clientSelected)]
        .filter((id) => allowed.includes(id))
        .slice(0, gallery.selectionLimit)
    : gallery.clientSelected;
  const comments = Array.isArray(feedback.comments)
    ? feedback.comments
        .filter(
          (comment) =>
            typeof comment?.id === "string" &&
            allowed.includes(comment.photoId) &&
            typeof comment.author === "string" &&
            typeof comment.text === "string" &&
            comment.text.trim(),
        )
        .map((comment) => ({
          id: comment.id,
          photoId: comment.photoId,
          author: comment.author.slice(0, 120),
          text: comment.text.slice(0, 2000),
        }))
    : gallery.comments;
  return {
    ...state,
    galleries: {
      ...state.galleries,
      [shootId]: {
        ...gallery,
        clientSelected,
        comments,
        submitted: !!feedback.submitted && clientSelected.length > 0,
        approved: false,
        zipReady: false,
      },
    },
  };
}

export function applyEditorFeedback(state, shootId, photos) {
  if (
    !Array.isArray(photos) ||
    !state.shoots.some((shoot) => shoot.id === shootId)
  )
    return state;
  const returned = new Map(
    photos
      .filter((photo) => typeof photo?.id === "string")
      .map((photo) => [photo.id, photo]),
  );
  let changed = false;
  const next = state.photos.map((photo) => {
    const feedback = returned.get(photo.id);
    if (photo.shootId !== shootId || !feedback) return photo;
    const rating = Number.isFinite(feedback.rating)
      ? Math.max(0, Math.min(5, Math.round(feedback.rating)))
      : photo.rating;
    const edited =
      typeof feedback.edited === "boolean" ? feedback.edited : photo.edited;
    if (rating === photo.rating && edited === photo.edited) return photo;
    changed = true;
    return { ...photo, rating, edited };
  });
  return changed ? { ...state, photos: next } : state;
}

export function readStudioState(storage) {
  try {
    const saved = JSON.parse(storage.getItem(photographyStorageKey) || "null");
    if (
      saved?.version !== 1 ||
      !Array.isArray(saved.shoots) ||
      !Array.isArray(saved.photos) ||
      !saved.shoots.length
    )
      return createStudioState();
    if (
      !saved.shoots.every(
        (shoot) =>
          typeof shoot.id === "string" &&
          typeof shoot.name === "string" &&
          typeof shoot.client === "string" &&
          typeof shoot.type === "string" &&
          typeof shoot.date === "string" &&
          shootStages.includes(shoot.status),
      ) ||
      !saved.photos.every(
        (photo) =>
          typeof photo.id === "string" &&
          typeof photo.name === "string" &&
          typeof photo.image === "string" &&
          typeof photo.shootId === "string",
      )
    )
      return createStudioState();
    const initial = createStudioState();
    if (
      Object.entries(defaultBrand).some(
        ([key, value]) =>
          saved.brand?.[key] !== undefined &&
          typeof saved.brand[key] !== typeof value,
      ) ||
      ["layout", "coverId", "about", "contact"].some(
        (key) =>
          saved.website?.[key] !== undefined &&
          typeof saved.website[key] !== "string",
      ) ||
      ["mode", "domain", "server", "billing"].some(
        (key) =>
          saved.publishing?.[key] !== undefined &&
          typeof saved.publishing[key] !== "string",
      )
    )
      return createStudioState();
    const galleries = Object.fromEntries(
      Object.entries(saved.galleries || {})
        .filter(([id]) => saved.shoots.some((shoot) => shoot.id === id))
        .map(([id, gallery]) => {
          if (
            ["password", "invite", "expires"].some(
              (key) =>
                gallery?.[key] !== undefined &&
                typeof gallery[key] !== "string",
            )
          )
            return [id, createProofGallery(id)];
          const selectionLimit = Math.max(
            1,
            Math.min(50, Number(gallery?.selectionLimit) || 3),
          );
          const clientSelected = Array.isArray(gallery?.clientSelected)
            ? [...new Set(gallery.clientSelected)]
                .filter((photoId) =>
                  saved.photos.some(
                    (photo) =>
                      photo.id === photoId &&
                      photo.shootId === id &&
                      photo.selected &&
                      !photo.rejected,
                  ),
                )
                .slice(0, selectionLimit)
            : [];
          const comments = Array.isArray(gallery?.comments)
            ? gallery.comments.filter(
                (comment) =>
                  typeof comment?.id === "string" &&
                  typeof comment.author === "string" &&
                  typeof comment.text === "string",
              )
            : [];
          return [
            id,
            {
              ...createProofGallery(id),
              ...gallery,
              id,
              selectionLimit,
              export: { ...createProofGallery(id).export, ...gallery?.export },
              clientSelected,
              comments,
            },
          ];
        }),
    );
    return {
      ...initial,
      ...saved,
      brand: { ...defaultBrand, ...saved.brand },
      website: {
        ...initial.website,
        ...saved.website,
        order: Array.isArray(saved.website?.order)
          ? saved.website.order.filter((id) =>
              saved.photos.some((photo) => photo.id === id),
            )
          : initial.website.order,
      },
      publishing: { ...initial.publishing, ...saved.publishing },
      galleries,
    };
  } catch {
    return createStudioState();
  }
}

export function saveStudioState(storage, state) {
  try {
    storage.setItem(photographyStorageKey, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
