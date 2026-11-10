import { type FrameleafEventTrigger, WorkflowTrigger } from '@frameleaf/plugin-sdk';
import { WorkflowType } from 'src/enum.js';
import { PluginMethodSearchResponse } from 'src/repositories/plugin.repository.js';
import { FRAMELEAF_EVENTS, isFrameleafEventTrigger } from 'src/utils/workflow-event.js';

export const triggerMap: Record<WorkflowTrigger, WorkflowType[]> = {
  [WorkflowTrigger.AssetCreate]: [WorkflowType.AssetV1],
  [WorkflowTrigger.AssetChanged]: [WorkflowType.AssetV1],
  [WorkflowTrigger.Schedule]: [WorkflowType.AssetV1],
  // [WorkflowTrigger.PersonRecognized]: [WorkflowType.AssetPersonV1],
  [WorkflowTrigger.AssetMetadataExtraction]: [WorkflowType.AssetV1],
  [WorkflowTrigger.AssetTagged]: [WorkflowType.AssetV1],
  // FL-819: Frameleaf events
  [WorkflowTrigger.StudioExportCompleted]: [WorkflowType.EventV1],
  [WorkflowTrigger.CloudBackupCompleted]: [WorkflowType.EventV1],
  [WorkflowTrigger.CloudBackupFailed]: [WorkflowType.EventV1],
  [WorkflowTrigger.ClientsGalleryApproved]: [WorkflowType.EventV1],
  [WorkflowTrigger.CloudJobCompleted]: [WorkflowType.EventV1],
};

/** The triggers for photos and videos, as the published `WorkflowTrigger` enum lists them. */
export const getWorkflowTriggers = () =>
  Object.entries(triggerMap)
    .filter(([trigger]) => !isFrameleafEventTrigger(trigger))
    .map(([trigger, types]) => ({ trigger: trigger as Exclude<WorkflowTrigger, FrameleafEventTrigger>, types }));

/** FL-819: the Frameleaf event triggers, listed apart so older apps never meet an unknown trigger. */
export const getFrameleafEventTriggers = () =>
  Object.keys(triggerMap)
    .filter((trigger) => isFrameleafEventTrigger(trigger))
    .map((trigger) => ({ trigger, event: FRAMELEAF_EVENTS[trigger as FrameleafEventTrigger].event }));

/** some types extend other types and have implied compatibility */
const inferredMap: Record<WorkflowType, WorkflowType[]> = {
  [WorkflowType.AssetV1]: [],
  [WorkflowType.EventV1]: [],
  // [WorkflowType.AssetPersonV1]: [WorkflowType.AssetV1],
};

const withImpliedItems = (type: WorkflowType): WorkflowType[] => {
  const childTypes = inferredMap[type];
  const results = [type];
  for (const child of childTypes) {
    results.push(...withImpliedItems(child));
  }

  return results;
};

export const isMethodCompatible = (pluginMethod: { types: WorkflowType[] }, trigger: WorkflowTrigger) => {
  const validTypes = triggerMap[trigger];
  const pluginCompatibility = pluginMethod.types.map((type) => withImpliedItems(type));
  for (const requested of validTypes) {
    for (const pluginCompatibilityGroup of pluginCompatibility) {
      if (pluginCompatibilityGroup.includes(requested)) {
        return true;
      }
    }
  }

  return false;
};

export const resolveMethod = (methods: PluginMethodSearchResponse[], method: string) => {
  const result = parseMethodString(method);
  if (!result) {
    return;
  }

  const { pluginName, methodName } = result;

  return methods.find((method) => method.pluginName === pluginName && method.name === methodName);
};

export const asPluginKey = (method: { pluginName: string; name: string }) => {
  return `${method.pluginName}#${method.name}`;
};

const METHOD_REGEX = /^(?<name>[^@#\s]+)(?:@(?<version>[^#\s]*))?#(?<method>[^@#\s]+)$/;
export const parseMethodString = (method: string) => {
  const matches = METHOD_REGEX.exec(method);
  if (!matches) {
    return;
  }

  const pluginName = matches.groups?.name;
  const version = matches.groups?.version;
  const methodName = matches.groups?.method;
  return { pluginName, version, methodName };
};
