import engineConfig from '../engine/vite.config.ts';
import { stableFileUrlSourcemapsPlugin } from './stable-file-url-sourcemaps.mjs';

export default {
  ...engineConfig,
  plugins: [engineConfig.plugins, stableFileUrlSourcemapsPlugin()],
};
