import type { Faces } from '$lib/managers/asset-viewer-manager.svelte';
import { mapNormalizedRectToContent, type Rect, type Size } from '$lib/utils/container-utils';

export type BoundingBox = Rect & { id: string };

export const getBoundingBox = (faces: Faces[], imageSize: Size): BoundingBox[] => {
  const boxes: BoundingBox[] = [];

  for (const face of faces) {
    const rect = mapNormalizedRectToContent(
      { x: face.boundingBoxX1 / face.imageWidth, y: face.boundingBoxY1 / face.imageHeight },
      { x: face.boundingBoxX2 / face.imageWidth, y: face.boundingBoxY2 / face.imageHeight },
      imageSize,
    );

    boxes.push({ id: face.id, ...rect });
  }

  return boxes;
};
