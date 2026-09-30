import adapterConfig from "../vite.config.mjs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
const require = createRequire(
  new URL("../../../engine/package.json", import.meta.url),
);
export default async () => {
  const config = await adapterConfig();
  return {
    ...config,
    cacheDir: path.join(
      tmpdir(),
      `frameleaf-fl100-browser-${createHash("sha256")
        .update(import.meta.url)
        .digest("hex")
        .slice(0, 12)}`,
    ),
    server: {
      fs: { allow: [new URL("../../../../", import.meta.url).pathname] },
    },
    optimizeDeps: {
      ...config.optimizeDeps,
      entries: [
        "test/keyframe-render.browser.html",
        "test/editor-controls.browser.html",
      ],
    },
    resolve: {
      ...config.resolve,
      alias: [
        ...[
          "react",
          "react-dom/client",
          "react-dom",
          "react/jsx-runtime",
          "react/jsx-dev-runtime",
        ].map((name) => ({
          find: new RegExp(`^${name.replaceAll("/", "\\/")}$`),
          replacement: require.resolve(name),
        })),
        ...config.resolve.alias,
      ],
    },
  };
};
