// Local design state only. Prices, payments and delivery never call a service.
export const WORKFLOW_MODES = [
  {
    id: "delivery",
    name: "Edited delivery",
    description:
      "Finish the collection, then share clean approved photographs.",
    icon: "mdiImageCheckOutline",
  },
  {
    id: "selection",
    name: "Select before editing",
    description: "Let your client choose the photographs you will finish.",
    icon: "mdiHeartOutline",
  },
  {
    id: "sales",
    name: "Sell by the photograph",
    description:
      "Proof every eligible capture. Edit and deliver the purchased choices.",
    icon: "mdiCartOutline",
  },
];
export const GALLERY_TEMPLATES = [
  {
    id: "wedding",
    name: "Wedding story",
    description:
      "An expansive cover, intimate image pairs and chapters for the whole day.",
    image: "/media/wedding-elopement.png",
    color: "#e9e4dc",
  },
  {
    id: "portrait",
    name: "Family & portrait",
    description:
      "A welcoming introduction and a considered, easy-to-browse collection.",
    image: "/media/portrait.png",
    color: "#e8eae4",
  },
  {
    id: "fine-art",
    name: "Editorial & fine art",
    description:
      "Room to breathe. Quiet captions, intentional sequences and striking diptychs.",
    image: "/media/flowers.png",
    color: "#eeeae6",
  },
  {
    id: "proofing",
    name: "Proofing & sales",
    description:
      "A focused contact sheet with comparison, clear photo numbers and selections.",
    image: "/media/hiking.png",
    color: "#e7e9ec",
  },
];

export const money = (cents, currency = "CAD") =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(
    (Number(cents) || 0) / 100,
  );
export const eligiblePhoto = (photo) =>
  !photo.rejected && !photo.locked && !photo.withheld && !photo.importFailed;

export function orderProjectPhotos(photos, gallery = {}) {
  const order = gallery.photoOrder || photos.map((photo) => photo.id);
  const chapters = gallery.chapters || [];
  const position = (photo) =>
    order.includes(photo.id)
      ? order.indexOf(photo.id)
      : order.length + photos.indexOf(photo);
  return [...photos].sort(
    (a, b) =>
      chapters.indexOf(a.chapter) - chapters.indexOf(b.chapter) ||
      position(a) - position(b),
  );
}

export function selectionPrice(gallery, ids = gallery.clientSelected || []) {
  const count = new Set(ids).size;
  const included = Math.min(
    count,
    Math.max(0, Math.min(5000, Math.floor(Number(gallery.includedCount) || 0))),
  );
  const extra = gallery.workflowMode === "delivery" ? 0 : count - included;
  const unitPriceCents = Math.max(
    0,
    Math.min(1000000, Math.round(Number(gallery.extraPriceCents) || 0)),
  );
  return {
    count,
    included,
    extra,
    unitPriceCents,
    totalCents: extra * unitPriceCents,
  };
}

export function createSelectionOrder(gallery, ids) {
  const photoIds = [...new Set(ids)];
  return {
    id: `CL-${String(Date.now()).slice(-6)}`,
    photoIds,
    ...selectionPrice(gallery, photoIds),
    currency: gallery.currency || "CAD",
    confirmed: false,
    payment: "unpaid",
    finalsApproved: false,
    createdAt: new Date().toISOString(),
  };
}

export function deliveryBlockers(gallery, photos = []) {
  if (!gallery) return ["Create a gallery first"];
  if (
    gallery.expired ||
    gallery.offline ||
    (gallery.expires && gallery.expires < new Date().toISOString().slice(0, 10))
  )
    return ["Gallery access is unavailable"];
  const order = gallery.order;
  if (!gallery.workflowEnabled)
    return gallery.approved ? [] : ["Approve the client selection"];
  if (!order) return ["Receive the client selection"];
  const selected = order.photoIds.map((id) =>
    photos.find((photo) => photo.id === id),
  );
  const blockers = [];
  if (
    !order.photoIds.length ||
    selected.some((photo) => !photo || !eligiblePhoto(photo))
  )
    blockers.push("Review unavailable photographs");
  if (!order.confirmed) blockers.push("Confirm the selection and price");
  if (selected.some((photo) => photo && !photo.edited))
    blockers.push("Finish the selected edits");
  if (!order.finalsApproved || !gallery.approved)
    blockers.push("Approve the finished versions");
  if (order.totalCents > 0 && order.payment !== "paid")
    blockers.push("Collect the outstanding payment");
  return blockers;
}

export function downloadablePhotos(gallery, photos) {
  if (
    !gallery?.delivered ||
    !gallery.downloadAllowed ||
    deliveryBlockers(gallery, photos).length
  )
    return [];
  const ids = gallery.order?.photoIds || gallery.clientSelected || [];
  return photos.filter(
    (photo) => ids.includes(photo.id) && eligiblePhoto(photo) && photo.edited,
  );
}

export function projectNextAction(gallery, photos = []) {
  if (gallery?.delivered)
    return {
      label: "Delivery complete",
      section: "galleries",
      icon: "mdiCheckAll",
    };
  if (gallery?.order) {
    const blockers = deliveryBlockers(gallery, photos);
    return {
      label: blockers[0] || "Prepare final delivery",
      section: "orders",
      icon: "mdiClipboardCheckOutline",
    };
  }
  if (gallery?.submitted)
    return {
      label: "Review client selections",
      section: "orders",
      icon: "mdiHeartOutline",
    };
  if (gallery?.invited || gallery?.published)
    return {
      label: "Waiting for client choices",
      section: "workflow",
      icon: "mdiClockOutline",
    };
  return {
    label: photos.length
      ? "Assemble your gallery"
      : "Import the first photographs",
    section: "intake",
    icon: "mdiImageMultipleOutline",
  };
}

// Add new sample journeys once; saved projects and existing settings are retained.
export function seedPhotographyProjects(state, createGallery) {
  if (state.depthSamplesAdded === 2) return state;
  const shoots = [
    {
      id: "martin-family-selections",
      name: "Sunday with the Martins",
      client: "The Martin family",
      type: "Family portrait",
      date: "2026-10-01",
      status: "Proofing",
      cover: "/media/hiking.png",
      due: "2026-10-15",
      brief:
        "Six finished family photographs included. Let the family choose before retouching.",
    },
    {
      id: "maya-theo-wedding",
      name: "Maya & Theo",
      client: "Maya & Theo",
      type: "Wedding",
      date: "2026-09-28",
      status: "Edited",
      cover: "/media/wedding-elopement.png",
      due: "2026-10-12",
      brief:
        "An intimate mountain wedding. Warm tones, natural moments and a story of the whole day.",
    },
    {
      id: "bennett-proof-session",
      name: "The Bennett portraits",
      client: "Alex & Sam Bennett",
      type: "Portrait session",
      date: "2026-09-30",
      status: "Proofing",
      cover: "/media/portrait.png",
      due: "2026-10-09",
      brief:
        "Ten finished photographs included. Choose additional portraits for $25 each.",
    },
  ].filter(
    (shoot) => !state.shoots.some((existing) => existing.id === shoot.id),
  );
  const scenes = [
    "portrait",
    "hiking",
    "lake",
    "flowers",
    "dog",
    "forest",
    "creek",
    "cabin",
    "campfire",
    "summit",
    "kayak",
    "trail-sign",
    "elk",
    "portrait",
  ];
  const photos = shoots.flatMap((shoot) =>
    scenes.slice(0, shoot.type === "Wedding" ? 8 : 14).map((scene, index) => ({
      id: `${shoot.id}-${index + 1}`,
      shootId: shoot.id,
      image:
        shoot.type === "Wedding" && index === 0
          ? shoot.cover
          : `/media/${scene}.png`,
      name: `${shoot.type === "Wedding" ? "Wedding" : "Portrait"} frame ${String(index + 1).padStart(2, "0")}`,
      fileName: `CL_${shoot.type === "Wedding" ? "W" : "P"}${String(index + 1).padStart(4, "0")}.CR3`,
      jpegFileName: `CL_${shoot.type === "Wedding" ? "W" : "P"}${String(index + 1).padStart(4, "0")}.JPG`,
      raw: true,
      extension: "CR3",
      camera: index % 2 ? "Canon EOS R6 Mark II" : "Canon EOS R5",
      selected: shoot.type === "Wedding",
      edited: shoot.type === "Wedding",
      deliverable: false,
      rejected: false,
      locked: false,
      withheld: shoot.type !== "Wedding" && index === 13,
      importFailed: shoot.type !== "Wedding" && index === 12,
      rating: shoot.type === "Wedding" ? 5 : 0,
      chapter:
        shoot.type === "Wedding"
          ? index < 3
            ? "The ceremony"
            : "After the vows"
          : index < 6
            ? "By the lake"
            : "A little adventure",
    })),
  );
  const galleries = { ...state.galleries };
  for (const shoot of shoots) {
    const wedding = shoot.type === "Wedding";
    const selection = shoot.id === "martin-family-selections";
    const ids = photos
      .filter(
        (photo) =>
          photo.shootId === shoot.id &&
          !photo.importFailed &&
          eligiblePhoto(photo),
      )
      .map((photo) => photo.id);
    galleries[shoot.id] = {
      ...createGallery(shoot.id),
      workflowEnabled: true,
      workflowMode: wedding ? "delivery" : selection ? "selection" : "sales",
      proofScope: "all",
      webWatermark: true,
      proofPattern: "tile",
      template: wedding ? "wedding" : selection ? "portrait" : "proofing",
      includedCount: wedding ? ids.length : selection ? 6 : 10,
      extraPriceCents: wedding || selection ? 0 : 2500,
      currency: "CAD",
      selectionLimit: selection ? 6 : 50,
      clientSelected: wedding ? ids : [],
      submitted: wedding,
      chapters: wedding
        ? ["The ceremony", "After the vows"]
        : ["By the lake", "A little adventure"],
      coverStyle: wedding ? "full-bleed" : "split",
      spacing: "comfortable",
      published: selection,
      invited: selection,
      reminders: { selections: true, payment: true, expiry: true },
      portfolioConsent: false,
    };
    if (wedding)
      galleries[shoot.id].order = createSelectionOrder(
        galleries[shoot.id],
        ids,
      );
  }
  return {
    ...state,
    depthSamplesAdded: 2,
    shoots: [...shoots, ...state.shoots],
    photos: [...state.photos, ...photos],
    galleries,
  };
}
