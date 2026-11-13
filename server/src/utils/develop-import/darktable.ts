import type { KnownAssetDevelopRecipe } from 'src/dtos/asset-develop.dto.js';
import { readNativeHistory } from 'src/utils/develop-import/native-history.js';
import { DARKTABLE_NAMESPACE, type XmpNode, settingsFor } from 'src/utils/develop-import/xmp.js';
import { normalizeDevelopRecipe } from 'src/utils/develop-recipe.js';

/** Preserve a validated native baseline; quick controls are later, relative edits rather than approximations. */
export function importDarktable(nodes: XmpNode[]): KnownAssetDevelopRecipe | undefined {
  const history = settingsFor(nodes, DARKTABLE_NAMESPACE).some((node) => node.name === 'history');
  if (!history) return;
  return { ...normalizeDevelopRecipe({}), imported: { darktable: { replay: readNativeHistory(nodes) } } };
}
