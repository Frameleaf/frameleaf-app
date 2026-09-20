export const workflowStates = [
  "normal",
  "empty",
  "forbidden",
  "stale",
  "retry",
  "keyboard",
  "narrow",
];

const stateCopy = {
  normal: {
    label: "Ready",
    tone: "ready",
    summary: "The current source and permissions were checked moments ago.",
    primary: "Continue",
    secondary: "Cancel",
  },
  empty: {
    label: "Nothing here yet",
    tone: "quiet",
    summary:
      "Explain why the list is empty and offer the next valid source action.",
    primary: "Choose items",
    secondary: "Go back",
  },
  forbidden: {
    label: "Access changed",
    tone: "blocked",
    summary: "Do not reveal names, previews, counts, or earlier private state.",
    primary: "Return to library",
    secondary: "Learn about access",
  },
  stale: {
    label: "Newer changes found",
    tone: "warning",
    summary:
      "Keep the local draft recoverable, but never overwrite the newer revision.",
    primary: "Review changes",
    secondary: "Keep a copy",
  },
  retry: {
    label: "Stopped safely",
    tone: "warning",
    summary:
      "The previous attempt changed nothing. Retry from the recorded checkpoint.",
    primary: "Retry",
    secondary: "Cancel operation",
  },
  keyboard: {
    label: "Keyboard path",
    tone: "focus",
    summary:
      "Every pointer gesture has a named control, visible focus, and a reversible escape path.",
    primary: "Apply with Enter",
    secondary: "Cancel with Escape",
  },
  narrow: {
    label: "Compact layout",
    tone: "quiet",
    summary:
      "Keep the decision and current state visible; move secondary detail behind an explicit review step.",
    primary: "Review details",
    secondary: "Not now",
  },
};

const flows = {
  album: {
    eyebrow: "Album lifecycle and sharing",
    title: "Summer in the Rockies",
    description:
      "Owner-safe album changes with explicit collaborator roles and retained assets.",
    scope: "Owned album · 19 items · 3 collaborators",
    facts: ["Taylor · Owner", "Jamie · Editor", "Emma · Viewer"],
    steps: [
      "Review album",
      "Choose people and roles",
      "Confirm the exact change",
    ],
    warning:
      "Deleting this album never deletes its photos. Leaving is available only to collaborators.",
    normalAction: "Invite collaborator",
  },
  people: {
    eyebrow: "People correction",
    title: "Correct a face assignment",
    description:
      "Keep manual tagging separate from correcting a detected face.",
    scope: "Emma portrait.jpg · current asset access rechecked",
    facts: [
      "Detected face · Jamie",
      "Suggested match · Emma",
      "Manual region · not yet assigned",
    ],
    steps: [
      "Choose detected or manual face",
      "Search a person",
      "Review and save",
    ],
    warning:
      "A stale or inaccessible asset clears the preview and prevents the correction from being saved.",
    normalAction: "Assign Emma",
  },
  recovery: {
    eyebrow: "Bulk recovery",
    title: "Recover missing originals",
    description:
      "Select exact candidates, review evidence, then publish only revalidated replacements.",
    scope: "3 findings · Backup A and NAS Archive",
    facts: [
      "Taylor-owned findings only",
      "2 exact checksum matches",
      "1 filename-only candidate",
      "Previous originals retained",
    ],
    steps: [
      "Choose search locations",
      "Match every candidate",
      "Recheck access and publish",
    ],
    warning:
      "Filename or successful decode alone never proves an original is the same file.",
    normalAction: "Review 2 recoveries",
  },
  studio: {
    eyebrow: "Studio conflict",
    title: "Choose how to continue",
    description:
      "Protect project history when a lease expires or another editor saves first.",
    scope: "Revision 18 · newer revision 19 by Jamie",
    facts: [
      "Your draft is recoverable",
      "Source permissions rechecked",
      "Takeover remains blocked while Jamie's lease is active",
      "No render or cloud job started",
    ],
    steps: [
      "Compare revisions",
      "Choose latest, copy, or discard",
      "Acquire a fresh lease",
    ],
    warning:
      "The current draft cannot overwrite revision 19. Cloud processing remains an explicit later choice.",
    normalAction: "Open latest revision",
  },
  tablet: {
    eyebrow: "Native tablet adaptation",
    title: "Continue the Studio project",
    description:
      "A native tablet workspace over shared project commands, never a wrapped web editor.",
    scope: "Tablet landscape · touch, Pencil, and hardware keyboard",
    facts: [
      "Library and preview stay visible",
      "Inspector becomes a sheet when narrow",
      "Phone remains review and quick edit",
    ],
    steps: [
      "Select project and revision",
      "Edit with native controls",
      "Review durable job state",
    ],
    warning:
      "This interaction model does not claim Flutter, renderer, physical-device, or full Freecut parity.",
    normalAction: "Continue on tablet",
  },
};

export function getWorkflowReview(flowId, stateId) {
  const flow = flows[flowId] ?? flows.album;
  const { normalAction, ...flowView } = flow;
  const state = stateCopy[stateId] ?? stateCopy.normal;
  const review = {
    flowId: flows[flowId] ? flowId : "album",
    stateId: stateCopy[stateId] ? stateId : "normal",
    ...flowView,
    state: {
      ...state,
      primary: stateId === "normal" ? normalAction : state.primary,
    },
  };
  if (review.stateId === "empty") {
    return {
      ...review,
      description: "No eligible items are available in the current scope.",
      scope: "0 eligible items",
      facts: [],
    };
  }
  if (review.stateId === "forbidden") {
    return {
      ...review,
      title: "This workflow is no longer available",
      description:
        "Access was removed. Earlier private content has been cleared from this screen.",
      scope: "Unavailable",
      facts: [],
      steps: [
        "Clear private content",
        "Return to an authorized area",
        "Start again after access is restored",
      ],
      warning:
        "Do not display prior names, previews, counts, draft values, or recovery candidates.",
    };
  }
  if (review.flowId === "recovery" && review.stateId === "retry") {
    return {
      ...review,
      state: {
        ...review.state,
        label: "Partial recovery",
        summary:
          "1 finding was recovered and 2 stayed unchanged. Retry resumes with unresolved findings only.",
        primary: "Retry unresolved 2",
        secondary: "Close results",
      },
    };
  }
  return review;
}

const normalOutcomes = {
  album: {
    primary: "Invite review opened. No invitation has been sent.",
    secondary: "Invite cancelled. Album and roles are unchanged.",
  },
  people: {
    primary: "Correction review opened. The detected face is still unchanged.",
    secondary: "Correction cancelled. The existing assignment is unchanged.",
  },
  recovery: {
    primary:
      "Review opened for 2 exact candidates. Nothing has been published.",
    secondary: "Recovery review closed. Originals are unchanged.",
  },
  studio: {
    primary:
      "Revision 19 opened for comparison. Your local draft remains recoverable.",
    secondary: "Comparison closed. Your local draft remains recoverable.",
  },
  tablet: {
    primary:
      "Tablet handoff checklist opened. No native or render job was started.",
    secondary: "Tablet handoff dismissed. The project is unchanged.",
  },
};

export function getWorkflowActionOutcome(flowId, stateId, action) {
  const review = getWorkflowReview(flowId, stateId);
  const kind = action === "secondary" ? "secondary" : "primary";
  if (review.stateId === "normal") return normalOutcomes[review.flowId][kind];
  if (review.flowId === "recovery" && review.stateId === "retry") {
    return kind === "primary"
      ? "Retry review opened for 2 unchanged findings. Lake morning.mov remains recovered."
      : "Results closed. Lake morning.mov remains recovered; the other findings remain unchanged.";
  }
  if (review.stateId === "stale") {
    return kind === "primary"
      ? "Revision comparison opened. Newer changes still block overwrite."
      : "A local copy was retained. The newer revision remains unchanged.";
  }
  if (review.stateId === "retry") {
    return kind === "primary"
      ? "Retry opened from the recorded checkpoint. No mutation has run."
      : "Retry cancelled. No changes were applied.";
  }
  if (review.stateId === "keyboard") {
    return kind === "primary"
      ? "Keyboard action applied to this review only. No production mutation ran."
      : "Keyboard action cancelled. No changes were applied.";
  }
  if (review.stateId === "empty") {
    return kind === "primary"
      ? "Source chooser opened. The empty result is unchanged."
      : "Returned without changing the empty result.";
  }
  if (review.stateId === "forbidden") {
    return kind === "primary"
      ? "Returned to an authorized area. Private values remain cleared."
      : "Access guidance opened without restoring private values.";
  }
  return kind === "primary"
    ? "Detail review opened. No production mutation ran."
    : "Detail review dismissed. Nothing changed.";
}

export function getWorkflowActionSurface(flowId, stateId, action) {
  const review = getWorkflowReview(flowId, stateId);
  const kind = action === "secondary" ? "secondary" : "primary";
  if (review.stateId === "forbidden") {
    return kind === "secondary"
      ? {
          id: "access-guidance",
          title: "Access changed",
          summary: "Private values stay cleared while access guidance is open.",
          items: [
            "Confirm the active library",
            "Request access from its owner",
          ],
        }
      : null;
  }
  if (kind === "secondary") return null;
  if (review.flowId === "album" && review.stateId === "normal") {
    return {
      id: "invite-review",
      title: "Invite collaborator review",
      summary: "Choose an identity and role before any invitation can be sent.",
      items: [
        "No recipient selected",
        "Role not selected",
        "Album remains unchanged",
      ],
    };
  }
  if (review.stateId === "stale") {
    return {
      id: "revision-comparison",
      title: "Review changes before continuing",
      summary:
        "The newer revision remains authoritative while this comparison is open.",
      items: [
        "Local: revision 18 + 6 changes",
        "Current: revision 19 by Jamie",
        "Overwrite blocked",
      ],
    };
  }
  if (review.flowId === "recovery" && review.stateId === "retry") {
    return {
      id: "recovery-retry-checkpoint",
      title: "Retry 2 unresolved findings",
      summary:
        "Lake morning.mov stays recovered outside this retry checkpoint.",
      items: [
        "Emma portrait.jpg · recheck access",
        "Forest trail.mov · review checksum evidence",
      ],
    };
  }
  if (review.stateId === "empty") {
    return {
      id: "source-chooser",
      title: "Choose another source",
      summary: "The empty result stays unchanged until a source is selected.",
      items: ["Current scope: 0 eligible items", "No source selected"],
    };
  }
  if (review.stateId === "keyboard") {
    return {
      id: "keyboard-review",
      title: "Keyboard review opened",
      summary:
        "This bounded review proves the Enter path without running a production mutation.",
      items: ["Primary action received", "Escape closes this review"],
    };
  }
  return {
    id: `${review.flowId}-${review.stateId}-review`,
    title: `${review.eyebrow} review`,
    summary: "This bounded review does not execute a production mutation.",
    items: review.steps,
  };
}

export const workflowIds = Object.keys(flows);

export function workflowCoverage() {
  return workflowIds.flatMap((flowId) =>
    workflowStates.map((stateId) => ({ flowId, stateId })),
  );
}
