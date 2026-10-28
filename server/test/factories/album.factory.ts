import { Selectable } from 'kysely';
import { AlbumKind, AlbumUserRole, AssetOrder, LibraryScope } from 'src/enum.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { SharedLinkTable } from 'src/schema/tables/shared-link.table.js';
import { AlbumUserFactory } from 'test/factories/album-user.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { build } from 'test/factories/builder.factory.js';
import { AlbumLike, AlbumUserLike, AssetLike, FactoryBuilder, UserLike } from 'test/factories/types.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { newDate, newUuid, newUuidV7 } from 'test/small.factory.js';

export class AlbumFactory {
  #owner!: UserFactory;
  #sharedLinks: Selectable<SharedLinkTable>[] = [];
  #albumUsers: AlbumUserFactory[] = [];
  #assets: AssetFactory[] = [];

  private constructor(private readonly value: Selectable<AlbumTable>) {}

  static create(dto: AlbumLike = {}) {
    return AlbumFactory.from(dto).build();
  }

  static from(dto: AlbumLike = {}) {
    return new AlbumFactory({
      id: newUuid(),
      albumName: 'My Album',
      libraryScope: LibraryScope.Personal,
      albumThumbnailAssetId: null,
      createdAt: newDate(),
      deletedAt: null,
      description: 'Album description',
      isActivityEnabled: false,
      order: AssetOrder.Desc,
      parentId: null,
      icon: null,
      sortOrder: null,
      kind: AlbumKind.Album,
      updatedAt: newDate(),
      updateId: newUuidV7(),
      ...dto,
    }).owner();
  }

  owner(dto: UserLike = {}, builder?: FactoryBuilder<UserFactory>) {
    this.#owner = build(UserFactory.from(dto), builder);
    const userId = this.#owner.build().id;
    this.#albumUsers = this.#albumUsers.filter((factory) => {
      const member = factory.build();
      return member.role !== AlbumUserRole.Owner && member.userId !== userId;
    });
    this.albumUser({ userId, role: AlbumUserRole.Owner });
    return this;
  }

  sharedLinks() {
    this.#sharedLinks = [];
    return this;
  }

  albumUser(dto: AlbumUserLike = {}, builder?: FactoryBuilder<AlbumUserFactory>) {
    const albumUser = build(AlbumUserFactory.from({ albumId: this.value.id, ...dto }), builder);
    this.#albumUsers.push(albumUser);
    return this;
  }

  asset(dto: AssetLike = {}, builder?: FactoryBuilder<AssetFactory>) {
    const asset = build(AssetFactory.from(dto), builder);

    // use album owner by default
    if (!dto.ownerId) {
      asset.owner(this.#owner.build());
    }

    this.#assets.push(asset);

    return this;
  }

  build() {
    return {
      ...this.value,
      assets: this.#assets.map((asset) => asset.build()),
      albumUsers: this.#albumUsers.map((albumUser) => albumUser.build()),
      sharedLinks: this.#sharedLinks,
    };
  }
}
