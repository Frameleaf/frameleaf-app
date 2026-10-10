import type { TagResponseDto } from '@frameleaf/sdk';
import type { MessageFormatter } from 'svelte-i18n';
import { tagColorId, type FrameleafTagNode, type TagColorId } from '$lib/frameleaf/tag-tree';

/**
 * What the tag dialog did, once the server has confirmed it. Declared here, not in the dialog, because
 * plain TypeScript cannot read a type out of a component.
 */
export type TagDialogResult =
  | { type: 'created' | 'renamed' | 'recolored' | 'moved'; tag: TagResponseDto }
  | { type: 'deleted'; node: FrameleafTagNode };

/** The name of one of the eight tag colours. */
export const tagColorLabel = ($t: MessageFormatter, id: TagColorId): string =>
  ({
    grey: $t('frameleaf_tags_color_grey'),
    green: $t('frameleaf_tags_color_green'),
    teal: $t('frameleaf_tags_color_teal'),
    blue: $t('frameleaf_tags_color_blue'),
    purple: $t('frameleaf_tags_color_purple'),
    pink: $t('frameleaf_tags_color_pink'),
    amber: $t('frameleaf_tags_color_amber'),
    red: $t('frameleaf_tags_color_red'),
  })[id];

/** The sentence the page announces once a tag change has been saved. */
export const tagResultMessage = ($t: MessageFormatter, result: TagDialogResult): string => {
  switch (result.type) {
    case 'created': {
      return $t('frameleaf_tags_tag_created', { values: { name: result.tag.name } });
    }
    case 'renamed': {
      return $t('frameleaf_tags_renamed', { values: { name: result.tag.name } });
    }
    case 'recolored': {
      const color = tagColorId(result.tag.color);
      return color ? $t('frameleaf_tags_color_changed', { values: { color: tagColorLabel($t, color) } }) : '';
    }
    case 'moved': {
      return $t('frameleaf_tags_moved');
    }
    default: {
      return $t('frameleaf_tags_tag_deleted');
    }
  }
};
