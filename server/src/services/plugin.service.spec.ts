import { WorkflowTrigger } from '@frameleaf/plugin-sdk';
import { PluginService } from 'src/services/plugin.service.js';
import { newTestService } from 'test/utils.js';

it('keeps new automation templates out of the legacy closed-enum endpoint', async () => {
  const { sut, mocks } = newTestService(PluginService);
  mocks.plugin.search.mockResolvedValue([
    {
      name: 'sample',
      templates: Object.values(WorkflowTrigger).map((trigger) => ({
        name: trigger,
        title: trigger,
        description: '',
        trigger,
        steps: [],
      })),
    },
  ] as never);
  expect((await sut.searchTemplates()).map(({ trigger }) => trigger)).toEqual([
    WorkflowTrigger.AssetCreate,
    WorkflowTrigger.AssetMetadataExtraction,
    WorkflowTrigger.AssetTagged,
  ]);
});
