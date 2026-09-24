// Prototype configuration, not deployed server defaults or a production API schema.
import { settingsExtensions } from "./settings-advanced.mjs";
import { utilityTools } from "./utilities-data.mjs";

const toggle = (id, label, value, help, impact = "New operations") => ({
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
  impact = "New operations",
) => ({ id, label, value, options, help, impact, type: "select" });
const number = (
  id,
  label,
  value,
  unit,
  min,
  max,
  help,
  impact = "New operations",
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
  impact = "New operations",
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
    description: "Status, storage and what needs attention.",
  },
  {
    id: "analytics",
    title: "Library analytics",
    icon: "mdiChartTimelineVariant",
    group: "Command center",
    description: "Growth, storage and activity across accounts and libraries.",
  },
  {
    id: "storage",
    title: "Storage & originals",
    icon: "mdiHarddisk",
    group: "Your library",
    description: "Volumes, folder layout, retention and originals.",
  },
  {
    id: "backup",
    title: "Import & protection",
    icon: "mdiBackupRestore",
    group: "Your library",
    description: "Imports, database backups and preservation exports.",
  },
  {
    id: "intelligence",
    title: "Search & intelligence",
    icon: "mdiImageSearchOutline",
    group: "Your library",
    description: "Search, descriptions, recognition and smart albums.",
  },
  {
    id: "editing",
    title: "Editing & playback",
    icon: "mdiMovieOpenOutline",
    group: "Your library",
    description:
      "Image output, video playback and editing masters.",
  },
  {
    id: "sharing",
    title: "People & sharing",
    icon: "mdiAccountMultipleOutline",
    group: "Your library",
    description: "Partners, Spaces, public links and sharing boundaries.",
  },
  {
    id: "care",
    title: "Library care",
    icon: "mdiShieldCheckOutline",
    group: "Your library",
    description: "Health checks, repairs and duplicate handling.",
  },
  {
    id: "processing",
    title: "Compute & jobs",
    icon: "mdiDesktopTowerMonitor",
    group: "Your server",
    description:
      "Workers, queues, schedules and cloud processing.",
  },
  {
    id: "security",
    title: "Access & security",
    icon: "mdiShieldLockOutline",
    group: "Your server",
    description: "Sign-in methods, locked content, devices and API access.",
  },
  {
    id: "notifications",
    title: "Notifications",
    icon: "mdiBellOutline",
    group: "Your server",
    description: "Alerts, email delivery and message templates.",
  },
  {
    id: "server",
    title: "Server & updates",
    icon: "mdiServerOutline",
    group: "Your server",
    description: "Server name, updates, logs, maps and branding.",
  },
  {
    id: "maintenance",
    title: "Maintenance",
    icon: "mdiWrenchOutline",
    group: "Your server",
    description: "Maintenance mode, database backups and integrity checks.",
  },
  {
    id: "preferences",
    title: "Your preferences",
    icon: "mdiAccountOutline",
    group: "Personal",
    description: "Appearance, layout, playback and account access.",
  },
  {
    id: "users",
    title: "Users",
    icon: "mdiAccountMultipleOutline",
    group: "Your server",
    description: "Manage accounts, roles, quotas, and access.",
  },
  {
    id: "libraries",
    title: "Libraries",
    icon: "mdiFolderOutline",
    group: "Your library",
    description: "Manage library ownership, folders, exclusions, and scans.",
  },
  {
    id: "utilities",
    title: "Utilities",
    icon: "mdiTools",
    group: "Your library",
    description: "Import, review, repair, and organize your collection.",
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
    description: "Every settings change saved on this device, with time and values.",
  },
];

export const settingsSections = {
  storage: [
    section(
      "volumes",
      "Library storage",
      "See how much space your library uses and where it lives.",
      [
        text(
          "libraryLabel",
          "Storage label",
          "Photo archive",
          "A friendly name for this library volume.",
          "Display only",
        ),
        number(
          "capacityAlert",
          "Warn when disk usage reaches",
          85,
          "%",
          50,
          99,
          "Capacity includes non-Frameleaf files on the same filesystem.",
        ),
      ],
      { panel: "volumes" },
    ),
    section(
      "organization",
      "Originals & folder structure",
      "Choose how originals are named and arranged on disk.",
      [
        toggle(
          "storageTemplate",
          "Organize uploads with a storage template",
          false,
          "Existing originals only move after a separately reviewed migration.",
          "New uploads; migration separate",
        ),
        text(
          "template",
          "Folder template",
          "{{y}}/{{MM}}/{{filename}}",
          "Preview the new path before applying a storage migration.",
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
          "Keep RAW provenance, sidecars, and paired previews together.",
        ),
      ],
    ),
    section(
      "deduplication",
      "Physical deduplication",
      "Keep one copy of identical files while each person keeps their own library.",
      [
        toggle(
          "physicalDedup",
          "Reuse identical original files",
          true,
          "Content checksums identify exact matches; visual similarity alone is insufficient.",
          "New uploads",
        ),
        toggle(
          "dedupVerify",
          "Verify references before cleanup",
          true,
          "The last valid owner or reference must never lose its original.",
        ),
      ],
    ),
    section(
      "retention",
      "Trash & retention",
      "How long deleted items stay recoverable.",
      [
        number(
          "trashDays",
          "Keep trashed assets for",
          30,
          "days",
          1,
          365,
          "A shorter period can make existing trashed assets eligible for removal.",
          "Existing trash eligibility",
        ),
        number(
          "deleteDelay",
          "Deleted-account recovery window",
          7,
          "days",
          1,
          365,
          "Applies to pending account deletion.",
          "Existing account deletions",
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
      "Folders on disk that Frameleaf watches and imports.",
      [
        toggle(
          "libraryWatch",
          "Watch for filesystem changes",
          false,
          "Network mounts may require scheduled scanning instead.",
        ),
        select(
          "libraryScan",
          "Rescan external libraries",
          "Every night",
          ["Every night", "Weekly", "Manually"],
          "Rescanning discovers changes; it does not create a backup.",
        ),
        text(
          "exclusions",
          "Excluded file patterns",
          "**/.DS_Store, **/@eaDir/**",
          "Comma-separated patterns; review matches before a real scan.",
        ),
      ],
      { panel: "libraries" },
    ),
    section(
      "takeout",
      "Google Photos & server imports",
      "Bring in a Google Photos export or another server, review it, then import.",
      [
        toggle(
          "takeoutAlbums",
          "Recreate album memberships",
          true,
          "Matching an existing original must still restore its memberships.",
        ),
        toggle(
          "sidecarReview",
          "Review ambiguous sidecars",
          true,
          "Keep localized names, split archives, and Live Photo pairing inspectable.",
        ),
      ],
      { action: "Preview import workflow", actionKind: "import" },
    ),
    section(
      "database-backup",
      "Database backups",
      "Back up albums, people and edits. Originals need their own backup.",
      [
        toggle(
          "databaseBackup",
          "Schedule database backups",
          true,
          "The destination must be monitored independently of the library disk.",
        ),
        select(
          "backupSchedule",
          "Backup schedule",
          "Daily at 02:00",
          ["Daily at 02:00", "Daily at 04:00", "Weekly on Sunday"],
          "Schedule uses the server timezone.",
        ),
        number(
          "backupRetention",
          "Keep recent database backups",
          14,
          "copies",
          1,
          90,
          "Retention applies after successful backup creation.",
        ),
      ],
      { action: "Review recovery readiness", actionKind: "recovery" },
    ),
    section(
      "preservation",
      "Originals & preservation",
      "Export originals with their albums, edits and history kept together.",
      [
        toggle(
          "exportSidecars",
          "Include metadata and edit recipes",
          true,
          "Generated descriptions remain distinguishable from manual metadata.",
        ),
        toggle(
          "exportChecksums",
          "Include checksums and a manifest",
          true,
          "Verify the exported files and rehearse a restore.",
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
          "Show duplicate-uploader guidance",
          true,
          "Help migrating users avoid running both Immich and Frameleaf backup clients.",
        ),
      ],
      { panel: "devices" },
    ),
  ],
  intelligence: [
    section(
      "smart-search",
      "Visual search",
      "Find images by meaning, with explicit text, OCR, and filename search alongside it.",
      [
        toggle(
          "smartSearch",
          "Enable semantic search",
          true,
          "Model changes require rebuilding the affected embeddings.",
          "Reindex required",
        ),
        text(
          "clipModel",
          "Embedding model",
          "ViT-B-32__openai",
          "Preview search results before scheduling a library-wide rebuild.",
          "Reindex required",
        ),
      ],
    ),
    section(
      "descriptions",
      "Descriptions & tags",
      "Automatic descriptions and tags that make photos easier to find.",
      [
        toggle(
          "descriptions",
          "Generate image descriptions",
          true,
          "Preserve manual metadata during reprocessing.",
        ),
        text(
          "descriptionModel",
          "Description model",
          "Configured endpoint model",
          "Available models depend on the selected endpoint.",
        ),
        text(
          "descriptionPrompt",
          "Image description prompt",
          "Describe the visible scene, people, activity, and meaningful details. Use confirmed names only.",
          "Preview a description before reprocessing existing ones.",
          "Regeneration optional",
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
      "Recognize faces. Your own corrections always win.",
      [
        toggle(
          "faceRecognition",
          "Detect and group faces",
          true,
          "Group matching faces while preserving names and manual corrections.",
        ),
        number(
          "faceDistance",
          "Maximum recognition distance",
          0.5,
          "",
          0.1,
          1,
          "Lower values are stricter; review near misses before changing an entire library.",
          "Reprocess affected faces",
        ),
        toggle(
          "durableVerdicts",
          "Preserve manual face verdicts",
          true,
          "Same person / Different person decisions survive reprocessing.",
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
          "Enable only after a compatible recognition model is qualified.",
        ),
        toggle(
          "petReview",
          "Review uncertain rematches",
          true,
          "Never silently discard a named pet after a model update.",
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
          "Extract text from photos",
          true,
          "OCR is independent from generated descriptions.",
        ),
        number(
          "ocrConfidence",
          "Minimum OCR confidence",
          0.7,
          "",
          0,
          1,
          "Lower confidence may help faded documents but adds noise.",
        ),
        toggle(
          "documentFields",
          "Suggest receipt and document fields",
          false,
          "Inferred values stay editable and linked to image evidence.",
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
          "Build curated smart albums",
          true,
          "Includes Pets, Documents & Receipts, Best Photos, and saved structured queries.",
        ),
        toggle(
          "classification",
          "Suggest custom visual categories",
          true,
          "Preview matches and adjust thresholds before enabling actions.",
        ),
        select(
          "classificationAction",
          "Default rule action",
          "Suggest for review",
          ["Suggest for review", "Add rule-owned tags"],
          "Automatic archiving must be an explicitly selected rule action.",
        ),
        toggle(
          "bestPhotos",
          "Score best photos & video frames",
          true,
          "Use scoring to assist culling, covers, and memories.",
        ),
      ],
    ),
    section(
      "sensitive-detection",
      "Locked-content detection",
      "Spot photos that may belong in Locked.",
      [
        toggle(
          "sensitiveDetect",
          "Detect content to keep Locked",
          true,
          "Access behavior is configured under Access & security.",
        ),
        number(
          "sensitiveThreshold",
          "Detection threshold",
          0.8,
          "",
          0,
          1,
          "Review uncertain results before a full-library run.",
        ),
      ],
    ),
  ],
  editing: [
    section(
      "previews",
      "Photo previews",
      "Smaller copies that keep browsing fast.",
      [
        number(
          "thumbnailSize",
          "Thumbnail resolution",
          250,
          "px",
          100,
          1000,
          "A new setting applies when thumbnails are regenerated.",
        ),
        number(
          "previewSize",
          "Photo preview resolution",
          1440,
          "px",
          720,
          4096,
          "Originals are untouched.",
        ),
        select(
          "previewFormat",
          "Preview format",
          "WebP",
          ["WebP", "JPEG"],
          "Choose compatibility and storage size for derived previews.",
        ),
        number(
          "previewQuality",
          "Preview quality",
          80,
          "%",
          1,
          100,
          "Higher quality creates larger previews.",
        ),
      ],
    ),
    section(
      "playback",
      "Video playback proxies",
      "Copies that play smoothly on every device.",
      [
        select(
          "transcodePolicy",
          "Create playback copies",
          "When required",
          [
            "When required",
            "Above target resolution",
            "All videos",
            "Disabled",
          ],
          "The source remains available.",
        ),
        select(
          "playbackResolution",
          "Playback resolution limit",
          "1080p",
          ["720p", "1080p", "1440p", "2160p"],
          "Only playback proxies inherit this limit.",
        ),
        select(
          "playbackCodec",
          "Playback video codec",
          "H.264",
          ["H.264", "HEVC", "VP9", "AV1"],
          "Check browser and worker codec compatibility.",
        ),
        number(
          "playbackCrf",
          "Constant quality (CRF)",
          23,
          "",
          0,
          51,
          "Lower values increase quality and file size.",
        ),
        select(
          "playbackPreset",
          "Encoder speed",
          "Medium",
          ["Fast", "Medium", "Slow"],
          "Slower encoding can improve compression efficiency.",
        ),
        select(
          "acceleration",
          "Hardware acceleration",
          "Auto when qualified",
          ["Auto when qualified", "Software", "NVENC", "QSV", "VAAPI"],
          "An unsupported accelerator needs an actionable failure state.",
        ),
        select(
          "audioCodec",
          "Proxy audio codec",
          "AAC",
          ["AAC", "Opus", "MP3"],
          "Master audio policy is separate.",
        ),
      ],
    ),
    section(
      "masters",
      "Edited masters",
      "How edited photos and videos are saved.",
      [
        select(
          "masterResolution",
          "Resolution",
          "Preserve source",
          ["Preserve source", "Explicit export dimensions"],
          "Rotation must preserve source dimensions after orientation changes.",
        ),
        select(
          "masterColor",
          "Color handling",
          "Preserve source color",
          ["Preserve source color", "Explicit SDR derivative"],
          "Unsupported HDR combinations must be rejected before rendering.",
        ),
        select(
          "masterAudio",
          "Audio handling",
          "Preserve channels & timing",
          ["Preserve channels & timing", "Explicit stereo downmix"],
          "No implicit stereo or sample-rate conversion.",
        ),
        select(
          "trimMode",
          "Default trim mode",
          "Precise",
          ["Precise", "Fast · keyframe aligned"],
          "Fast trim previews its actual boundaries.",
        ),
      ],
    ),
    section(
      "restoration",
      "AI restoration",
      "Preview five seconds of motion before a full render.",
      [
        select(
          "restorationMode",
          "Default restoration mode",
          "Faithful",
          ["Faithful", "Creative"],
          "Both modes preserve the original and label AI output.",
        ),
        select(
          "upscale",
          "Enlargement",
          "2×",
          ["2×"],
          "Requires a compatible, validated model and enough GPU memory.",
        ),
        select(
          "upscaleCap",
          "Default output cap",
          "4K",
          ["4K", "Source dependent"],
          "SDR-only models must not silently process HDR masters.",
        ),
        toggle(
          "interpolation",
          "Offer frame interpolation separately",
          true,
          "RIFE changes motion timing; it is not part of ordinary upscaling.",
        ),
      ],
    ),
    section(
      "studio",
      "Studio & Dolby Vision",
      "Studio rendering and Dolby Vision support.",
      [
        toggle(
          "studioPreview",
          "Show development Studio",
          false,
          "Full Studio remains unavailable until parity and media-quality qualification pass.",
          "Development interface only",
        ),
      ],
      { panel: "qualification" },
    ),
  ],
  sharing: [
    section(
      "spaces",
      "Shared Spaces",
      "Libraries everyone in a household can add to.",
      [
        select(
          "spaceRole",
          "Default invited role",
          "Viewer",
          ["Viewer", "Editor"],
          "Owners can change individual roles explicitly.",
        ),
        toggle(
          "recipientPreview",
          "Preview recipient visibility",
          true,
          "Review the exact sources and Locked-content restrictions before sharing.",
        ),
        toggle(
          "spaceActivity",
          "Show new since last visit",
          true,
          "Activity is scoped to content the visitor can currently access.",
        ),
      ],
      { panel: "spaces" },
    ),
    section(
      "links",
      "Public links",
      "Defaults for links you share with anyone.",
      [
        number(
          "shareExpiry",
          "Suggested link lifetime",
          7,
          "days",
          1,
          365,
          "Existing links keep their explicitly assigned expiration.",
        ),
        toggle(
          "shareDownload",
          "Allow downloads by default",
          false,
          "Review original-file exposure separately from preview access.",
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
      "Partners who see your library, and groups you share with often.",
      [
        toggle(
          "partnerTimeline",
          "Include partner photos in my timeline",
          true,
          "Only accessible media appears.",
        ),
        toggle(
          "groupReview",
          "Review recipients when using a group",
          true,
          "Changing a group never silently changes existing access.",
        ),
      ],
    ),
    section(
      "shared-identities",
      "People across libraries",
      "Match the same person across different libraries.",
      [
        toggle(
          "sharedPeople",
          "Suggest identity links in Spaces",
          false,
          "Use only accessible evidence and retain manual correction history.",
        ),
        select(
          "albumSort",
          "Default album viewing order",
          "Newest first",
          ["Newest first", "Oldest first", "Shared album order"],
          "Personal viewing order is separate from explicitly edited shared order.",
        ),
      ],
    ),
  ],
  care: [
    section(
      "health",
      "Media health & integrity",
      "Check that every original is present and intact.",
      [
        toggle(
          "healthScan",
          "Schedule incremental health scans",
          true,
          "Resume from recorded checkpoints after interruption.",
        ),
        toggle(
          "checksumScan",
          "Verify original checksums",
          true,
          "Checksums help prove preservation; existence alone does not.",
        ),
        toggle(
          "integrityAudit",
          "Audit database and file references",
          true,
          "Include physical-deduplication owners and references.",
        ),
      ],
      { action: "Preview health findings", actionKind: "health" },
    ),
    section(
      "repair",
      "Repair queues",
      "Everything waiting for a fix, in one place.",
      [
        toggle(
          "livePhotoRepair",
          "Suggest Live Photo relinking",
          true,
          "Ambiguous pairs remain in review.",
        ),
        toggle(
          "rawRecovery",
          "Suggest recoverable RAW sources",
          true,
          "Prefer original provenance and verified dimensions.",
        ),
        toggle(
          "duplicateReview",
          "Group near-duplicates for review",
          true,
          "Keeper suggestions use quality, resolution, and format; deletion stays explicit.",
        ),
      ],
      { panel: "repairs" },
    ),
    section(
      "enrichment-care",
      "Enrichment completeness",
      "See which photos still need faces, descriptions or search indexing.",
      [
        toggle(
          "incrementalEnrichment",
          "Reprocess only affected outputs",
          true,
          "Changing an identity should not rerun unrelated media jobs.",
        ),
        toggle(
          "manualMetadata",
          "Preserve manual metadata on rerun",
          true,
          "Rule provenance and model versions identify replaceable generated output.",
        ),
      ],
    ),
  ],
  processing: [
    section(
      "workers",
      "Workers & endpoints",
      "Computers that process your library, including others on your network.",
      [],
      { panel: "workers" },
    ),
    section(
      "routing",
      "Workload destinations",
      "Choose where each kind of work runs.",
      [
        select(
          "destination",
          "Default destination for new jobs",
          "local",
          [
            {
              value: "local",
              label: "Compatible local or home-network worker",
            },
            { value: "runpod", label: "RunPod · explicit cloud processing" },
          ],
          "Existing jobs keep their saved destination.",
        ),
        select(
          "localUnavailable",
          "When a local worker is unavailable",
          "Wait and notify",
          ["Wait and notify", "Fail with retry instructions"],
          "Switching to RunPod requires an explicit choice.",
        ),
        toggle(
          "endpointHealth",
          "Check endpoint availability",
          true,
          "Reachability, model support, and render qualification are separate states.",
        ),
      ],
    ),
    section(
      "queues",
      "Queues & concurrency",
      "Balance indexing with interactive browsing.",
      [
        number(
          "thumbnailJobs",
          "Thumbnail workers",
          3,
          "jobs",
          1,
          32,
          "Limit concurrent thumbnail generation.",
        ),
        number(
          "videoJobs",
          "Playback transcodes",
          1,
          "jobs",
          1,
          16,
          "Heavy encodes compete for memory and GPU time.",
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
      "runpod",
      "RunPod lifecycle",
      "When cloud processing starts and stops.",
      [
        toggle(
          "runpodEnabled",
          "Make RunPod available",
          false,
          "Cloud processing requires credentials, a compatible worker, and consent to transfer media.",
        ),
        select(
          "runpodProfile",
          "Workload profile",
          "Video jobs · durable",
          ["Video jobs · durable", "Interactive ML"],
          "Long video jobs cannot depend on a synchronous request lifetime.",
        ),
        number(
          "runpodIdle",
          "Stop after idle",
          10,
          "minutes",
          1,
          120,
          "Active jobs count as activity; check their checkpoint before shutdown.",
        ),
        number(
          "costAlert",
          "Notify at estimated monthly spend",
          25,
          "USD",
          0,
          1000,
          "Estimates are not invoices or enforceable billing caps.",
        ),
      ],
    ),
    section(
      "schedules",
      "Nightly work & model cache",
      "Schedule heavier tasks around the way your household uses the library.",
      [
        select(
          "nightlyWindow",
          "Maintenance window",
          "01:00–06:00",
          ["01:00–06:00", "23:00–07:00", "No restricted window"],
          "Use server time and show skipped or interrupted jobs.",
        ),
        number(
          "modelTtl",
          "Unload idle models after",
          300,
          "seconds",
          30,
          3600,
          "A longer cache lifetime trades memory for startup speed.",
        ),
        toggle(
          "nightlyDuplicates",
          "Review duplicate candidates overnight",
          true,
          "Only discovery runs automatically; deletion remains a reviewed action.",
        ),
      ],
    ),
  ],
  security: [
    section(
      "accounts",
      "People with server access",
      "Accounts, roles and storage limits.",
      [
        number(
          "defaultQuota",
          "Default new-account quota",
          500,
          "GB",
          1,
          100000,
          "Logical account usage can differ from physically stored bytes.",
        ),
      ],
      { panel: "users" },
    ),
    section(
      "signin",
      "Sign-in methods",
      "How people sign in, and how to recover access.",
      [
        toggle(
          "passwordLogin",
          "Password sign-in",
          true,
          "Do not disable until an administrator can successfully use the alternative.",
          "All sign-ins",
        ),
        toggle(
          "oauthEnabled",
          "OpenID Connect / OAuth",
          false,
          "Keep Immich and Frameleaf callback routes compatible.",
          "All sign-ins",
        ),
        text(
          "oauthIssuer",
          "Issuer URL",
          "https://identity.example.invalid",
          "Enter the issuer published by your identity provider.",
          "All sign-ins",
          "url",
        ),
        text(
          "oauthClient",
          "Client ID",
          "frameleaf",
          "Credentials are managed separately and excluded from settings exports.",
          "All sign-ins",
        ),
        toggle(
          "oauthAutoRegister",
          "Create accounts from approved sign-ins",
          false,
          "Apply domain and quota policy before provisioning.",
        ),
      ],
    ),
    section(
      "privacy",
      "Locked content",
      "Keep Locked items out of search, sharing and downloads.",
      [
        toggle(
          "hideSensitive",
          "Keep detected content Locked until unlocked",
          true,
          "The private detection flag is authoritative; tags cannot unlock content.",
          "All access checks",
        ),
        number(
          "unlockTimeout",
          "Lock elevated sessions after",
          15,
          "minutes",
          1,
          240,
          "PIN enrollment and credentials require a real authenticated server.",
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
      "Devices and apps that can reach your library.",
      [],
      { panel: "sessions" },
    ),
  ],
  notifications: [
    section(
      "signals",
      "What needs my attention",
      "Choose which events deserve an alert.",
      [
        toggle(
          "notifyCapacity",
          "Storage capacity warnings",
          true,
          "Include the filesystem and a link to its storage view.",
        ),
        toggle(
          "notifyJobs",
          "Failed or interrupted jobs",
          true,
          "Group repeated failures and link to recovery.",
        ),
        toggle(
          "notifyBackup",
          "Missed backups or verification",
          true,
          "A database backup alone does not protect original media.",
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
          "Messages about imports, sharing, and completed processing.",
        ),
      ],
    ),
    section(
      "email",
      "Email delivery",
      "Send email from your own mail server.",
      [
        toggle(
          "smtpEnabled",
          "Enable SMTP delivery",
          false,
          "This preview does not send mail or store credentials.",
        ),
        text(
          "smtpHost",
          "SMTP host",
          "smtp.example.invalid",
          "Use your mail provider’s hostname.",
        ),
        number(
          "smtpPort",
          "SMTP port",
          587,
          "",
          1,
          65535,
          "Typical submission ports are 587 or 465.",
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
          "Keep sender identity distinct from the administrator login.",
          "New messages",
          "email",
        ),
      ],
      { action: "Preview notification", actionKind: "email" },
    ),
    section(
      "templates",
      "Message templates",
      "Brand account invitations, shared albums, and recovery emails consistently.",
      [
        text(
          "mailGreeting",
          "Invitation greeting",
          "Your memories have a new home.",
          "Built on Immich attribution remains in About and the README.",
        ),
        toggle(
          "emailBrand",
          "Use Frameleaf identity",
          true,
          "Apply light and dark-compatible brand assets.",
        ),
      ],
    ),
  ],
  server: [
    section(
      "identity",
      "Server identity & network",
      "Your server's name and network address.",
      [
        text(
          "serverName",
          "Server name",
          "Home archive",
          "Shown in the command center and connection picker.",
          "Display only",
        ),
        text(
          "externalUrl",
          "Public server URL",
          "https://photos.example.invalid",
          "Used for links and identity callbacks.",
          "New links",
        ),
        select(
          "serverTimezone",
          "Server timezone",
          "America/Edmonton",
          ["America/Edmonton", "America/New_York", "Europe/London", "UTC"],
          "Maintenance schedules use this timezone.",
        ),
        text(
          "welcomeMessage",
          "Welcome message",
          "A home for all our memories.",
          "Shown on the sign-in screen.",
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
          "Stable releases are intended for everyday use. Beta and development releases can change more often and may be less reliable.",
          "Update checks",
        ),
        {
          ...toggle(
            "externalVersionChecks",
            "Third-party release checks",
            false,
            "Update checks use Frameleaf services only. Other release services are never contacted.",
            "Required privacy boundary",
          ),
          locked: true,
          policy: "External release services prohibited",
        },
        {
          ...select(
            "installedBuildChannel",
            "Installed build channel",
            "Development",
            ["Development"],
            "The installed build stays on this channel until you install a different release.",
            "Read-only build information",
          ),
          locked: true,
        },
      ],
      { panel: "versions" },
    ),
    section(
      "diagnostics",
      "Logs & diagnostics",
      "Logs for troubleshooting, without exposing your photos.",
      [
        select(
          "logLevel",
          "Log level",
          "Info",
          ["Error", "Warn", "Info", "Debug", "Verbose"],
          "Verbose logs may contain private paths or metadata.",
          "New logs",
        ),
        {
          ...toggle(
            "metrics",
            "External telemetry",
            false,
            "External telemetry is prohibited. Local metrics and analytics are permitted without sending data to third-party reporting services.",
          ),
          locked: true,
          policy: "External telemetry prohibited",
        },
        toggle(
          "localMetrics",
          "Collect local metrics",
          false,
          "Keep performance and usage history on your server without sending it to external reporting services.",
          "Local analytics",
        ),
        select(
          "metricsRetention",
          "Keep analytics history for",
          "12 months",
          ["90 days", "12 months", "24 months"],
          "Older local history is removed after this period. A longer history uses more storage.",
          "Local analytics",
        ),
      ],
      { action: "Download diagnostics", actionKind: "diagnostics" },
    ),
    section(
      "maps",
      "Maps & geography",
      "Map style and place names, with location privacy kept.",
      [
        toggle(
          "mapsEnabled",
          "Enable maps",
          true,
          "Map access inherits library and Locked-content permissions.",
        ),
        toggle(
          "reverseGeocoding",
          "Look up place names from GPS",
          true,
          "Existing location metadata remains editable.",
        ),
        text(
          "mapStyle",
          "Custom map style URL",
          "",
          "Leave empty for the configured built-in style.",
        ),
      ],
    ),
    section(
      "branding",
      "Branding & client compatibility",
      "Your server's name, logo and login message.",
      [
        toggle(
          "customTheme",
          "Allow custom theme CSS",
          false,
          "Scope custom rules and retain visible focus and contrast.",
        ),
        text(
          "customCss",
          "Custom theme CSS",
          "",
          "Customize the appearance with CSS. Check both themes and keep a recovery copy before changing styles.",
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
          "Your private person names remain independently maintained.",
          "Your account",
        ),
        text(
          "accountEmail",
          "Email",
          "taylor@example.invalid",
          "Changing your email may require verification.",
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
          "Applies to this device when you save.",
          "This device",
        ),
        select(
          "language",
          "Language",
          "English",
          ["English", "Français", "Deutsch", "Español"],
          "Choose the language used by the interface.",
          "Your account",
        ),
        select(
          "defaultLayout",
          "Preferred library layout",
          "Work",
          ["Timeline", "Browse", "Work"],
          "Layout switching preserves selection, filters, and draft history.",
          "This device",
        ),
        toggle(
          "motion",
          "Reduce decorative motion",
          true,
          "Operating-system reduced-motion preference is always respected.",
          "This device",
        ),
        toggle(
          "showFilename",
          "Show filenames in Work view",
          true,
          "Favorites, ratings, and AI suggestions remain separate.",
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
          "Sharing a memory always remains an explicit action.",
        ),
        toggle(
          "birthdayMemories",
          "Include birthday memories",
          true,
          "Use explicit birthday data and the viewer timezone.",
        ),
        toggle(
          "videoMoments",
          "Include video moments",
          true,
          "Jump to timestamped results without flattening them into whole videos.",
        ),
      ],
    ),
    section(
      "downloads",
      "Downloads & local behavior",
      "How downloads are packaged and saved.",
      [
        select(
          "downloadFormat",
          "Preferred download",
          "Original",
          ["Original", "Edited version when available"],
          "Keep provenance visible when exporting an edited or AI derivative.",
        ),
        toggle(
          "downloadMetadata",
          "Include metadata sidecars",
          true,
          "Sidecars preserve metadata without modifying an original.",
        ),
        toggle(
          "archiveTimeline",
          "Show archived media in search",
          false,
          "Archiving is organization, not access protection.",
        ),
      ],
    ),
    section(
      "suppression",
      "Hidden memories",
      "People, places and dates Memories should skip.",
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
    "Manage sign-in, application access, and connected devices.",
    [],
    { scope: "account", module: "PersonalAccess" },
  ),
);
settingsSections.server.push(
  section(
    "configuration",
    "Configuration transfer",
    "Review, copy, import, or export your saved settings.",
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
    "Verify checksums, orphaned files, thumbnails and sidecars, then review the reports.",
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
    "Enhanced RAW rendering",
    true,
    "Use embedded previews first and render difficult RAW files when needed.",
  ),
);
findSection("libraries", "sources").fields.push(
  toggle(
    "libraryScheduledScan",
    "Enable scheduled scans",
    true,
    "Scan import folders on a schedule.",
  ),
  text(
    "libraryScanCron",
    "Custom scan schedule",
    "0 0 * * *",
    "Use a cron expression in server time.",
  ),
);
findSection("backup", "database-backup").fields.push(
  text(
    "backupCron",
    "Custom backup schedule",
    "0 2 * * *",
    "Use a cron expression in server time.",
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
  ["metadataExtraction", "Metadata extraction", 5],
  ["faceDetection", "Face detection", 2],
  ["smartSearch", "Smart search", 2],
  ["videoDuplicateDetection", "Video duplicate detection", 1],
  ["backgroundTask", "Background tasks", 5],
  ["migration", "Library migration", 5],
  ["search", "Search indexing", 5],
  ["sidecar", "Metadata sidecars", 5],
  ["library", "Library scans", 5],
  ["notifications", "Notification delivery", 5],
  ["ocr", "Text recognition", 1],
  ["imageEnrichment", "Image enrichment", 2],
  ["imageDescription", "Image descriptions", 2],
  ["nsfwDetection", "Locked-content detection", 2],
  ["mediaHealth", "Media health", 2],
  ["workflow", "Workflows", 5],
  ["editor", "Editor operations", 2],
  ["integrityCheck", "Integrity checks", 1],
])
  queues.fields.push(
    number(
      `queueConcurrency_${id}`,
      label,
      value,
      "jobs",
      1,
      1000,
      "Maximum jobs that run at the same time.",
    ),
  );

findSection("processing", "advanced-runpod-ordinary").credentials = [
  {
    id: "runpod-api-key",
    label: "RunPod API key",
    help: "Replace the key used to manage cloud workers.",
  },
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
    help: "Choose moment captions when running Enrichment and review the affected videos first.",
  },
  videoInterval: {
    label: "Reusable frames per video",
    value: 6,
    unit: "frames",
    min: 6,
    max: 6,
    locked: true,
    policy: "Current sampling policy",
    help: "Six evenly spaced frames provide a consistent overview of each video.",
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
    help: "Frame interpolation is not available until its model and motion quality are validated.",
  },
  modelTtl: {
    locked: true,
    policy: "Worker environment",
    help: "Your ML worker controls how long idle models remain in memory.",
  },
  faceDistance: { max: 2 },
  sensitiveThreshold: { min: 0.01 },
  localUnavailable: {
    help: "Choose whether a local job should wait or stop when its worker is unavailable. Switching to cloud processing requires a separate choice.",
  },
  destination: {
    help: "Choose a preferred destination for new jobs. Video restoration retains its destination until you explicitly change it.",
  },
  runpodIdle: {
    label: "Managed ML pod idle timeout",
    help: "Stop idle library analysis workers. Video workers need to finish or checkpoint their active jobs before stopping.",
  },
  runpodProfile: {
    help: "Library analysis and long video jobs use separate workers.",
  },
  shareLocation: {
    help: "Review location details before sharing. Downloaded originals may contain embedded GPS metadata.",
  },
  locationPrivacy: {
    help: "Keep location details out of public previews. Review original downloads separately for embedded GPS metadata.",
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
    help: "Unlock to change the scope together with its selected Locked tags and people.",
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
    label: "Use TLS from connection start",
    help: "Use TLS from the start of the connection when required by your mail server. Otherwise use its negotiated transport.",
  },
  smtpPort: { min: 0, max: 65535 },
  trashDays: { min: 0 },
  thumbnailJobs: { min: 1, max: 1000, integer: true },
  videoJobs: { min: 1, max: 1000, integer: true },
  advancedDescriptionInstructions: { maxLength: 2000 },
  advancedMlUrls: { list: { type: "url", minItems: 1 } },
  advancedServerlessGpuPools: { list: { type: "text", minItems: 1 } },
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
      reason: "Progressive loading is available for JPEG only.",
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
    Number(values.advancedServerlessMin) > Number(values.advancedServerlessMax)
  )
    errors.advancedServerlessMax =
      "Maximum workers cannot be lower than minimum workers.";
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
      errors[id] = "Progressive loading is available for JPEG only.";
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
