import type { CarouselImageItem, TranslationProps } from '../../types.js';
import type { Snippet } from 'svelte';
type Props = {
    items: CarouselImageItem[];
    scrollBy?: number;
    translations?: TranslationProps<'navigate_next' | 'navigate_previous'>;
    class?: string;
    child?: Snippet<[CarouselImageItem]>;
};
declare const ImageCarousel: import("svelte").Component<Props, {}, "">;
type ImageCarousel = ReturnType<typeof ImageCarousel>;
export default ImageCarousel;
