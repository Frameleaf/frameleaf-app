import { MenuItemType, type ActionItem, type GithubLinkProps, type IfLike } from '../types.js';
import type { DateTime } from 'luxon';
export type QueryValue = number | string;
export declare const asQueryString: (params?: Record<string, QueryValue | undefined>, options?: {
    skipEmptyStrings?: boolean;
    skipNullValues?: boolean;
}) => string;
export declare const asGithubLink: (options: number | GithubLinkProps) => {
    href: string;
    text: string;
};
export declare const navigateTo: (url: string) => Promise<void>;
export declare const resolveUrl: (url: string, currentHostname?: string) => string;
export declare const isExternalLink: (href: string) => boolean;
export type Metadata = {
    title: string;
    description: string;
    imageUrl?: string;
};
export type ArticleMetadata = {
    publishedTime: DateTime;
    modifiedTime?: DateTime;
    expirationTime?: DateTime;
    authors?: string[];
    section?: string;
    tags?: string[];
};
export declare const isMenuItemType: (item: ActionItem | MenuItemType) => item is MenuItemType;
export declare const resolveMetadata: (site: Metadata, page?: Metadata, article?: ArticleMetadata) => {
    type: string;
    siteName: string;
    title: string;
    description: string;
    imageUrl: string | undefined;
    article: {
        publishedTime: string | null;
        modifiedTime: string | null | undefined;
        expirationTime: string | null | undefined;
        authors: string[] | undefined;
        section: string | undefined;
        tags: string[] | undefined;
    } | undefined;
};
export declare const asText: (...items: unknown[]) => string;
export declare const isEnabled: ({ $if }: IfLike) => boolean;
