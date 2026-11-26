import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DESCRIPTION_TASK } from 'src/utils/description-result.js';
import { type DesktopModelProfile, parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { canonicalJson } from 'src/utils/object.js';

/**
 * FD-31 (owner, 2026-11-24): the description models a desktop runs, keyed by the model name the settings use.
 * Each is a pinned GGUF pair the runtime's own llama.cpp process runs on the processor.
 */
const DESKTOP_DESCRIPTION_MODELS: Readonly<Record<string, string>> = Object.freeze({
  'Qwen/Qwen3.5-4B': 'Qwen3.5-4B',
  'Qwen/Qwen2.5-VL-7B-Instruct': 'Qwen2.5-VL-7B-Instruct',
});

/** The catalogue model a configured description model runs as on a desktop, or undefined when none does. */
export const desktopDescriptionModel = (configured: string): string | undefined =>
  Object.hasOwn(DESKTOP_DESCRIPTION_MODELS, configured) ? DESKTOP_DESCRIPTION_MODELS[configured] : undefined;

/** The binding takes no options: its prompt and limits are its own, so a desktop ignores the server's prompt. */
export const descriptionEntries = (modelName: string) => ({
  [DESCRIPTION_TASK]: { visual: { modelName, options: {} } },
});

let catalogue: ReturnType<typeof parseDesktopModelCatalogue> | undefined;
/** The catalogue profile `modelKey` names for the configured description model; throws when there is none. */
export const desktopDescriptionProfile = (configured: string, modelKey?: string): DesktopModelProfile => {
  const modelName = desktopDescriptionModel(configured);
  catalogue ??= parseDesktopModelCatalogue(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/desktop/model-catalogue.json'), 'utf8')),
  );
  const profile = catalogue.profiles.find(
    (profile) =>
      profile.workload === 'description' &&
      profile.modelName === modelName &&
      (modelKey === undefined || profile.modelKey === modelKey) &&
      canonicalJson(profile.spec.entries) === canonicalJson(descriptionEntries(profile.modelName)),
  );
  if (!modelName || !profile) throw new Error('desktop_pool_model_unavailable');
  return profile;
};
