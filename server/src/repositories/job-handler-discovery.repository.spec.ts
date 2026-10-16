import { ModuleRef, Reflector } from '@nestjs/core';
import { Kysely } from 'kysely';
import { OnJob } from 'src/decorators.js';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { FrameleafStartupError } from 'src/utils/misc.js';

const fixture = () => {
  class Handlers {
    get inaccessible() {
      throw new Error('accessors must not be evaluated');
    }
  }
  const receivers: object[] = [];
  const names = Object.values(JobName);
  for (const [index, name] of names.entries()) {
    const method = `job_${index}`;
    const descriptor = {
      value: function handle(this: object) {
        receivers.push(this);
        return Promise.resolve(JobStatus.Success);
      },
    };
    Object.defineProperty(Handlers.prototype, method, descriptor);
    OnJob({ name, queue: QueueName.ThumbnailGeneration })(Handlers.prototype, method, descriptor);
  }
  let reads = 0;
  const instance = new Proxy(new Handlers(), {
    get(target, key, receiver) {
      if (typeof key === 'string' && key.startsWith('job_')) {
        reads++;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const reflector = new Reflector();
  const repository = new JobRepository(
    { get: (token: unknown) => (token === Reflector ? reflector : instance) } as unknown as ModuleRef,
    {} as ConfigRepository,
    {} as EventRepository,
    { setContext: vi.fn(), verbose: vi.fn(), error: vi.fn() } as unknown as LoggingRepository,
    {} as Kysely<any>,
  );
  return { repository, Handlers, instance, names, receivers, reads: () => reads };
};

describe('job handler discovery', () => {
  it('resolves each declared method once, skips accessors and binds the service receiver', async () => {
    const { repository, Handlers, instance, names, receivers, reads } = fixture();
    repository.setup([Handlers]);
    for (const name of names) {
      const item = repository['handlers'][name]!;
      expect(item.queueName).toBe(QueueName.ThumbnailGeneration);
      await expect(item.handler({ name } as never)).resolves.toBe(JobStatus.Success);
    }
    expect(receivers).toHaveLength(names.length);
    expect(receivers.every((receiver) => receiver === instance)).toBe(true);
    expect(reads()).toBe(names.length);
  });

  it('refuses duplicate job declarations', () => {
    const { repository, Handlers } = fixture();
    expect(() => repository.setup([Handlers, Handlers])).toThrow(FrameleafStartupError);
    expect(() => repository.setup([Handlers])).toThrow('Failed to add job handler for Handlers.handle');
  });

  it('refuses an incomplete handler catalog', () => {
    const { repository, names } = fixture();
    expect(() => repository.setup([])).toThrow(`Failed to find job handler for Job.`);
    expect(repository['handlers'][names[0]]).toBeUndefined();
  });
});
