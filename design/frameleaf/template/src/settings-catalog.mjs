// Prototype configuration, not deployed server defaults or a production API schema.
import { settingsExtensions } from "./settings-advanced.mjs";
import { utilityTools } from "./utilities-data.mjs";
import { settingsSearchAliases } from "./settings-search-aliases.mjs";

const toggle = (id, label, value, help, impact = "From now on") => ({
  id,
  label,
  value,
  help,
  impact,
  type: "toggle",
});
const select = (
  id,
  label,
  value,
  options,
  help,
  impact = "From now on",
) => ({ id, label, value, options, help, impact, type: "select" });
const number = (
  id,
  label,
  value,
  unit,
  min,
  max,
  help,
  impact = "From now on",
) => ({
  id,
  label,
  value,
  unit,
  min,
  max,
  help,
  impact,
  type: "number",
  integer: Number.isInteger(min) && Number.isInteger(max) && max > 2,
});
const text = (
  id,
  label,
  value,
  help,
  impact = "From now on",
  type = "text",
) => ({ id, label, value, help, impact, type });
const section = (id, title, description, fields, extra = {}) => ({
  id,
  title,
  description,
  fields,
  ...extra,
});

export const settingsAreas = [
  {
    id: "overview",
    title: "Overview",
    icon: "mdiViewDashboardOutline",
    group: "Command center",
    description: "How your library is doing and anything that needs you.",
  },
  {
    id: "analytics",
    title: "Library analytics",
    icon: "mdiChartTimelineVariant",
    group: "Command center",
    description: "How your library grows and gets used over time.",
  },
  {
    id: "storage",
    title: "Storage & originals",
    icon: "mdiHarddisk",
    group: "Your library",
    description: "Where your photos are kept and how long deleted ones stay.",
  },
  {
    id: "backup",
    title: "Import & protection",
    icon: "mdiBackupRestore",
    group: "Your library",
    description: "Bring photos in and keep safe copies of everything.",
  },
  {
    id: "intelligence",
    title: "Search & intelligence",
    icon: "mdiImageSearchOutline",
    group: "Your library",
    description: "Find photos by what's in them, who's in them and what they say.",
  },
  {
    id: "editing",
    title: "Editing & playback",
    icon: "mdiMovieOpenOutline",
    group: "Your library",
    description:
      "How photos look, videos play and edits are saved.",
  },
  {
    id: "sharing",
    title: "People & sharing",
    icon: "mdiAccountMultipleOutline",
    group: "Your library",
    description: "Share with family and friends, and control what they see.",
  },
  {
    id: "care",
    title: "Library care",
    icon: "mdiShieldCheckOutline",
    group: "Your library",
    description: "Keep your library complete, healthy and free of duplicates.",
  },
  {
    id: "processing",
    title: "Compute & jobs",
    icon: "mdiDesktopTowerMonitor",
    group: "Your server",
    description:
      "Which computers do the heavy work, and when.",
  },
  {
    id: "cloud",
    title: "Frameleaf Cloud",
    icon: "mdiCloudOutline",
    group: "Your server",
    description:
      "Optional extras: reach your photos from anywhere, back them up and use cloud AI.",
  },
  {
    id: "security",
    title: "Access & security",
    icon: "mdiShieldLockOutline",
    group: "Your server",
    description: "Who can sign in, and what stays private.",
  },
  {
    id: "notifications",
    title: "Notifications",
    icon: "mdiBellOutline",
    group: "Your server",
    description: "What you're told about, and how emails are sent.",
  },
  {
    id: "server",
    title: "Server & updates",
    icon: "mdiServerOutline",
    group: "Your server",
    description: "Your server's name, updates, maps and look.",
  },
  {
    id: "maintenance",
    title: "Maintenance",
    icon: "mdiWrenchOutline",
    group: "Your server",
    description: "Pause access, back up and check your library for problems.",
  },
  {
    id: "preferences",
    title: "Your preferences",
    icon: "mdiAccountOutline",
    group: "Personal",
    description: "How Frameleaf looks and behaves for you.",
  },
  {
    id: "users",
    title: "Users",
    icon: "mdiAccountMultipleOutline",
    group: "Your server",
    description: "Who has an account and how much space they get.",
  },
  {
    id: "libraries",
    title: "Libraries",
    icon: "mdiFolderOutline",
    group: "Your library",
    description: "Folders on your disk that Frameleaf keeps in your library.",
  },
  {
    id: "utilities",
    title: "Utilities",
    icon: "mdiTools",
    group: "Your library",
    description: "Tools to review, fix and tidy your photos.",
  },
  {
    id: "trash",
    title: "Trash",
    icon: "mdiDeleteOutline",
    group: "Your library",
    description:
      "Restore deleted photos and videos, or permanently remove them.",
  },
  {
    id: "history",
    title: "Change history",
    icon: "mdiHistory",
    group: "Personal",
    description: "Every settings change saved here, with when and what changed.",
  },
];

export const settingsSections = {
  storage: [
    section(
      "volumes",
      "Library storage",
      "See how much space your photos use and where they live.",
      [
        text(
          "libraryLabel",
          "Storage label",
          "Photo archive",
          "A name that helps you recognise this drive.",
          "Display only",
        ),
        number(
          "capacityAlert",
          "Warn when disk usage reaches",
          85,
          "%",
          50,
          99,
          "Counts everything on the drive, not only your photos.",
        ),
      ],
      { panel: "volumes" },
    ),
    section(
      "organization",
      "Originals & folder structure",
      "Choose how your original files are named and sorted into folders.",
      [
        toggle(
          "storageTemplate",
          "Sort new uploads into folders",
          false,
          "Files you already have stay put until you choose to move them.",
          "New uploads; existing files stay put",
        ),
        text(
          "template",
          "Folder template",
          "{{y}}/{{MM}}/{{filename}}",
          "See where a file would go before anything moves.",
          "New uploads",
        ),
        select(
          "rawPreference",
          "Preferred keeper format",
          "RAW + original JPEG",
          [
            "RAW + original JPEG",
            "Highest resolution original",
            "Review each group",
          ],
          "When a RAW and a JPEG are the same shot, keep them together and choose which leads.",
        ),
      ],
    ),
    section(
      "deduplication",
      "Physical deduplication",
      "Store identical files once while everyone keeps their own copy in their library.",
      [
        toggle(
          "physicalDedup",
          "Store identical files once",
          true,
          "Only exact copies are merged; photos that merely look alike are never merged.",
          "New uploads",
        ),
        toggle(
          "dedupVerify",
          "Double-check before freeing space",
          true,
          "Nobody loses a photo when a shared copy is cleaned up.",
        ),
      ],
    ),
    section(
      "retention",
      "Trash & retention",
      "How long you can get deleted photos back.",
      [
        number(
          "trashDays",
          "Keep deleted items for",
          30,
          "days",
          1,
          365,
          "Shortening this can permanently remove items already in Trash.",
          "Items already in Trash",
        ),
        number(
          "deleteDelay",
          "Keep deleted accounts for",
          7,
          "days",
          1,
          365,
          "Time to change your mind before an account and its photos are removed.",
          "Accounts being deleted",
        ),
      ],
    ),
    section(
      "migration",
      "Move or export your library",
      "Move your library to new storage or export a complete copy.",
      [],
      { action: "Prepare migration checklist", actionKind: "migration" },
    ),
  ],
  backup: [
    section(
      "sources",
      "External libraries",
      "Folders on your disk that Frameleaf keeps in your library.",
      [
        toggle(
          "libraryWatch",
          "Notice new files right away",
          false,
          "Network drives may need scheduled scans instead.",
        ),
        select(
          "libraryScan",
          "Look for changes",
          "Every night",
          ["Every night", "Weekly", "Manually"],
          "Finds new, changed and removed files; this isn't a backup.",
        ),
        text(
          "exclusions",
          "Files to skip",
          "**/.DS_Store, **/@eaDir/**",
          "Patterns separated by commas, such as **/@eaDir/**.",
        ),
      ],
      { panel: "libraries" },
    ),
    section(
      "takeout",
      "Google Photos & server imports",
      "Bring in a Google Photos export or another server, check it, then import.",
      [
        toggle(
          "takeoutAlbums",
          "Keep album memberships",
          true,
          "Photos you already have still join the albums they were in.",
        ),
        toggle(
          "sidecarReview",
          "Check unclear details before import",
          true,
          "Lets you check translated album names, split downloads and Live Photo pairs.",
        ),
      ],
      { action: "Preview import workflow", actionKind: "import" },
    ),
    section(
      "database-backup",
      "Database backups",
      "Back up your albums, people and edits; your original files need a separate backup.",
      [
        toggle(
          "databaseBackup",
          "Schedule database backups",
          true,
          "Keep backups on a different drive so one failure can't take both.",
        ),
        select(
          "backupSchedule",
          "Backup schedule",
          "Daily at 02:00",
          ["Daily at 02:00", "Daily at 04:00", "Weekly on Sunday"],
          "Times are in the server's time zone.",
        ),
        number(
          "backupRetention",
          "Keep recent database backups",
          14,
          "copies",
          1,
          90,
          "Older backups are removed only after a new one succeeds.",
        ),
      ],
      { action: "Review recovery readiness", actionKind: "recovery" },
    ),
    section(
      "preservation",
      "Originals & preservation",
      "Export your originals with their albums, edits and history.",
      [
        toggle(
          "exportSidecars",
          "Include details and edits",
          true,
          "Descriptions you wrote stay separate from ones Frameleaf generated.",
        ),
        toggle(
          "exportChecksums",
          "Include a verification list",
          true,
          "Lets you confirm every file copied correctly and practise a restore.",
        ),
      ],
      { action: "Preview preservation manifest", actionKind: "preservation" },
    ),
    section(
      "devices-backup",
      "Mobile backup & migration",
      "Set up phone backup and move from another app.",
      [
        toggle(
          "uploaderReminder",
          "Warn about two backup apps",
          true,
          "Reminds people moving from another app not to back up with both at once.",
        ),
      ],
      { panel: "devices" },
    ),
  ],
  intelligence: [
    section(
      "smart-search",
      "Visual search",
      "Find photos by describing what's in them, as well as by text and file name.",
      [
        toggle(
          "smartSearch",
          "Search by description",
          true,
          "Find photos by typing things like “dog on a beach”; changing the model re-reads your whole library.",
          "Re-reads your library",
        ),
        text(
          "clipModel",
          "Search model",
          "ViT-B-32__openai",
          "Try a few searches before re-reading the whole library with a new model.",
          "Re-reads your library",
        ),
      ],
    ),
    section(
      "descriptions",
      "Descriptions & tags",
      "Automatic captions and tags that make photos easier to find.",
      [
        toggle(
          "descriptions",
          "Write captions for photos",
          true,
          "Captions and tags you wrote yourself are never replaced.",
        ),
        text(
          "descriptionModel",
          "Description model",
          "Configured endpoint model",
          "Which models you can pick depends on the computer doing the work.",
        ),
        text(
          "descriptionPrompt",
          "Caption instructions",
          "Describe the visible scene, people, activity, and meaningful details. Use confirmed names only.",
          "Try the instructions on one photo before re-captioning the library.",
          "Existing copies when regenerated",
          "textarea",
        ),
        toggle(
          "videoDescriptions",
          "Describe video moments",
          true,
          "Reusable frames should not depend on duplicate detection.",
        ),
        number(
          "videoInterval",
          "Sample a frame every",
          15,
          "seconds",
          1,
          120,
          "More frames increase processing time and may improve moment coverage.",
        ),
      ],
      { action: "Preview a description", actionKind: "description" },
    ),
    section(
      "faces",
      "Faces & identity",
      "Recognise the people in your photos; your own corrections always win.",
      [
        toggle(
          "faceRecognition",
          "Recognise faces",
          true,
          "Groups photos of the same person; names and fixes you made are kept.",
        ),
        number(
          "faceDistance",
          "How alike faces must be",
          0.5,
          "",
          0.1,
          1,
          "Lower is stricter and makes fewer wrong matches; check a few people before applying it everywhere.",
          "Re-checks affected faces",
        ),
        toggle(
          "durableVerdicts",
          "Keep my face corrections",
          true,
          "Your “same person” and “different person” choices are kept when faces are re-checked.",
        ),
      ],
    ),
    section(
      "pets",
      "Individual pets",
      "Recognize and name your cats and dogs.",
      [
        toggle(
          "petRecognition",
          "Recognize individual pets",
          false,
          "Tells your pets apart so you can name each one.",
        ),
        toggle(
          "petReview",
          "Ask before renaming pets",
          true,
          "If a pet is recognised differently later, you decide what happens.",
        ),
      ],
    ),
    section(
      "documents",
      "Text, documents & receipts",
      "Find text in photos, documents and receipts.",
      [
        toggle(
          "ocr",
          "Read text in photos",
          true,
          "Makes signs, receipts and documents searchable by the words in them.",
        ),
        number(
          "ocrConfidence",
          "Text certainty",
          0.7,
          "",
          0,
          1,
          "Lower finds more faded text but also more mistakes.",
        ),
        toggle(
          "documentFields",
          "Suggest receipt details",
          false,
          "Suggestions stay editable and point to where they were read.",
        ),
      ],
    ),
    section(
      "classification",
      "Categories & smart albums",
      "Sort photos into categories without overriding your own choices.",
      [
        toggle(
          "smartAlbums",
          "Build smart albums",
          true,
          "Albums like Pets, Documents and Best photos that fill themselves.",
        ),
        toggle(
          "classification",
          "Suggest my own categories",
          true,
          "See which photos match before anything is tagged.",
        ),
        select(
          "classificationAction",
          "What a category does",
          "Suggest for review",
          ["Suggest for review", "Add rule-owned tags"],
          "Nothing is archived unless you choose that for a rule.",
        ),
        toggle(
          "bestPhotos",
          "Pick out your best shots",
          true,
          "Helps choose album covers, memories and which photos to keep.",
        ),
      ],
    ),
    section(
      "sensitive-detection",
      "Locked-content detection",
      "Spot private photos that may belong in Locked.",
      [
        toggle(
          "sensitiveDetect",
          "Suggest photos to lock",
          true,
          "What Locked hides is set in Access & security.",
        ),
        number(
          "sensitiveThreshold",
          "How sure to be",
          0.8,
          "",
          0,
          1,
          "Check a few results before scanning the whole library.",
        ),
      ],
    ),
  ],
  editing: [
    section(
      "previews",
      "Photo previews",
      "Smaller copies that make browsing fast.",
      [
        number(
          "thumbnailSize",
          "Thumbnail size",
          250,
          "px",
          100,
          1000,
          "Applies to new thumbnails; existing ones change when you regenerate them.",
        ),
        number(
          "previewSize",
          "Preview size",
          1440,
          "px",
          720,
          4096,
          "Larger previews look sharper but use more space; originals are untouched.",
        ),
        select(
          "previewFormat",
          "Preview format",
          "WebP",
          ["WebP", "JPEG"],
          "JPEG works everywhere; WebP takes less space.",
        ),
        number(
          "previewQuality",
          "Preview quality",
          80,
          "%",
          1,
          100,
          "Higher looks better and uses more space.",
        ),
      ],
    ),
    section(
      "playback",
      "Video playback copies",
      "Copies of your videos that play smoothly on every device.",
      [
        select(
          "transcodePolicy",
          "Make playback copies",
          "When required",
          [
            "When required",
            "Above target resolution",
            "All videos",
            "Disabled",
          ],
          "Your original video is always kept.",
        ),
        select(
          "playbackResolution",
          "Playback copy size",
          "1080p",
          ["720p", "1080p", "1440p", "2160p"],
          "Only affects playback copies, never your originals.",
        ),
        select(
          "playbackCodec",
          "Playback format",
          "H.264",
          ["H.264", "HEVC", "VP9", "AV1"],
          "H.264 plays almost everywhere; newer formats are smaller but not supported on every device.",
        ),
        number(
          "playbackCrf",
          "Playback quality",
          23,
          "",
          0,
          51,
          "Lower numbers look better and use more space.",
        ),
        select(
          "playbackPreset",
          "Conversion speed",
          "Medium",
          ["Fast", "Medium", "Slow"],
          "Slower makes smaller files but takes longer.",
        ),
        select(
          "acceleration",
          "Hardware acceleration",
          "Auto when qualified",
          ["Auto when qualified", "Software", "NVENC", "QSV", "VAAPI"],
          "Use your graphics card to convert videos faster; check Hardware & GPU if it fails.",
        ),
        select(
          "audioCodec",
          "Playback audio format",
          "AAC",
          ["AAC", "Opus", "MP3"],
          "Only affects playback copies.",
        ),
      ],
    ),
    section(
      "masters",
      "Edited masters",
      "How your edited photos and videos are saved.",
      [
        select(
          "masterResolution",
          "Resolution",
          "Preserve source",
          ["Preserve source", "Explicit export dimensions"],
          "Edits keep the original size.",
        ),
        select(
          "masterColor",
          "Color handling",
          "Preserve source color",
          ["Preserve source color", "Explicit SDR derivative"],
          "Edits keep the original colours, including HDR.",
        ),
        select(
          "masterAudio",
          "Audio handling",
          "Preserve channels & timing",
          ["Preserve channels & timing", "Explicit stereo downmix"],
          "Edits keep every audio channel as recorded.",
        ),
        select(
          "trimMode",
          "How trims are cut",
          "Precise",
          ["Precise", "Fast · keyframe aligned"],
          "Precise cuts exactly where you choose; Fast saves quicker but may start slightly earlier.",
        ),
      ],
    ),
    section(
      "restoration",
      "AI restoration",
      "Clean up and sharpen old videos, with a 5-second preview first.",
      [
        select(
          "restorationMode",
          "Restoration style",
          "Faithful",
          ["Faithful", "Creative"],
          "Faithful removes noise without inventing detail; Creative rebuilds detail. Your original is always kept.",
        ),
        select(
          "upscale",
          "Enlarge by",
          "2×",
          ["2×"],
          "Needs a model that fits your GPU, or Frameleaf Cloud.",
        ),
        select(
          "upscaleCap",
          "Largest output size",
          "4K",
          ["4K", "Source dependent"],
          "Caps the size of restored videos.",
        ),
        toggle(
          "interpolation",
          "Offer Smooth motion",
          true,
          "RIFE changes motion timing; it is not part of ordinary upscaling.",
        ),
      ],
    ),
    section(
      "studio",
      "Studio & Dolby Vision",
      "Video projects and Dolby Vision.",
      [
        toggle(
          "studioPreview",
          "Show Studio",
          false,
          "Turns on the Studio video editor, which is still being finished.",
          "Studio only",
        ),
      ],
      { panel: "qualification" },
    ),
  ],
  sharing: [
    section(
      "spaces",
      "Shared Spaces",
      "Shared libraries everyone in your household can add to.",
      [
        select(
          "spaceRole",
          "Default invited role",
          "Viewer",
          ["Viewer", "Editor"],
          "Viewers can look; editors can also add and organise. You can change each person later.",
        ),
        toggle(
          "recipientPreview",
          "Show what people will see",
          true,
          "Before sharing, see exactly which photos others will see; Locked photos stay hidden.",
        ),
        toggle(
          "spaceActivity",
          "Show new since last visit",
          true,
          "Highlights what's new since each person last visited, only from photos they can see.",
        ),
      ],
      { panel: "spaces" },
    ),
    section(
      "links",
      "Public links",
      "Defaults for links anyone can open.",
      [
        number(
          "shareExpiry",
          "Suggested link lifetime",
          7,
          "days",
          1,
          365,
          "Links you already made keep their own end date.",
        ),
        toggle(
          "shareDownload",
          "Allow downloads by default",
          false,
          "Lets people save full-quality originals, not just view them.",
        ),
        toggle(
          "shareLocation",
          "Include location by default",
          false,
          "Public map views and metadata exports respect this choice.",
        ),
      ],
    ),
    section(
      "partner",
      "Partners & recipient groups",
      "Partners who see your library, and groups you often share with.",
      [
        toggle(
          "partnerTimeline",
          "Partner photos in my timeline",
          true,
          "Shows partners' photos in your timeline; Locked photos stay hidden.",
        ),
        toggle(
          "groupReview",
          "Review group recipients",
          true,
          "Changing a group later doesn't change what people already have.",
        ),
      ],
    ),
    section(
      "shared-identities",
      "People across libraries",
      "Recognise the same person in libraries shared with you.",
      [
        toggle(
          "sharedPeople",
          "Suggest matching people in Spaces",
          false,
          "Uses only photos you can see and keeps your corrections.",
        ),
        select(
          "albumSort",
          "Default album viewing order",
          "Newest first",
          ["Newest first", "Oldest first", "Shared album order"],
          "How albums sort for you; a shared album's own order isn't changed.",
        ),
      ],
    ),
  ],
  care: [
    section(
      "health",
      "Media health & integrity",
      "Check that every photo and video is present and undamaged.",
      [
        toggle(
          "healthScan",
          "Check library health regularly",
          true,
          "Checks a little at a time and picks up where it left off.",
        ),
        toggle(
          "checksumScan",
          "Check files for damage",
          true,
          "Finds files that exist but have been silently damaged.",
        ),
        toggle(
          "integrityAudit",
          "Match library to files",
          true,
          "Finds photos listed in the library with no file, and files with no photo.",
        ),
      ],
      { action: "Preview health findings", actionKind: "health" },
    ),
    section(
      "repair",
      "Things to fix",
      "Everything waiting to be fixed, in one place.",
      [
        toggle(
          "livePhotoRepair",
          "Suggest Live Photo relinking",
          true,
          "Reconnects Live Photos with their motion; unclear pairs wait for you.",
        ),
        toggle(
          "rawRecovery",
          "Suggest missing RAW files",
          true,
          "Finds RAW originals that belong with a JPEG you already have.",
        ),
        toggle(
          "duplicateReview",
          "Group near-duplicates for review",
          true,
          "Suggests which copy to keep; nothing is deleted until you choose.",
        ),
      ],
      { panel: "repairs" },
    ),
    section(
      "enrichment-care",
      "Search and recognition progress",
      "See which photos still need faces, captions or search.",
      [
        toggle(
          "incrementalEnrichment",
          "Redo only what changed",
          true,
          "Renaming someone updates their photos without re-checking the rest.",
        ),
        toggle(
          "manualMetadata",
          "Keep what I edited",
          true,
          "Re-checking only replaces what Frameleaf generated, never what you entered.",
        ),
      ],
    ),
  ],
  processing: [
    section(
      "workers",
      "Computers doing the work",
      "This server and other computers at home that help process your photos.",
      [],
      { panel: "workers" },
    ),
    section(
      "hardware",
      "Hardware & GPU",
      "Check that your graphics card is used, fix set-up problems and measure speed.",
      [],
      {
        icon: "mdiExpansionCard",
        keywords:
          "gpu graphics card nvidia cuda amd rocm intel arc openvino vram driver docker compose container toolkit dev dri render group benchmark hardware acceleration transcoding",
      },
    ),
    section(
      "routing",
      "Where each job runs",
      "Choose whether each kind of work runs at home, on Frameleaf Cloud, or either.",
      [
        select(
          "destination",
          "Suggested place for work",
          "local",
          [
            {
              value: "local",
              label: "This server or another computer at home",
            },
            { value: "cloud", label: "Frameleaf Cloud" },
          ],
          "Applies to kinds of work set to Both. Each job can still switch before it starts, and existing jobs keep their destination.",
        ),
        select(
          "localUnavailable",
          "Home computer unavailable",
          "Wait and notify",
          ["Wait and notify", "Stop and tell me how to retry"],
          "Switching to Frameleaf Cloud requires an explicit choice.",
        ),
        toggle(
          "endpointHealth",
          "Check helper computers",
          true,
          "Shows whether each computer answers and what it can run.",
        ),
      ],
    ),
    section(
      "queues",
      "Queues & concurrency",
      "See what's running and how much runs at once, so browsing stays fast.",
      [
        number(
          "thumbnailJobs",
          "Thumbnails at once",
          3,
          "jobs",
          1,
          32,
          "More finishes new uploads sooner but can slow browsing.",
        ),
        number(
          "videoJobs",
          "Video copies at once",
          1,
          "jobs",
          1,
          16,
          "Video conversion is heavy; more at once can slow everything else.",
        ),
        number(
          "mlJobs",
          "ML requests",
          2,
          "jobs",
          1,
          16,
          "Each model declares its memory requirements.",
        ),
        number(
          "importJobs",
          "Import workers",
          2,
          "jobs",
          1,
          16,
          "Import scans and writes remain resumable.",
        ),
      ],
      { panel: "queues" },
    ),
    section(
      "schedules",
      "Nightly work & model cache",
      "Run heavy work when nobody's using the library, like overnight.",
      [
        select(
          "nightlyWindow",
          "Quiet hours for heavy work",
          "01:00–06:00",
          ["01:00–06:00", "23:00–07:00", "No restricted window"],
          "Heavy work runs during these hours in the server's time zone.",
        ),
        number(
          "modelTtl",
          "Free memory after",
          300,
          "seconds",
          30,
          3600,
          "A longer cache lifetime trades memory for startup speed.",
        ),
        toggle(
          "nightlyDuplicates",
          "Find duplicates overnight",
          true,
          "Only finds them; nothing is deleted until you review.",
        ),
      ],
    ),
  ],
  security: [
    section(
      "accounts",
      "People with server access",
      "Accounts, administrators and how much space each person gets.",
      [
        number(
          "defaultQuota",
          "Default new-account quota",
          500,
          "GB",
          1,
          100000,
          "Shared identical files count for each person even though they're stored once.",
        ),
      ],
      { panel: "users" },
    ),
    section(
      "signin",
      "Sign-in methods",
      "How people sign in, and how to get back in.",
      [
        toggle(
          "passwordLogin",
          "Password sign-in",
          true,
          "Don't turn this off until an administrator has signed in another way.",
          "All sign-ins",
        ),
        toggle(
          "oauthEnabled",
          "Sign in with another account",
          false,
          "Let people sign in with an account they already have, such as Google or your own identity provider (OpenID Connect).",
          "All sign-ins",
        ),
        text(
          "oauthIssuer",
          "Issuer URL",
          "https://identity.example.invalid",
          "The address your sign-in provider gives you.",
          "All sign-ins",
          "url",
        ),
        text(
          "oauthClient",
          "Client ID",
          "frameleaf",
          "From your sign-in provider; the secret is stored separately and never exported.",
          "All sign-ins",
        ),
        toggle(
          "oauthAutoRegister",
          "Create accounts automatically",
          false,
          "The first sign-in from an approved address creates an account with the default space limit.",
        ),
      ],
    ),
    section(
      "privacy",
      "Locked content",
      "Keep private photos out of search, sharing and downloads.",
      [
        toggle(
          "hideSensitive",
          "Keep suggested private photos Locked",
          true,
          "They stay hidden until you unlock with your PIN; removing a tag doesn't unlock them.",
          "Everyone's access",
        ),
        number(
          "unlockTimeout",
          "Lock again after",
          15,
          "minutes",
          1,
          240,
          "After unlocking with your PIN, Locked photos hide again after this long.",
        ),
        toggle(
          "locationPrivacy",
          "Remove location from public previews",
          true,
          "Original-download permissions must be reviewed separately.",
        ),
      ],
    ),
    section(
      "credentials",
      "Devices & API access",
      "Phones, computers and apps that can reach your library.",
      [],
      { panel: "sessions" },
    ),
  ],
  notifications: [
    section(
      "signals",
      "What needs my attention",
      "Choose what you want to hear about.",
      [
        toggle(
          "notifyCapacity",
          "Storage capacity warnings",
          true,
          "Tells you before a drive fills up.",
        ),
        toggle(
          "notifyJobs",
          "Failed or interrupted jobs",
          true,
          "Tells you when work stops, with a link to fix it.",
        ),
        toggle(
          "notifyBackup",
          "Missed backups",
          true,
          "Tells you when a backup doesn't run or can't be checked.",
        ),
        toggle(
          "notifyUpdates",
          "New releases",
          true,
          "Show compatibility notes before any update.",
        ),
        select(
          "digest",
          "Routine activity digest",
          "Weekly",
          ["Off", "Daily", "Weekly"],
          "A summary of imports, sharing and finished work.",
        ),
      ],
    ),
    section(
      "email",
      "Email delivery",
      "Send email through your own mail account.",
      [
        toggle(
          "smtpEnabled",
          "Send email",
          false,
          "Send invitations and alerts through your mail server (SMTP).",
        ),
        text(
          "smtpHost",
          "Mail server",
          "smtp.example.invalid",
          "From your email provider, such as smtp.example.com.",
        ),
        number(
          "smtpPort",
          "Mail server port",
          587,
          "",
          1,
          65535,
          "Usually 587 or 465.",
        ),
        select(
          "smtpSecurity",
          "Transport security",
          "STARTTLS",
          ["STARTTLS", "TLS"],
          "Use the transport supported by your provider.",
        ),
        text(
          "emailFrom",
          "Sender address",
          "photos@example.invalid",
          "The address people see emails come from.",
          "New messages",
          "email",
        ),
      ],
      { action: "Preview notification", actionKind: "email" },
    ),
    section(
      "templates",
      "Message templates",
      "How invitation, album and recovery emails look.",
      [
        text(
          "mailGreeting",
          "Invitation greeting",
          "Your memories have a new home.",
          "The first line of an invitation email.",
        ),
        toggle(
          "emailBrand",
          "Use Frameleaf identity",
          true,
          "Emails show the Frameleaf name and logo.",
        ),
      ],
    ),
  ],
  server: [
    section(
      "identity",
      "Server identity",
      "Your server's name, timezone and welcome message.",
      [
        text(
          "serverName",
          "Server name",
          "Home archive",
          "Shown in Settings and when people choose a server in the app.",
          "Display only",
        ),
        select(
          "serverTimezone",
          "Server timezone",
          "America/Edmonton",
          ["America/Edmonton", "America/New_York", "Europe/London", "UTC"],
          "Used for schedules like backups and quiet hours.",
        ),
        text(
          "welcomeMessage",
          "Welcome message",
          "A home for all our memories.",
          "A short note people see before signing in.",
          "Sign-in screen",
        ),
      ],
    ),
    section(
      // Release infrastructure is managed by the Frameleaf build/server. Never
      // expose an editable origin or permit external redirects or fallback feeds.
      "updates",
      "Versions & compatibility",
      "Choose when to check for updates and which release channel to follow.",
      [
        toggle(
          "versionChecks",
          "Check for updates",
          false,
          "Look for new Frameleaf releases. Checking for updates does not install them.",
          "Update checks",
        ),
        select(
          "releaseCheckSchedule",
          "Check frequency",
          "daily",
          [
            { value: "daily", label: "Daily" },
            { value: "weekly", label: "Weekly" },
          ],
          "Choose how often to check when automatic update checks are enabled.",
          "Update checks",
        ),
        select(
          "releaseChannel",
          "Update channel",
          "stable",
          [
            { value: "stable", label: "Stable" },
            { value: "beta", label: "Beta" },
            { value: "development", label: "Development" },
          ],
          "Stable is for everyday use; Beta and Development get changes sooner but may be less reliable.",
          "Update checks",
        ),
        {
          ...toggle(
            "externalVersionChecks",
            "Third-party release checks",
            false,
            "Only Frameleaf is asked about updates; no other service is contacted.",
            "Privacy, always on",
          ),
          locked: true,
          policy: "External release services prohibited",
        },
        {
          ...select(
            "installedBuildChannel",
            "Installed version type",
            "Development",
            ["Development"],
            "Changes only when you install a different version.",
            "Information only",
          ),
          locked: true,
        },
      ],
      { panel: "versions" },
    ),
    section(
      "diagnostics",
      "Logs & diagnostics",
      "Records that help fix problems, without exposing your photos.",
      [
        select(
          "logLevel",
          "How much to record",
          "Info",
          ["Error", "Warn", "Info", "Debug", "Verbose"],
          "More detail helps with problems but can include file names and photo details.",
          "New logs",
        ),
        {
          ...toggle(
            "metrics",
            "Sharing usage with others",
            false,
            "Frameleaf never sends usage data to outside services.",
          ),
          locked: true,
          policy: "External telemetry prohibited",
        },
        toggle(
          "localMetrics",
          "Keep usage statistics",
          false,
          "Powers Library analytics; the history stays on your server.",
          "Local analytics",
        ),
        select(
          "metricsRetention",
          "Keep analytics history for",
          "12 months",
          ["90 days", "12 months", "24 months"],
          "Older statistics are removed; keeping more uses a little more space.",
          "Local analytics",
        ),
      ],
      { action: "Download diagnostics", actionKind: "diagnostics" },
    ),
    section(
      "maps",
      "Maps & geography",
      "Show photos on a map and name the places they were taken.",
      [
        toggle(
          "mapsEnabled",
          "Enable maps",
          true,
          "People only see places for photos they can see.",
        ),
        toggle(
          "reverseGeocoding",
          "Name places from location",
          true,
          "Turns coordinates into names like “Banff”; you can still edit them.",
        ),
        text(
          "mapStyle",
          "Map style address",
          "",
          "Leave empty for the standard map.",
        ),
      ],
    ),
    section(
      "branding",
      "Look & feel",
      "Custom styling for how Frameleaf looks.",
      [
        toggle(
          "customTheme",
          "Use custom styling",
          false,
          "Apply your own CSS; keep text readable and focus outlines visible.",
        ),
        text(
          "customCss",
          "Custom styling (CSS)",
          "",
          "Check light and dark themes, and keep a copy in case you need to undo.",
          "User interface",
          "textarea",
        ),
      ],
      { panel: "compatibility" },
    ),
  ],
  preferences: [
    section(
      "profile",
      "Your profile",
      "Your name, photo and email.",
      [
        text(
          "displayName",
          "Display name",
          "Taylor",
          "How your name appears to others; names you give people in photos stay private.",
          "Your account",
        ),
        text(
          "accountEmail",
          "Email",
          "taylor@example.invalid",
          "Used to sign in and for emails; you may need to confirm a change.",
          "Your account",
          "email",
        ),
      ],
    ),
    section(
      "appearance",
      "Appearance & browsing",
      "Theme, layout and how the library looks on this device.",
      [
        select(
          "themePreference",
          "Color theme",
          "Dark",
          ["Dark", "Light"],
          "Changes how Frameleaf looks on this device.",
          "This device",
        ),
        select(
          "language",
          "Language",
          "English",
          ["English", "Français", "Deutsch", "Español"],
          "The language Frameleaf uses.",
          "Your account",
        ),
        select(
          "defaultLayout",
          "Library view",
          "Work",
          ["Timeline", "Browse", "Work"],
          "The view you start in; switching keeps your selection and filters.",
          "This device",
        ),
        toggle(
          "motion",
          "Reduce decorative motion",
          true,
          "Fewer animations; your device's reduce-motion setting is always followed.",
          "This device",
        ),
        toggle(
          "showFilename",
          "Show filenames in Work view",
          true,
          "Shows each file name under its thumbnail in Work view.",
        ),
      ],
    ),
    section(
      "rediscovery",
      "Memories & discovery",
      "What Memories brings back, and when.",
      [
        toggle(
          "memories",
          "Show memories",
          true,
          "Photos from this day in past years; nothing is shared unless you share it.",
        ),
        toggle(
          "birthdayMemories",
          "Include birthday memories",
          true,
          "Remembers birthdays of people you've added a birthday for.",
        ),
        toggle(
          "videoMoments",
          "Include video moments",
          true,
          "Memories can include short moments from videos.",
        ),
      ],
    ),
    section(
      "downloads",
      "Downloads & local behavior",
      "What you get when you download photos.",
      [
        select(
          "downloadFormat",
          "Preferred download",
          "Original",
          ["Original", "Edited version when available"],
          "Get the original, or your edited version when there is one.",
        ),
        toggle(
          "downloadMetadata",
          "Include photo details files",
          true,
          "Adds a small file with dates, places and tags next to each photo, leaving the photo unchanged.",
        ),
        toggle(
          "archiveTimeline",
          "Show archived media in search",
          false,
          "Archived photos still appear in search; use Locked to keep them private.",
        ),
      ],
    ),
    section(
      "suppression",
      "Hidden memories",
      "People, places and dates you'd rather Memories skipped.",
      [],
      { action: "Review hidden memory rules", actionKind: "suppression" },
    ),
  ],
};

// Merge extensions before deriving defaults, search, persistence validation, and
// change-review context. Every control has one stable ID and canonical area.
for (const [area, sections] of Object.entries(settingsExtensions)) {
  settingsSections[area] = [...(settingsSections[area] ?? []), ...sections];
}

// Keep existing section and field identities while moving their canonical homes.
function moveSection(from, to, id) {
  const index = settingsSections[from].findIndex(
    (section) => section.id === id,
  );
  const [section] = settingsSections[from].splice(index, 1);
  (settingsSections[to] ??= []).push(section);
}
moveSection("security", "users", "accounts");
moveSection("backup", "libraries", "sources");
settingsSections.utilities = utilityTools.map((tool) => ({
  ...tool,
  fields: [],
  scope: "resource",
  module: "UtilitiesManager",
}));
settingsSections.trash = [
  section(
    "contents",
    "Trash",
    "Review deleted photos and videos before they leave your library permanently.",
    [],
    { scope: "account", module: "TrashManager" },
  ),
];
settingsSections.preferences.push(
  section(
    "account-security",
    "Account access",
    "Your password, PIN, signed-in devices and app access.",
    [],
    { scope: "account", module: "PersonalAccess" },
  ),
);
settingsSections.server.push(
  section(
    "configuration",
    "Copy settings",
    "Save your settings to a file or load them from one.",
    [],
    { scope: "server", module: "ConfigurationTransfer" },
  ),
);

settingsSections.maintenance = [
  section(
    "mode",
    "Maintenance mode",
    "Pause access for everyone except administrators while you work on the server.",
    [],
    {
      scope: "server",
      module: "Maintenance",
      icon: "mdiWrenchOutline",
      keywords: "maintenance page downtime read-only offline start end",
    },
  ),
  section(
    "backups",
    "Database backups",
    "Create, download, restore and remove database backups.",
    [],
    {
      scope: "server",
      module: "Maintenance",
      icon: "mdiDatabaseOutline",
      keywords: "backup restore snapshot download delete migrations recovery",
    },
  ),
  section(
    "integrity",
    "Integrity checks",
    "Look for damaged, missing and stray files, then review what was found.",
    [],
    {
      scope: "server",
      module: "Maintenance",
      icon: "mdiShieldCheckOutline",
      keywords:
        "integrity check checksum orphan orphaned missing thumbnail sidecar report csv verify",
    },
  ),
];

// Frameleaf Cloud is optional: every section here explains what stays local and
// is rendered by FrameleafCloud.jsx rather than as a list of draft fields.
settingsSections.cloud = [
  section(
    "cloud-account",
    "Account & link",
    "Link this server to a Frameleaf account to turn on optional cloud features.",
    [],
    {
      scope: "server",
      module: "FrameleafCloud",
      icon: "mdiLinkVariant",
      keywords:
        "frameleaf account link unlink device code pair connect instance fingerprint headless token permissions",
    },
  ),
  section(
    "cloud-plan",
    "Plan",
    "Your Frameleaf Cloud subscription for remote access and cloud backup.",
    [],
    {
      scope: "server",
      module: "FrameleafCloud",
      icon: "mdiCreditCardOutline",
      keywords:
        "plan subscription monthly yearly renew grace billing checkout frameleaf cloud price discount",
    },
  ),
  section(
    "cloud-license",
    "Licence",
    "Activate a licence key or install a licence file for an offline server.",
    [],
    {
      scope: "server",
      module: "FrameleafCloud",
      icon: "mdiCertificateOutline",
      keywords:
        "licence license supporter product key activation offline certificate file badge discount licensed server",
    },
  ),
  section(
    "cloud-remote",
    "Remote access",
    "Reach this server away from home through the Frameleaf relay or a direct connection.",
    [
      text(
        "externalUrl",
        "Public server URL",
        "https://photos.example.invalid",
        "The address people use to reach your photos from outside your home, used in shared links and emails.",
        "New links",
      ),
    ],
    {
      scope: "server",
      module: "FrameleafCloud",
      icon: "mdiEarth",
      keywords:
        "remote access relay direct connect upnp nat-pmp port forwarding public url server url hostname custom domain cname dns certificate cgnat away from home",
    },
  ),
  section(
    "cloud-processing",
    "Cloud processing",
    "Use powerful cloud AI for the jobs you choose, paid per job from your AI credit.",
    [],
    {
      scope: "server",
      module: "FrameleafCloud",
      icon: "mdiCloudSyncOutline",
      keywords:
        "cloud processing gpu ai wallet credit consent models describe upscale enhance restore transcribe budget cost",
    },
  ),
  section(
    "cloud-backup",
    "Cloud backup",
    "Keep an encrypted copy of your photos and library off-site.",
    [],
    {
      scope: "server",
      module: "FrameleafCloud",
      icon: "mdiCloudUploadOutline",
      keywords:
        "cloud backup offsite bucket wasabi s3 encryption key recovery kit restore verify retention schedule",
    },
  ),
];
settingsSections.security.push(
  section(
    "frameleaf-signin",
    "Sign in with Frameleaf",
    "Let people sign in with their Frameleaf account, which remote access needs.",
    [],
    {
      scope: "server",
      module: "FrameleafCloud",
      icon: "mdiShieldAccountOutline",
      keywords: "frameleaf account sign in login openid provider remote visitors",
    },
  ),
);
settingsSections.preferences.push(
  section(
    "frameleaf-account",
    "Frameleaf account",
    "Link your own Frameleaf account so you can sign in when you are away from home.",
    [],
    {
      scope: "account",
      module: "PersonalAccess",
      icon: "mdiCloudOutline",
      keywords: "frameleaf account link unlink remote sign in away from home",
    },
  ),
);

function moveField(id, area, sectionId) {
  const destination = settingsSections[area].find(
    (section) => section.id === sectionId,
  );
  for (const section of Object.values(settingsSections).flat()) {
    const index = section.fields.findIndex((field) => field.id === id);
    if (index >= 0) {
      destination.fields.unshift(section.fields.splice(index, 1)[0]);
      return;
    }
  }
}
moveField("thumbnailSize", "editing", "image-thumbnails");
moveField("advancedProgressiveJpeg", "editing", "previews");
moveField("advancedFullsizeImages", "editing", "image-fullsize");

const findSection = (area, id) =>
  settingsSections[area].find((section) => section.id === id);
findSection("editing", "previews").title = "Image previews";
findSection("editing", "previews").page = "Images";
findSection("editing", "advanced-image-output").fields.push(
  toggle(
    "imageEnhancedRaw",
    "Better RAW previews",
    true,
    "Uses the camera's preview first, and processes tricky RAW files when needed.",
  ),
);
findSection("libraries", "sources").fields.push(
  toggle(
    "libraryScheduledScan",
    "Enable scheduled scans",
    true,
    "Look for changes on a schedule.",
  ),
  text(
    "libraryScanCron",
    "Custom scan schedule",
    "0 0 * * *",
    "A cron expression in the server's time zone, such as 0 3 * * * for 3 am.",
  ),
);
findSection("backup", "database-backup").fields.push(
  text(
    "backupCron",
    "Custom backup schedule",
    "0 2 * * *",
    "A cron expression in the server's time zone, such as 0 3 * * * for 3 am.",
  ),
);

// All configurable queue concurrency is one draft, including controls surfaced
// by the queue manager. Four non-configurable queue families remain fixed at 1.
const queues = findSection("processing", "queues");
queues.title = "Job manager";
queues.fields = queues.fields.filter(
  (field) => !["mlJobs", "importJobs"].includes(field.id),
);
for (const [id, label, value] of [
  ["metadataExtraction", "Reading photo details", 5],
  ["faceDetection", "Finding faces", 2],
  ["smartSearch", "Preparing photos for search", 2],
  ["videoDuplicateDetection", "Finding duplicate videos", 1],
  ["backgroundTask", "Background tasks", 5],
  ["migration", "Moving files", 5],
  ["search", "Updating search", 5],
  ["sidecar", "Photo detail files", 5],
  ["library", "Library scans", 5],
  ["notifications", "Sending notifications", 5],
  ["ocr", "Reading text in photos", 1],
  ["imageEnrichment", "Search and recognition", 2],
  ["imageDescription", "Writing captions", 2],
  ["nsfwDetection", "Suggesting private photos", 2],
  ["mediaHealth", "Health checks", 2],
  ["workflow", "Workflows", 5],
  ["editor", "Saving edits", 2],
  ["integrityCheck", "Checking for damaged files", 1],
])
  queues.fields.push(
    number(
      `queueConcurrency_${id}`,
      label,
      value,
      "jobs",
      1,
      1000,
      "How many run at once; more is faster but can slow browsing.",
    ),
  );

findSection("processing", "advanced-ml-endpoints").credentials = [
  {
    id: "huggingface-token",
    label: "Hugging Face token",
    help: "Allow workers to load models requiring authentication.",
  },
];
findSection("processing", "advanced-video-profile").credentials = [
  {
    id: "video-worker-token",
    label: "Video worker token",
    help: "Authenticate with the persistent video worker.",
  },
];

const resourceSections = new Set([
  "migration",
  "takeout",
  "preservation",
  "spaces",
  "partner",
  "shared-identities",
  "repair",
  "workers",
  "sources",
  "accounts",
  "credentials",
  "advanced-icloud",
  "advanced-video-profile",
  "advanced-dedup-owner",
  "advanced-protected-suppression",
  "advanced-sharing-boundaries",
]);
for (const [area, sections] of Object.entries(settingsSections)) {
  for (const section of sections) {
    section.scope ??=
      area === "preferences"
        ? "account"
        : resourceSections.has(section.id)
          ? "resource"
          : "server";
    if (["appearance", "device-playback"].includes(section.id))
      section.scope = "device";
    if (
      [
        "sources",
        "accounts",
        "advanced-protected-suppression",
        "advanced-video-profile",
      ].includes(section.id)
    )
      section.scope = "mixed";
  }
}

// Protection guarantees and deployment policy are inspectable, never toggled off.
const protectedFields = new Set([
  "dedupVerify",
  "durableVerdicts",
  "petReview",
  "manualMetadata",
  "exportChecksums",
  "groupReview",
]);
const policyOverrides = {
  notifyUpdates: {
    label: "Update notifications",
    value: false,
    help: "Let me know when a new Frameleaf release is available.",
  },
  videoDescriptions: {
    value: false,
    help: "Adds captions to key moments in videos; check a few videos first.",
  },
  videoInterval: {
    label: "Frames looked at per video",
    value: 6,
    unit: "frames",
    min: 6,
    max: 6,
    locked: true,
    policy: "Current sampling policy",
    help: "More frames catch more moments but take longer.",
  },
  masterResolution: {
    value: "Preserve source",
    options: ["Preserve source"],
    locked: true,
    policy: "Original-quality guarantee",
  },
  masterColor: {
    value: "Preserve source color",
    options: ["Preserve source color"],
    locked: true,
    policy: "Original-quality guarantee",
  },
  masterAudio: {
    value: "Preserve channels & timing",
    options: ["Preserve channels & timing"],
    locked: true,
    policy: "Original-quality guarantee",
  },
  interpolation: {
    value: false,
    locked: true,
    policy: "Not yet qualified",
    help: "Adds in-between frames for smoother video; offered as its own step with a preview.",
  },
  modelTtl: {
    locked: true,
    policy: "Worker environment",
    help: "Unused AI models leave memory after this long; the next job starts a little slower.",
  },
  faceDistance: { max: 2 },
  sensitiveThreshold: { min: 0.01 },
  localUnavailable: {
    help: "Wait until it's back, or stop and tell you; work never moves to the cloud on its own.",
  },
  destination: {
    help: "Each job still asks before using Frameleaf Cloud, and needs a linked account.",
  },
  shareLocation: {
    help: "Shows where photos were taken; downloaded originals may still contain the location.",
  },
  locationPrivacy: {
    help: "Hides where photos were taken on public links; downloaded originals may still include it.",
  },
};
// Preserve full source choices and validation, while retaining stable UI IDs.
const sourceControlOverrides = {
  defaultQuota: { unit: "GiB" },
  backupSchedule: {
    options: [
      "Daily at midnight",
      "Daily at 02:00",
      "Daily at 13:00",
      "Every 6 hours",
      "Daily at 04:00",
      "Weekly on Sunday",
      "Custom",
    ],
  },
  advancedSuppressionScope: {
    locked: true,
    policy: "Managed with Locked rules",
    help: "Just your photos, or every photo you can see.",
  },
  albumSort: {
    value: "desc",
    options: [
      { value: "desc", label: "Newest first" },
      { value: "asc", label: "Oldest first" },
    ],
  },
  thumbnailSize: {
    type: "select",
    value: 250,
    options: [200, 250, 480, 720, 1080].map((value) => ({
      value,
      label: `${value}px`,
    })),
  },
  previewSize: {
    type: "select",
    value: 1440,
    options: [720, 1080, 1440, 2160].map((value) => ({
      value,
      label: `${value}px`,
    })),
  },
  previewFormat: {
    value: "webp",
    options: [
      { value: "jpeg", label: "JPEG" },
      { value: "webp", label: "WebP" },
    ],
  },
  previewQuality: { min: 1, max: 100, integer: true },
  advancedProgressiveJpeg: { value: false },
  playbackResolution: {
    value: "1080",
    options: [
      { value: "2160", label: "4K" },
      { value: "1440", label: "1440p" },
      { value: "1080", label: "1080p" },
      { value: "720", label: "720p" },
      { value: "480", label: "480p" },
      { value: "original", label: "Original" },
    ],
  },
  transcodePolicy: {
    value: "required",
    options: [
      { value: "all", label: "All videos" },
      { value: "optimal", label: "Optimize compatibility" },
      { value: "bitrate", label: "Excessive bitrate" },
      { value: "required", label: "Only when required" },
      { value: "disabled", label: "Disabled" },
    ],
  },
  playbackCodec: {
    value: "h264",
    options: [
      { value: "h264", label: "H.264" },
      { value: "hevc", label: "HEVC" },
      { value: "vp9", label: "VP9" },
      { value: "av1", label: "AV1" },
    ],
  },
  audioCodec: {
    value: "aac",
    options: [
      { value: "aac", label: "AAC" },
      { value: "mp3", label: "MP3" },
      { value: "libopus", label: "Opus (libopus)" },
      { value: "opus", label: "Opus" },
      { value: "pcm_s16le", label: "PCM 16-bit" },
    ],
  },
  acceleration: {
    value: "disabled",
    options: [
      { value: "disabled", label: "Software" },
      { value: "nvenc", label: "NVIDIA NVENC" },
      { value: "qsv", label: "Intel Quick Sync" },
      { value: "vaapi", label: "VAAPI" },
      { value: "rkmpp", label: "Rockchip MPP" },
    ],
  },
  playbackPreset: {
    type: "select",
    value: "medium",
    options: [
      "ultrafast",
      "superfast",
      "veryfast",
      "faster",
      "fast",
      "medium",
      "slow",
      "slower",
      "veryslow",
    ],
  },
  descriptionModel: { type: "text", value: "Qwen/Qwen2.5-VL-3B-Instruct" },
  clipModel: { type: "text" },
  logLevel: {
    value: "log",
    options: [
      { value: "fatal", label: "Fatal" },
      { value: "error", label: "Error" },
      { value: "warn", label: "Warning" },
      { value: "log", label: "Info" },
      { value: "debug", label: "Debug" },
      { value: "verbose", label: "Verbose" },
    ],
  },
  smtpSecurity: {
    type: "toggle",
    value: false,
    label: "Encrypt from the start",
    help: "Turn on if your provider says to use port 465 or TLS.",
  },
  smtpPort: { min: 0, max: 65535 },
  trashDays: { min: 0 },
  thumbnailJobs: { min: 1, max: 1000, integer: true },
  videoJobs: { min: 1, max: 1000, integer: true },
  advancedDescriptionInstructions: { maxLength: 2000 },
  advancedMlUrls: { list: { type: "url", minItems: 1 } },
  advancedAcceptedVideo: {
    list: { type: "text", values: ["h264", "hevc", "vp9", "av1"] },
  },
  advancedAcceptedAudio: {
    list: {
      type: "text",
      values: ["mp3", "aac", "libopus", "opus", "pcm_s16le"],
    },
  },
  advancedAcceptedContainers: {
    list: { type: "text", values: ["mov", "mp4", "webm"] },
  },
  advancedHlsCodecs: {
    list: { type: "text", values: ["h264", "hevc", "vp9", "av1"] },
  },
  advancedHlsResolutions: {
    list: { type: "number", values: [480, 720, 1080, 1440, 2160] },
  },
};
// Upgrade old display-label values without silently changing a saved choice.
const legacyValues = {
  albumSort: { "Newest first": "desc", "Oldest first": "asc" },
  previewFormat: { JPEG: "jpeg", WebP: "webp" },
  playbackResolution: {
    "4K": "2160",
    "2160p": "2160",
    "1440p": "1440",
    "1080p": "1080",
    "720p": "720",
    "480p": "480",
    Original: "original",
  },
  transcodePolicy: {
    "When required": "required",
    "All videos": "all",
    Disabled: "disabled",
  },
  playbackCodec: { "H.264": "h264", HEVC: "hevc", VP9: "vp9", AV1: "av1" },
  audioCodec: {
    AAC: "aac",
    MP3: "mp3",
    Opus: "opus",
    "PCM 16-bit": "pcm_s16le",
  },
  playbackPreset: {
    Ultrafast: "ultrafast",
    Fast: "fast",
    Medium: "medium",
    Slow: "slow",
  },
  logLevel: {
    Fatal: "fatal",
    Error: "error",
    Warning: "warn",
    Info: "log",
    Debug: "debug",
    Verbose: "verbose",
  },
  smtpSecurity: { STARTTLS: false, TLS: true, None: false },
  acceleration: {
    "Auto when qualified": "disabled",
    Software: "disabled",
    "NVIDIA NVENC": "nvenc",
    "Intel Quick Sync": "qsv",
    VAAPI: "vaapi",
    "Rockchip MPP": "rkmpp",
  },
};
for (const section of Object.values(settingsSections).flat()) {
  for (const field of section.fields) {
    if (protectedFields.has(field.id))
      Object.assign(field, { locked: true, policy: "Always protected" });
    Object.assign(field, policyOverrides[field.id]);
    Object.assign(field, sourceControlOverrides[field.id]);
    if (legacyValues[field.id]) field.legacyValues = legacyValues[field.id];
  }
}

/**
 * Directory icons for every settings section (mdi names from @mdi/js),
 * distinct within each area. Sections that set their own icon keep it.
 */
export const sectionIcons = Object.freeze({
  storage: {
    volumes: "mdiHarddisk",
    organization: "mdiFolderMultipleOutline",
    deduplication: "mdiContentDuplicate",
    retention: "mdiDeleteClockOutline",
    migration: "mdiFolderMoveOutline",
    "advanced-dedup-owner": "mdiAccountKeyOutline",
    "retention-policy": "mdiTimerSandComplete",
  },
  backup: {
    takeout: "mdiImport",
    "database-backup": "mdiDatabaseExportOutline",
    preservation: "mdiShieldStarOutline",
    "devices-backup": "mdiCellphoneArrowDown",
    "advanced-icloud": "mdiApple",
  },
  intelligence: {
    "smart-search": "mdiImageSearchOutline",
    descriptions: "mdiTextBoxOutline",
    faces: "mdiFaceRecognition",
    pets: "mdiPawOutline",
    documents: "mdiReceiptTextOutline",
    classification: "mdiShapeOutline",
    "sensitive-detection": "mdiEyeOffOutline",
    "advanced-search-labels": "mdiTagSearchOutline",
    "advanced-description-runtime": "mdiRobotOutline",
    "advanced-description-prompt": "mdiCommentTextOutline",
    "advanced-description-identity": "mdiCardAccountDetailsOutline",
    "advanced-recognition-models": "mdiTextRecognition",
    "advanced-travel-album": "mdiAirplane",
    "smart-album-documents": "mdiFileDocumentOutline",
    "smart-album-food": "mdiFoodForkDrink",
    "smart-album-nature": "mdiPineTree",
    "smart-album-pets": "mdiDog",
    "smart-album-screenshots": "mdiCellphoneScreenshot",
  },
  editing: {
    previews: "mdiImageOutline",
    playback: "mdiPlayCircleOutline",
    masters: "mdiImageEditOutline",
    restoration: "mdiAutoFix",
    studio: "mdiMovieEditOutline",
    "advanced-image-output": "mdiPaletteOutline",
    "advanced-playback-compatibility": "mdiVideoOutline",
    "advanced-hls": "mdiSignalVariant",
    "image-thumbnails": "mdiViewGridOutline",
    "image-fullsize": "mdiFullscreen",
    "video-encoder-tuning": "mdiTuneVertical",
  },
  sharing: {
    spaces: "mdiAccountGroupOutline",
    links: "mdiLinkVariant",
    partner: "mdiAccountHeartOutline",
    "shared-identities": "mdiAccountSwitchOutline",
    "advanced-sharing-boundaries": "mdiShieldLockOutline",
  },
  care: {
    health: "mdiHeartPulse",
    repair: "mdiHammerWrench",
    "enrichment-care": "mdiProgressCheck",
    "advanced-duplicate-matching": "mdiImageMultipleOutline",
    "advanced-integrity-budget": "mdiSpeedometer",
    "integrity-schedules": "mdiCalendarClock",
  },
  processing: {
    workers: "mdiServerNetwork",
    hardware: "mdiExpansionCard",
    routing: "mdiTransitConnectionVariant",
    queues: "mdiTrayFull",
    schedules: "mdiWeatherNight",
    "advanced-ml-endpoints": "mdiApi",
    "advanced-video-profile": "mdiVideoOutline",
    "nightly-tasks": "mdiBroom",
  },
  security: {
    signin: "mdiLoginVariant",
    privacy: "mdiLockOutline",
    credentials: "mdiKeyOutline",
    "advanced-protected-suppression": "mdiEyeLockOutline",
    "advanced-native-oauth": "mdiCellphoneKey",
    "oauth-advanced": "mdiShieldKeyOutline",
  },
  notifications: {
    signals: "mdiBellBadgeOutline",
    email: "mdiEmailOutline",
    templates: "mdiFileDocumentEditOutline",
    "advanced-mail-reply": "mdiEmailArrowLeftOutline",
    "email-delivery-advanced": "mdiEmailFastOutline",
    "email-templates": "mdiEmailEditOutline",
  },
  server: {
    identity: "mdiServer",
    updates: "mdiUpdate",
    diagnostics: "mdiBugOutline",
    maps: "mdiMapOutline",
    branding: "mdiPaletteSwatchOutline",
    "advanced-metadata-maps": "mdiMapMarkerMultipleOutline",
    "instance-options": "mdiCogOutline",
    configuration: "mdiFileSwapOutline",
  },
  preferences: {
    profile: "mdiAccountCircleOutline",
    appearance: "mdiPaletteOutline",
    rediscovery: "mdiStarShootingOutline",
    downloads: "mdiDownloadOutline",
    suppression: "mdiEyeOffOutline",
    "advanced-download-packaging": "mdiPackageVariant",
    "device-playback": "mdiMonitor",
    "library-features": "mdiViewDashboardOutline",
    "email-preferences": "mdiEmailOutline",
    "supporter-preference": "mdiHandHeartOutline",
    "account-security": "mdiShieldAccountOutline",
  },
  users: {
    accounts: "mdiAccountMultipleOutline",
  },
  libraries: {
    sources: "mdiFolderNetworkOutline",
  },
  trash: {
    contents: "mdiDeleteOutline",
  },
});
for (const [area, sections] of Object.entries(settingsSections))
  for (const section of sections) {
    section.icon ??= sectionIcons[area]?.[section.id];
    const aliases = settingsSearchAliases[`${area}/${section.id}`];
    if (aliases) section.keywords = [section.keywords, aliases].filter(Boolean).join(" ");
  }

export const allSettings = Object.entries(settingsSections).flatMap(
  ([area, sections]) =>
    sections.flatMap((section) =>
      section.fields.map((field) => ({
        ...field,
        area,
        section: section.id,
        sectionTitle: section.title,
      })),
    ),
);
export const defaultSettings = Object.fromEntries(
  allSettings.map((field) => [field.id, field.value]),
);
export const settingsIndex = settingsAreas
  .filter((area) => settingsSections[area.id])
  .flatMap((area) =>
    settingsSections[area.id].map((section) => ({
      area: area.id,
      areaTitle: area.title,
      section: section.id,
      title: section.title,
      description: section.description,
      search:
        `${area.title} ${section.title} ${section.description} ${section.keywords || ""} ${section.fields.map((f) => `${f.label} ${f.help}`).join(" ")}`.toLowerCase(),
    })),
  );
export function findSettings(query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return settingsIndex.filter((entry) =>
    words.every((word) => entry.search.includes(word)),
  );
}
export function validateSetting(field, value) {
  if (field.type === "toggle")
    return typeof value === "boolean" ? "" : "Choose on or off.";
  if (field.type === "number") {
    const numeric =
      typeof value === "number" ||
      (typeof value === "string" &&
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()));
    return numeric &&
      Number.isFinite(Number(value)) &&
      Number(value) >= field.min &&
      Number(value) <= field.max &&
      (!field.integer || Number.isInteger(Number(value)))
      ? ""
      : `Enter a value from ${field.min} to ${field.max}.`;
  }
  if (field.type === "select")
    return field.options.some((option) => (option.value ?? option) === value)
      ? ""
      : "Choose an available option.";
  if (typeof value !== "string") return "Enter text.";
  if (field.maxLength && value.length > field.maxLength)
    return `Use no more than ${field.maxLength} characters.`;
  if (field.list) {
    const entries = value
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length < (field.list.minItems ?? 0))
      return "Enter at least one item.";
    if (
      field.list.values &&
      entries.some(
        (entry) =>
          !field.list.values.includes(
            field.list.type === "number" ? Number(entry) : entry,
          ),
      )
    )
      return "Choose supported values, one per line.";
    if (field.list.type === "url") {
      for (const entry of entries) {
        try {
          const url = new URL(entry);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password
          )
            return "Use HTTP or HTTPS URLs without credentials, one per line.";
        } catch {
          return "Enter valid URLs, one per line.";
        }
      }
    }
  }
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    return "Enter a valid email address.";
  if (field.type === "url" && value) {
    try {
      if (!["http:", "https:"].includes(new URL(value).protocol))
        return "Use an HTTP or HTTPS URL.";
    } catch {
      return "Enter a valid URL.";
    }
  }
  return "";
}

export function getSettingAvailability(field, values) {
  const id = typeof field === "string" ? field : field.id;
  const requires = {
    imageFullsizeFormat: "advancedFullsizeImages",
    imageFullsizeQuality: "advancedFullsizeImages",
    imageFullsizeProgressive: "advancedFullsizeImages",
    foldersSidebar: "foldersEnabled",
    memoriesSidebar: "memories",
    peopleSidebar: "peopleEnabled",
    peopleMinimumFaces: "peopleEnabled",
    sharedLinksSidebar: "sharedLinksEnabled",
    tagsSidebar: "tagsEnabled",
    personalAlbumInviteEmail: "personalEmailEnabled",
    personalAlbumUpdateEmail: "personalEmailEnabled",
    advancedHlsCodecs: "advancedHlsEnabled",
    advancedHlsResolutions: "advancedHlsEnabled",
  };
  if (requires[id] && !values[requires[id]])
    return { disabled: true, reason: "Enable the related feature first." };
  const format = {
    imageThumbnailProgressive: "imageThumbnailFormat",
    advancedProgressiveJpeg: "previewFormat",
    imageFullsizeProgressive: "imageFullsizeFormat",
  }[id];
  if (format && String(values[format]).toLowerCase() !== "jpeg")
    return {
      disabled: true,
      reason: "Thumbnails sharpen as they load; JPEG only.",
    };
  return { disabled: false, reason: "" };
}

export function normalizeSettingChange(values, id, value) {
  const field = allSettings.find((field) => field.id === id);
  if (field?.type === "select") {
    const option = field.options.find(
      (option) => String(option.value ?? option) === String(value),
    );
    if (option !== undefined) value = option.value ?? option;
  }
  const next = { ...values, [id]: value };
  const backupPresets = {
    "Daily at midnight": "0 0 * * *",
    "Daily at 02:00": "0 2 * * *",
    "Daily at 13:00": "0 13 * * *",
    "Every 6 hours": "0 */6 * * *",
    "Daily at 04:00": "0 4 * * *",
    "Weekly on Sunday": "0 2 * * 0",
  };
  if (id === "backupSchedule" && backupPresets[value])
    next.backupCron = backupPresets[value];
  if (id === "backupCron")
    next.backupSchedule =
      Object.entries(backupPresets).find(
        ([, cron]) =>
          cron ===
          String(value)
            .trim()
            .replace(/\s+/g, " ")
            .replace(/\b0(\d)\b/g, "$1"),
      )?.[0] ?? "Custom";
  const progressive = {
    imageThumbnailFormat: "imageThumbnailProgressive",
    previewFormat: "advancedProgressiveJpeg",
    imageFullsizeFormat: "imageFullsizeProgressive",
  }[id];
  if (progressive && String(value).toLowerCase() === "webp")
    next[progressive] = false;
  if (id === "personalEmailEnabled" && value === false) {
    next.personalAlbumInviteEmail = false;
    next.personalAlbumUpdateEmail = false;
  }
  const accepted = {
    playbackCodec: "advancedAcceptedVideo",
    audioCodec: "advancedAcceptedAudio",
  }[id];
  if (accepted) {
    const entries = String(values[accepted] ?? "")
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!entries.includes(value))
      next[accepted] = [...entries, value].join("\n");
  }
  return next;
}

export function validateSettingsDraft(values) {
  const errors = {};
  for (const field of allSettings) {
    const error = validateSetting(field, values[field.id]);
    if (!field.locked && error) errors[field.id] = error;
  }
  if (
    Number(values.advancedVideoMatchingFrames) >
    Number(values.advancedVideoDuplicateFrames)
  )
    errors.advancedVideoMatchingFrames =
      "Matching frames cannot exceed sampled frames.";
  if (
    values.advancedDescriptionRawEnabled &&
    values.advancedDescriptionPlaceholders === "strict" &&
    !String(values.advancedDescriptionRawTemplate).includes("{schema}")
  )
    errors.advancedDescriptionRawTemplate = "Include the {schema} placeholder.";
  for (const [id, format] of [
    ["imageThumbnailProgressive", "imageThumbnailFormat"],
    ["advancedProgressiveJpeg", "previewFormat"],
    ["imageFullsizeProgressive", "imageFullsizeFormat"],
  ]) {
    if (values[id] && String(values[format]).toLowerCase() === "webp")
      errors[id] = "Thumbnails sharpen as they load; JPEG only.";
  }
  return errors;
}
export function settingsDiff(saved, draft) {
  return allSettings
    .filter(
      (field) =>
        !field.locked &&
        saved[field.id] !== draft[field.id] &&
        !(
          field.type === "number" &&
          !validateSetting(field, draft[field.id]) &&
          Number(saved[field.id]) === Number(draft[field.id])
        ),
    )
    .map((field) => ({
      ...field,
      before: saved[field.id],
      after: draft[field.id],
    }));
}
export function displaySetting(value, field) {
  if (typeof value === "boolean") return value ? "On" : "Off";
  const option = field?.options?.find((item) => item.value === value);
  return (
    `${option?.label ?? value}${field?.unit ? ` ${field.unit}` : ""}` ||
    "Not set"
  );
}
