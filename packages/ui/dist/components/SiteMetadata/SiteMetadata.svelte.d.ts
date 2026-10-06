import { type ArticleMetadata, type Metadata } from '../../utilities/common.js';
type Props = {
    site: Metadata;
    page?: Metadata;
    article?: ArticleMetadata;
};
declare const SiteMetadata: import("svelte").Component<Props, {}, "">;
type SiteMetadata = ReturnType<typeof SiteMetadata>;
export default SiteMetadata;
