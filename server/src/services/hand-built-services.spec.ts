import { PROPERTY_DEPS_METADATA } from '@nestjs/common/constants.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MediaHealthRepository } from 'src/repositories/media-health.repository.js';
import { AlbumCleanupService } from 'src/services/album-cleanup.service.js';
import { AlbumDateHealService } from 'src/services/album-date-heal.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { BaseService, HAND_BUILT_DEPENDENCIES } from 'src/services/base.service.js';
import { services } from 'src/services/index.js';
import { WorkflowExecutionService } from 'src/services/workflow-execution.service.js';
import { newTestService } from 'test/utils.js';

type PropertyDependency = { key: string; type: unknown };
const propertyDependencies = (Service: object): PropertyDependency[] =>
  // eslint-disable-next-line unicorn/no-nonstandard-builtin-properties
  Reflect.getMetadata(PROPERTY_DEPS_METADATA, Service) ?? [];

const servicesFolder = fileURLToPath(new URL('.', import.meta.url));
const sources = new Map(
  readdirSync(servicesFolder)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .map((file) => [file, readFileSync(join(servicesFolder, file), 'utf8')]),
);

/**
 * Whether a service needs this property: declared `key!:`, so it is used as if always there. One declared `key?:`
 * (the viewer's file problem flag, an optional database) is checked for where it is used, and may be left out.
 */
const required = (Service: { name: string }, key: string) =>
  sources
    .values()
    .some(
      (source) => source.includes(`export class ${Service.name} `) && new RegExp(String.raw`\b${key}!:`).test(source),
    );

/** Every `BaseService.create(Target, this)` in the services, with the class whose `this` it is built from. */
const handBuilt = () =>
  sources
    .entries()
    .flatMap(([file, source]) => {
      const classes = source
        .matchAll(/export class (\w+)/g)
        .map((match) => ({ name: match[1], at: match.index }))
        .toArray();
      return source.matchAll(/BaseService\.create\((\w+), this\)/g).map((match) => ({
        file,
        builder: classes.findLast(({ at }) => at < match.index)?.name,
        target: match[1],
      }));
    })
    .toArray();

const byName = new Map<string, { name: string }>(services.map((Service) => [Service.name, Service]));

/**
 * FL-1347: a service Nest builds gets its property-injected dependencies (Locked encryption, FL-721) from Nest; one
 * another service builds by hand with `BaseService.create` gets them from that service. So every service that builds
 * another by hand must hold each one the other needs, or the hand-built one goes without and fails where it reaches
 * for it (a workflow write reading back a partner's Locked copy).
 */
describe('services built by hand', () => {
  const found = handBuilt();

  it('are found, AssetService among them', () => {
    expect(found).toEqual(
      expect.arrayContaining([
        { file: 'workflow-execution.service.ts', builder: WorkflowExecutionService.name, target: AssetService.name },
        { file: 'album-date-heal.service.ts', builder: AlbumDateHealService.name, target: AssetService.name },
        { file: 'album-cleanup.service.ts', builder: AlbumCleanupService.name, target: AlbumDateHealService.name },
      ]),
    );
  });

  it.each(found)(
    '$target built in $builder ($file) gets every dependency Nest would give it',
    ({ builder, target }) => {
      const Builder = byName.get(builder ?? '');
      const Target = byName.get(target);
      expect(Builder, `${builder} is a registered service`).toBeDefined();
      expect(Target, `${target} is a registered service`).toBeDefined();
      const held = new Set(propertyDependencies(Builder!).map(({ type }) => type));
      const needed = propertyDependencies(Target!).filter(({ key }) => required(Target!, key));
      expect(needed.filter(({ type }) => !held.has(type)).map(({ key }) => key)).toEqual([]);
      // and each is one `BaseService.create` copies
      expect(needed.filter(({ type }) => !HAND_BUILT_DEPENDENCIES.includes(type)).map(({ key }) => key)).toEqual([]);
    },
  );

  it('carry over the dependencies of the service that builds them', () => {
    const { sut } = newTestService(WorkflowExecutionService);
    const built = BaseService.create(AssetService, sut) as unknown as Record<string, unknown>;

    const dependencies = propertyDependencies(AssetService).filter(({ key }) => required(AssetService, key));
    expect(dependencies.map(({ key }) => key)).toEqual(['lockedEncryption']);
    for (const { key, type } of dependencies) {
      const from = propertyDependencies(WorkflowExecutionService).find((dependency) => dependency.type === type);
      expect(built[key]).toBeDefined();
      expect(built[key]).toBe((sut as unknown as Record<string, unknown>)[from!.key]);
    }
  });

  it('leave the file problem flag off, even when the builder holds its repository', () => {
    // an AssetService Nest made holds both Locked encryption and the flag's repository
    const { sut } = newTestService(AssetService);
    const holder = sut as unknown as Record<string, unknown>;
    expect(holder.mediaHealthRepository).toBeDefined();

    const built = BaseService.create(AssetService, sut) as unknown as Record<string, unknown>;

    expect(built.mediaHealthRepository).toBeUndefined();
    expect(built.lockedEncryption).toBe(holder.lockedEncryption);
    expect(HAND_BUILT_DEPENDENCIES).not.toContain(MediaHealthRepository);
  });
});
