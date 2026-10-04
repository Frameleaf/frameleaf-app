import { SyncAckDto, SyncAckV2Dto } from 'src/dtos/sync.dto.js';

describe('sync acknowledgement response contracts', () => {
  it.each(['AuthUserV1', 'AlbumV1', 'AlbumBootstrapV1', 'AssetV1', 'PetV1', 'SyncCompleteV1'])(
    'preserves legacy %s acknowledgements in both response versions',
    (type) => {
      const checkpoint = { type, ack: 'opaque-checkpoint' };
      expect(SyncAckDto.schema.parse(checkpoint)).toEqual(checkpoint);
      expect(SyncAckV2Dto.schema.parse(checkpoint)).toEqual(checkpoint);
    },
  );

  it.each(['AlbumSourceLinkV1', 'AlbumSourceLinkDeleteV1'])(
    'exposes %s only through the full V2 response contract',
    (type) => {
      const checkpoint = { type, ack: 'opaque-source-checkpoint' };
      expect(SyncAckDto.schema.safeParse(checkpoint).success).toBe(false);
      expect(SyncAckV2Dto.schema.parse(checkpoint)).toEqual(checkpoint);
    },
  );
});
