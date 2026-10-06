import type { IconLike, Size, TextColor } from '../../types.js';
import { DateTime } from 'luxon';
import { type Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
type Props = {
    color?: TextColor;
    size?: Size;
    icon?: IconLike | false;
    since?: DateTime;
    until?: DateTime;
    center?: boolean;
    children?: Snippet;
    content?: Snippet;
} & HTMLAttributes<HTMLElement>;
declare const AnnouncementBanner: import("svelte").Component<Props, {}, "">;
type AnnouncementBanner = ReturnType<typeof AnnouncementBanner>;
export default AnnouncementBanner;
