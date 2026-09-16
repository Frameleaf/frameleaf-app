import 'dart:async';

import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/utils/cloud_id_resolver.dart';
import 'package:immich_mobile/domain/utils/migrate_cloud_ids.dart';
import 'package:immich_mobile/infrastructure/repositories/local_album.repository.dart';
import 'package:immich_mobile/platform/native_sync_api.g.dart';
import 'package:mocktail/mocktail.dart';

import '../../service.mocks.dart';
import '../repository_context.dart';

void main() {
  late MediumRepositoryContext ctx;
  late MockNativeSyncApi mockNativeSyncApi;
  late LocalAlbumRepository albumRepository;

  setUp(() {
    debugDefaultTargetPlatformOverride = .iOS;
    ctx = MediumRepositoryContext();
    mockNativeSyncApi = MockNativeSyncApi();
    albumRepository = LocalAlbumRepository(ctx.db);
  });

  tearDown(() async {
    debugDefaultTargetPlatformOverride = null;
    await ctx.dispose();
  });

  Future<List<String?>> readCloudIds() async {
    final rows = await ctx.db.localAssetEntity.select().get();
    return rows.map((row) => row.iCloudId).toList();
  }

  void resolvingAllInputs() {
    when(() => mockNativeSyncApi.getCloudIdForAssetIds(any())).thenAnswer(
      (invocation) async => (invocation.positionalArguments.first as List<String>)
          .map((id) => CloudIdResult(assetId: id, cloudId: 'cloud-$id'))
          .toList(),
    );
  }

  test('maps a duplicate with a cloud ID when the lowest local ID has none', () async {
    final user = await ctx.newUser();
    final remote = await ctx.newRemoteAsset(ownerId: user.id, checksum: 'same-content');
    await ctx.newLocalAsset(id: 'a', checksum: remote.checksum, iCloudIdOption: const .none());
    await ctx.newLocalAsset(id: 'b', checksum: remote.checksum, iCloudId: 'cloud-b');
    await ctx.newLocalAsset(id: 'c', checksum: remote.checksum, iCloudId: 'cloud-c');

    final mappings = await fetchMapping(ctx.db, user.id, 20, null);

    expect(mappings, hasLength(1));
    expect(mappings.single.remoteAssetId, remote.id);
    expect(mappings.single.cloudId, 'cloud-b');
  });

  group('populateCloudIds', () {
    test('writes the cloud ID resolved for each asset', () async {
      await ctx.newLocalAsset(id: 'asset-0', iCloudIdOption: const .none());
      resolvingAllInputs();

      await populateMissingCloudIds(ctx.db, mockNativeSyncApi, .new());
      expect(await readCloudIds(), ['cloud-asset-0']);
    });

    test('skips assets that already have a cloud ID', () async {
      await ctx.newLocalAsset(iCloudId: 'existing');

      await populateMissingCloudIds(ctx.db, mockNativeSyncApi, .new());

      verifyNever(() => mockNativeSyncApi.getCloudIdForAssetIds(any()));
      expect(await readCloudIds(), ['existing']);
    });

    test('does not call the native API when already cancelled', () async {
      await ctx.newLocalAsset(iCloudIdOption: const .none());

      await populateMissingCloudIds(ctx.db, mockNativeSyncApi, .new()..complete());

      verifyNever(() => mockNativeSyncApi.getCloudIdForAssetIds(any()));
      expect(await readCloudIds(), [null]);
    });
  });

  group('resolveCloudIds', () {
    test('resolves and stores more assets than fit in a single chunk', () async {
      final ids = List.generate(kCloudIdChunkSize + 1, (i) => 'asset-$i');
      for (final id in ids) {
        await ctx.newLocalAsset(id: id, iCloudIdOption: const .none());
      }
      resolvingAllInputs();

      await resolveCloudIds(mockNativeSyncApi, albumRepository, ids);

      verify(() => mockNativeSyncApi.getCloudIdForAssetIds(any())).called(2);
      final stored = await ctx.db.localAssetEntity.select().get();
      expect(stored.every((row) => row.iCloudId == 'cloud-${row.id}'), isTrue);
    });

    test('stops after the first chunk when cloud IDs are unsupported', () async {
      final ids = List.generate(kCloudIdChunkSize + 1, (i) => 'asset-$i');
      when(
        () => mockNativeSyncApi.getCloudIdForAssetIds(any()),
      ).thenThrow(PlatformException(code: kUnsupportedOSError));

      await resolveCloudIds(mockNativeSyncApi, albumRepository, ids);

      verify(() => mockNativeSyncApi.getCloudIdForAssetIds(any())).called(1);
    });

    test('stops between chunks once cancelled', () async {
      final ids = List.generate(kCloudIdChunkSize + 1, (i) => 'asset-$i');
      final cancellation = Completer<void>();
      when(() => mockNativeSyncApi.getCloudIdForAssetIds(any())).thenAnswer((invocation) async {
        cancellation.complete();
        return (invocation.positionalArguments.first as List<String>)
            .map((id) => CloudIdResult(assetId: id, cloudId: 'cloud-$id'))
            .toList();
      });

      await resolveCloudIds(mockNativeSyncApi, albumRepository, ids, cancellation: cancellation);

      verify(() => mockNativeSyncApi.getCloudIdForAssetIds(any())).called(1);
    });
  });
}
