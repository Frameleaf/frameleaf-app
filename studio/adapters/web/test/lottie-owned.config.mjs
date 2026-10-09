import existingConfig from './keyframe-browser.config.mjs';
export default async () => {
  const config = await existingConfig();
  return { ...config, optimizeDeps: { ...config.optimizeDeps,
    entries: ['test/lottie-owned.browser.html'] } };
};
