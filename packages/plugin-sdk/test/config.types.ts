import { WorkflowType } from '@frameleaf/sdk';
import { wrapper } from '../src/sdk.js';

type Manifest = {
  methods: [
    {
      name: 'inspect';
      types: [WorkflowType.AssetV1];
      schema: {
        type: 'object';
        properties: {
          label: { type: 'string' };
          enabled: { type: 'boolean' };
          names: { type: 'string'; array: true };
          mode: { type: 'string'; enum: ['first', 'second'] };
          nested: {
            type: 'object';
            properties: { count: { type: 'number' }; note: { type: 'string' } };
            required: ['count'];
          };
        };
        required: ['label', 'names', 'nested'];
      };
    },
  ];
};

wrapper<Manifest>({
  inspect: ({ config }) => {
    const label: string = config.label;
    const names: string[] = config.names;
    const enabled: boolean | undefined = config.enabled;
    const mode: 'first' | 'second' | undefined = config.mode;
    const count: number = config.nested.count;
    const note: string | undefined = config.nested.note;
    // @ts-expect-error optional values cannot become required
    const required: boolean = config.enabled;
    // @ts-expect-error scalar fields retain their declared types
    const wrong: number = config.label;
    // @ts-expect-error enum values are restricted
    config.mode = 'third';
    // @ts-expect-error nested optional fields stay optional
    const requiredNote: string = config.nested.note;
    return {
      data: {
        label,
        names,
        enabled,
        mode,
        count,
        note,
        required,
        wrong,
        requiredNote,
      },
    };
  },
});
