import type { CarouselImageItem, IconLike } from '../../types.js';
type Props = {
    item: CarouselImageItem;
    leftIcons?: IconLike[];
    rightIcons?: IconLike[];
    class?: string;
};
declare const ImageCard: import("svelte").Component<Props, {}, "">;
type ImageCard = ReturnType<typeof ImageCard>;
export default ImageCard;
