import {
  WorkflowTrigger,
  WorkflowType,
  type PluginMethodResponseDto,
  type WorkflowTriggerResponseDto,
} from '@immich/sdk';
import {
  draftFromDocument,
  draftToCreateDto,
  draftToDocument,
  exportDocument,
  exportDraft,
  findMethod,
  importWorkflowFile,
  parseWorkflowDefinition,
  schemaDefaults,
  updateWorkflowParameter,
  workflowProblems,
  workflowStatus,
  type WorkflowDraft,
} from '$lib/frameleaf/workflows';

const method = (name: string, schema?: Record<string, unknown>, uiHints: string[] = []): PluginMethodResponseDto => ({
  key: `immich-plugin-core#${name}`,
  name,
  title: name,
  description: '',
  types: [WorkflowType.AssetV1],
  uiHints,
  hostFunctions: false,
  allowedHosts: [],
  schema,
});

const methods = [
  method(
    'assetTypeFilter',
    { type: 'object', properties: { allowedTypes: { type: 'string', array: true, enum: ['IMAGE', 'VIDEO'] } } },
    ['Filter'],
  ),
  method('webhook', {
    type: 'object',
    properties: {
      url: { type: 'string', title: 'URL' },
      headerValue: { type: 'string' },
      retries: { type: 'integer', minimum: 0, maximum: 3 },
    },
    required: ['url'],
  }),
];
const triggers: WorkflowTriggerResponseDto[] = [
  { trigger: WorkflowTrigger.AssetCreate, types: [WorkflowType.AssetV1] },
  { trigger: WorkflowTrigger.AssetTagged, types: [WorkflowType.AssetV1] },
];

const imported = {
  name: 'Imported',
  trigger: 'AssetCreate',
  source: 'another-server',
  steps: [
    { method: 'immich-plugin-core#assetTypeFilter', config: { allowedTypes: ['IMAGE'], future: 1 }, note: 'keep' },
    { method: 'third-party#faces', config: { minimum: 2 }, enabled: false },
  ],
};

describe('parseWorkflowDefinition', () => {
  it('requires a trigger and ordered steps with methods', () => {
    expect(() => parseWorkflowDefinition({ steps: [] })).toThrow(/trigger/);
    expect(() => parseWorkflowDefinition({ trigger: 'AssetCreate', steps: [{}] })).toThrow(/method/);
    expect(() =>
      parseWorkflowDefinition({
        trigger: 'AssetCreate',
        steps: Array.from({ length: 101 }, () => ({ method: 'a#b' })),
      }),
    ).toThrow(/100/);
  });

  it('refuses values that are not ordinary JSON and oversized files', () => {
    expect(() => parseWorkflowDefinition({ trigger: 'AssetCreate', steps: [], at: new Date() })).toThrow(
      /ordinary JSON/,
    );
    expect(() => parseWorkflowDefinition('x'.repeat(300_000))).toThrow(/256 KB/);
    expect(() => importWorkflowFile(JSON.stringify(imported), 200_000)).toThrow(/100 KB/);
    expect(() =>
      parseWorkflowDefinition(
        '{"trigger":"AssetCreate","steps":[{"method":"a#b","config":{"nested":{"__proto__":{"token":"probe"}}}}]}',
      ),
    ).toThrow(/prototype keys/);
  });
});

describe('import and export', () => {
  it('keeps unknown methods, parameters and fields through import, JSON editing and export', () => {
    const draft = importWorkflowFile(JSON.stringify({ ...imported, enabled: true }), 500);

    expect(draft.enabled).toBe(false);
    expect(draft.extra).toEqual({ source: 'another-server' });
    expect(draft.steps[0].extra).toEqual({ note: 'keep' });
    expect(draft.steps[1]).toMatchObject({ method: 'third-party#faces', config: { minimum: 2 }, enabled: false });

    const document = draftToDocument(draft);
    expect(draftToDocument(draftFromDocument(JSON.stringify(document)))).toEqual(document);
    expect(document).toMatchObject({
      source: 'another-server',
      steps: [{ note: 'keep', config: { future: 1 } }, { enabled: false }],
    });

    expect(draftToCreateDto(draft)).toMatchObject({
      enabled: false,
      extra: { source: 'another-server' },
      steps: [{ extra: { note: 'keep' } }, { method: 'third-party#faces', enabled: false }],
    });
  });

  it('keeps credentials with explicit step ids when same-method webhooks are reordered in JSON', () => {
    const draft: WorkflowDraft = {
      ...draftFromDocument({ trigger: 'AssetCreate', steps: [] }),
      steps: [
        {
          id: 'id-a',
          method: 'immich-plugin-core#webhook',
          config: { url: 'https://a.test' },
          enabled: true,
          extra: {},
          storedSecrets: ['headerValue'],
        },
        {
          id: 'id-b',
          method: 'immich-plugin-core#webhook',
          config: { url: 'https://b.test' },
          enabled: true,
          extra: {},
          storedSecrets: ['headerValue'],
        },
      ],
    };
    const document = draftToDocument(draft);
    document.steps = [...(document.steps as unknown[])].reverse();
    const edited = draftFromDocument(document, draft);

    expect(edited.steps.map((step) => ({ id: step.id, url: step.config?.url, secrets: step.storedSecrets }))).toEqual([
      { id: 'id-b', url: 'https://b.test', secrets: ['headerValue'] },
      { id: 'id-a', url: 'https://a.test', secrets: ['headerValue'] },
    ]);
    expect(draftToCreateDto(edited).steps?.map((step) => step.id)).toEqual(['id-b', 'id-a']);
    expect((exportDraft(edited).steps as Record<string, unknown>[]).every((step) => !('id' in step))).toBe(true);

    const withoutId = {
      ...document,
      steps: (document.steps as Record<string, unknown>[]).map(({ id: _, ...step }) => step),
    };
    expect(draftFromDocument(withoutId, draft).steps.every((step) => !step.id && step.storedSecrets.length === 0)).toBe(
      true,
    );
    const changedDestination = {
      ...document,
      steps: [
        { ...(document.steps as Record<string, unknown>[])[0], config: { url: 'https://other.test' } },
        (document.steps as Record<string, unknown>[])[1],
      ],
    };
    expect(draftFromDocument(changedDestination, draft).steps[0]).toMatchObject({ id: undefined, storedSecrets: [] });
  });

  it('never exports a credential typed into the draft', () => {
    const draft = draftFromDocument({
      trigger: 'AssetCreate',
      enabled: true,
      steps: [
        { method: 'immich-plugin-core#webhook', config: { url: 'https://h.test', headerValue: 'Bearer s3cret' } },
      ],
    });
    const exported = exportDraft(draft);
    expect(JSON.stringify(exported)).not.toContain('s3cret');
    expect(exported).not.toHaveProperty('enabled');
  });

  it('builds the portable file from the server export with every additional field', () => {
    expect(
      exportDocument({
        name: 'W',
        description: null,
        trigger: 'AssetCreate',
        extra: { source: 'x' },
        steps: [{ method: 'a#b', config: null, enabled: false, extra: { note: 1 } }],
      }),
    ).toEqual({
      source: 'x',
      name: 'W',
      description: null,
      trigger: 'AssetCreate',
      steps: [{ note: 1, method: 'a#b', config: null, enabled: false }],
    });
  });
});

describe('workflowProblems', () => {
  const draft = (steps: WorkflowDraft['steps'], trigger = 'AssetCreate') => ({ trigger, steps });
  const step = (methodKey: string, config: Record<string, unknown> | null, storedSecrets: string[] = []) => ({
    method: methodKey,
    config,
    enabled: true,
    extra: {},
    storedSecrets,
  });

  it('reports an unavailable trigger instead of inventing a schedule', () => {
    expect(workflowProblems(draft([], 'Schedule'), methods, triggers)).toEqual([
      { message: expect.stringContaining('Scheduled workflows are not supported') },
    ]);
  });

  it('reports an unknown method and keeps checking the other steps', () => {
    expect(
      workflowProblems(
        draft([step('third-party#faces', {}), step('immich-plugin-core#webhook', {})]),
        methods,
        triggers,
      ),
    ).toEqual([
      { step: 0, message: 'Step 1: this plugin method is unavailable. Its definition is retained.' },
      { step: 1, message: 'Step 2: URL is required.' },
    ]);
  });

  it('follows the installed schema when it changes', () => {
    const config = { url: 'https://h.test', retries: 5 };
    expect(workflowProblems(draft([step('immich-plugin-core#webhook', config)]), methods, triggers)).toEqual([
      { step: 0, message: expect.stringContaining('outside the allowed range') },
    ]);
    const relaxed = [method('webhook', { type: 'object', properties: { url: { type: 'string' } } })];
    expect(workflowProblems(draft([step('immich-plugin-core#webhook', config)]), relaxed, triggers)).toEqual([]);
  });

  it('counts a stored credential as present', () => {
    const schema = { type: 'object', properties: { headerValue: { type: 'string' } }, required: ['headerValue'] };
    const secretMethods = [method('webhook', schema)];
    expect(
      workflowProblems(draft([step('immich-plugin-core#webhook', {}, ['headerValue'])]), secretMethods, triggers),
    ).toEqual([]);
    expect(workflowProblems(draft([step('immich-plugin-core#webhook', {})]), secretMethods, triggers)).toHaveLength(1);
  });

  it('finds versioned method names', () => {
    expect(findMethod(methods, 'immich-plugin-core@2.0.1#webhook')?.name).toBe('webhook');
  });
});

describe('parameters', () => {
  it('changes one parameter and keeps every other field', () => {
    expect(updateWorkflowParameter({ a: 1, nested: { b: 2, c: 3 } }, ['nested', 'b'], 5)).toEqual({
      a: 1,
      nested: { b: 5, c: 3 },
    });
    expect(updateWorkflowParameter({ a: 1, b: 2 }, ['b'], undefined)).toEqual({ a: 1 });
    expect(() => updateWorkflowParameter({}, ['__proto__', 'x'], 1)).toThrow();
  });

  it('starts a new step from the schema defaults', () => {
    expect(
      schemaDefaults({
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string', enum: ['POST', 'GET'] },
          optional: { type: 'string' },
        },
        required: ['url', 'method'],
      }),
    ).toEqual({ url: '', method: 'POST' });
  });
});

describe('workflowStatus', () => {
  it('separates enabled, blocked and paused', () => {
    expect(workflowStatus({ enabled: true, issues: [] })).toBe('enabled');
    expect(workflowStatus({ enabled: true, issues: [{ code: 'method_unavailable' as never, message: '' }] })).toBe(
      'blocked',
    );
    expect(workflowStatus({ enabled: false, issues: [] })).toBe('paused');
  });
});
