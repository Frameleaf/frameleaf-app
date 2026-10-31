import { WorkflowTrigger } from '@frameleaf/plugin-sdk';
import { WorkflowIssueCode, WorkflowType } from 'src/enum.js';
import {
  WORKFLOW_LIMITS,
  WorkflowParameterSchema,
  assertWorkflowJson,
  validateStepConfig,
  workflowIssues,
} from 'src/utils/workflow-definition.js';

describe('workflow definition validation boundaries', () => {
  it.each(['é', '😀'])('limits serialized UTF-8 bytes for %s text', (character) => {
    const value = character.repeat(Math.floor(WORKFLOW_LIMITS.bytes / Buffer.byteLength(character, 'utf8')));
    expect(JSON.stringify(value).length).toBeLessThan(WORKFLOW_LIMITS.bytes);
    expect(() => assertWorkflowJson(value)).toThrow('smaller than 256 KB');
  });

  it('accepts ASCII and Unicode documents at the existing byte limit', () => {
    for (const value of ['a'.repeat(WORKFLOW_LIMITS.bytes - 2), 'é'.repeat((WORKFLOW_LIMITS.bytes - 2) / 2)]) {
      expect(Buffer.byteLength(JSON.stringify(value), 'utf8')).toBe(WORKFLOW_LIMITS.bytes);
      expect(() => assertWorkflowJson(value)).not.toThrow();
    }
  });

  it.each<WorkflowParameterSchema>([
    { type: 'string' },
    { type: 'boolean' },
    { type: 'number' },
    { type: 'integer' },
    { type: 'array', items: { type: 'string' } },
    { type: 'object' },
    { type: 'string', array: true },
    { properties: { name: { type: 'string' } } },
  ])('refuses null for a typed parameter %j', (schema) => {
    expect(validateStepConfig(schema, null)).not.toEqual([]);
  });

  it('reports invalid nested values before a workflow can run', () => {
    const issues = workflowIssues(
      {
        trigger: WorkflowTrigger.AssetCreate,
        steps: [{ id: 'step', method: 'test-plugin#requiredText', config: { url: null }, enabled: true, extra: {} }],
      },
      [
        {
          id: 'method',
          pluginName: 'test-plugin',
          name: 'requiredText',
          types: [WorkflowType.AssetV1],
          schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
        },
      ],
    );
    expect(issues).toEqual([expect.objectContaining({ step: 0, code: WorkflowIssueCode.ConfigInvalid })]);
  });

  it('retains empty schema, nullable choice and valid nested configuration behavior', () => {
    expect(validateStepConfig({}, null)).toEqual([]);
    expect(validateStepConfig({ enum: [null, 'choice'] }, null)).toEqual([]);
    expect(validateStepConfig({ required: ['name'] }, null)).not.toEqual([]);
    expect(
      validateStepConfig(
        { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
        { url: 'example' },
      ),
    ).toEqual([]);
  });
});
