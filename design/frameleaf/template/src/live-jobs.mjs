// The app's current jobs list for views that are not handed it as a prop
// (the Frameleaf Cloud confirmation dialog mirrors its job from here).
// App publishes on every change; subscribers get the new list.

let current = [];
const listeners = new Set();

export function publishJobs(jobs) {
  current = Array.isArray(jobs) ? jobs : [];
  for (const listener of listeners) listener(current);
}

export function subscribeJobs(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const findLiveJob = (id) => (id ? current.find((job) => job.id === id) || null : null);
