import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { MediaRepository } from 'src/repositories/media.repository.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

it.each(['', '\n'])('enforces the packet limit with trailing newline %j', async (ending) => {
  const probe = (records: string) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as never);
    const result = new MediaRepository({ setContext: vi.fn() } as never).probePackets('fixture.mp4', 0, {
      maxPackets: 1,
    });
    child.stdout.write(records);
    child.emit('close', 0);
    return result;
  };
  await expect(probe(`0,1,K_${ending}`)).resolves.toMatchObject({ packetCount: 1, totalDuration: 1 });
  await expect(probe(`0,1,K_\n1,1,__${ending}`)).rejects.toThrow('Media packet probe exceeds its resource limit');
});
