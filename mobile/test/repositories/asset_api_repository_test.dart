import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/repositories/asset_api.repository.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

class _MockAssetsApi extends Mock implements AssetsApi {}

class _MockStacksApi extends Mock implements StacksApi {}

class _MockTrashApi extends Mock implements TrashApi {}

void main() {
  late _MockAssetsApi api;
  late AssetApiRepository repo;

  setUpAll(() {
    registerFallbackValue(AssetImageEnrichmentActionRequestDto(action: AssetImageEnrichmentAction.markNsfw));
  });

  setUp(() {
    api = _MockAssetsApi();
    repo = AssetApiRepository(api, _MockStacksApi(), _MockTrashApi());
  });

  for (final action in [AssetImageEnrichmentAction.markNsfw, AssetImageEnrichmentAction.markSafe]) {
    test('$action preserves successful assets when another request fails', () async {
      final ids = List.generate(18, (index) => 'asset-$index');
      when(() => api.updateAssetImageEnrichment(any(), any())).thenAnswer((invocation) async {
        final id = invocation.positionalArguments[0] as String;
        final dto = invocation.positionalArguments[1] as AssetImageEnrichmentActionRequestDto;
        expect(dto.action, action);
        if (id == 'asset-1') {
          throw Exception('request failed');
        }
        return null;
      });

      final result = action == AssetImageEnrichmentAction.markNsfw
          ? await repo.markNsfw(ids)
          : await repo.markSafe(ids);

      expect(result.succeeded, ids.where((id) => id != 'asset-1'));
      expect(result.failed, ['asset-1']);
      expect(result.total, 18);
      expect(result.anyFailed, isTrue);
      expect(result.allSucceeded, isFalse);
      verify(() => api.updateAssetImageEnrichment(any(), any())).called(18);
    });
  }

  test('empty selection sends no requests and does not report success', () async {
    final result = await repo.markSafe([]);

    expect(result.total, 0);
    expect(result.allSucceeded, isFalse);
    expect(result.anyFailed, isFalse);
    verifyZeroInteractions(api);
  });
}
