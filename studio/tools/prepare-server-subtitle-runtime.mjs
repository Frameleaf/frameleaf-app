import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copySubtitleSidecarRuntime } from "./owned-subtitle-runtime.mjs";

export async function prepareServerSubtitleRuntime() {
  const studio = fileURLToPath(new URL("../", import.meta.url));
  return copySubtitleSidecarRuntime(
    studio,
    path.resolve(studio, "../server/resources/studio"),
    path.resolve(studio, "../server"),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await prepareServerSubtitleRuntime();
}
