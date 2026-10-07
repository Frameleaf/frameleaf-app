// Prototype state contract, not a server implementation or a live API.
export function createSetup(origin = 'import') {
  return {
    id: 'demo-setup-session', libraryId: 'demo-home-library',
    kind: origin === 'import' ? 'new_import' : origin === 'restore' ? 'restored_library' : 'new_library',
    phase: 'rescanning', progress: 0, rescanComplete: false, verificationPassed: false,
    libraryRevision: null, paused: false, error: null,
    mobile: { linked: false, authenticated: false, libraryId: null, progress: 0,
      syncedRevision: null, catalogComplete: false, previewsReady: false, finished: false },
    managerFinished: false,
  };
}

export function readiness(setup) {
  if (!setup) return { serverReady: false, phoneReady: false, canFinish: false };
  const serverReady = setup.phase === 'complete' && setup.rescanComplete &&
    setup.verificationPassed && !!setup.libraryRevision && !setup.error;
  const phone = setup.mobile;
  const phoneReady = serverReady && phone.linked && phone.authenticated &&
    phone.libraryId === setup.libraryId && phone.catalogComplete && phone.previewsReady &&
    phone.syncedRevision === setup.libraryRevision;
  return { serverReady, phoneReady, canFinish: serverReady && phoneReady };
}

export function linkDemoPhone(setup) {
  Object.assign(setup.mobile, { linked: true, authenticated: true, libraryId: setup.libraryId });
}

export function advanceSetup(setup) {
  if (setup.paused || setup.error) return;
  setup.progress = Math.min(100, setup.progress + 5);
  setup.phase = setup.progress < 75 ? 'rescanning' : setup.progress < 100 ? 'verifying' : 'complete';
  setup.rescanComplete = setup.progress >= 75;
  setup.verificationPassed = setup.progress === 100;
  if (setup.phase === 'complete') setup.libraryRevision = 'demo-revision-after-rescan';
  const phone = setup.mobile;
  if (phone.linked && phone.authenticated) {
    // The catalog sync starts immediately, even while the server is rescanning.
    // Final deltas, permission changes and removals must catch up to the final revision.
    phone.progress = Math.min(setup.phase === 'complete' ? 100 : 90, phone.progress + 8);
    if (phone.progress === 100) {
      phone.catalogComplete = true;
      phone.previewsReady = true;
      phone.syncedRevision = setup.libraryRevision;
    }
  }
}

export function setupStatusResponse(setup, { authenticated = false } = {}) {
  // Before authentication, never disclose source identity, counts or job details.
  if (!authenticated) return { setupRequired: !readiness(setup).serverReady };
  return {
    setupId: setup.id, libraryId: setup.libraryId, kind: setup.kind,
    status: setup.error ? 'needs_attention' : setup.paused ? 'paused' : setup.phase,
    progress: { percent: setup.progress, rescanComplete: setup.rescanComplete },
    verification: setup.verificationPassed ? 'passed' : 'pending',
    libraryRevision: setup.libraryRevision,
    ready: readiness(setup).serverReady,
  };
}
