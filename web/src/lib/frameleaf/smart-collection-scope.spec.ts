import { LibraryViewScope } from '@frameleaf/sdk';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { smartAlbumCriteria } from '$lib/frameleaf/search-palette';

// The server creates a rule's album in the rule filter's library scope, so a smart collection saved
// from Boards' filter bar is a Boards collection only while the criteria keep that scope.
it('keeps the Boards scope on a smart collection saved from Boards', () => {
  const result = smartAlbumCriteria({
    ...emptyDiscoveryQuery(),
    filter: { libraryScope: LibraryViewScope.Design, isFavorite: { eq: true } },
  });
  expect(result.ok && result.criteria.filter?.libraryScope).toBe(LibraryViewScope.Design);
});
