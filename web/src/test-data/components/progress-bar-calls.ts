/** What the mocked ProgressBar was asked to do, in order (see MockProgressBar.svelte). */
export const progressBarCalls: string[] = [];

export const progressBarFixture: { reset?: () => Promise<void>; done?: () => Promise<void> } = {};
