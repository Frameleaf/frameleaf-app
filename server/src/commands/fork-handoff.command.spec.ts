import { ForkHandoffPrepareForkCommand, ForkHandoffPrepareOfficialCommand } from 'src/commands/fork-handoff.command.js';
import { ForkHandoffService } from 'src/services/fork-handoff.service.js';

describe('fork handoff CLI', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prints canonical one-line JSON for official preparation', async () => {
    const checkpoint = {
      officialImage: 'ghcr.io/immich-app/immich-server:v3.1.0',
      id: 'checkpoint-1',
    };
    const service = {
      prepareOfficial: vi.fn().mockResolvedValue(checkpoint),
      sharedLinkPasswordPreflight: vi.fn().mockResolvedValue({ hashed: 0, plaintext: 0 }),
    } as unknown as ForkHandoffService;
    const command = new ForkHandoffPrepareOfficialCommand(service);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await command.run([]);

    expect(output).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith(
      '{"id":"checkpoint-1","officialImage":"ghcr.io/immich-app/immich-server:v3.1.0"}\n',
    );
  });

  it('stops before the checkpoint while password-protected shared links are not acknowledged (FL-161)', async () => {
    const service = {
      prepareOfficial: vi.fn(),
      sharedLinkPasswordPreflight: vi.fn().mockRejectedValue(new Error('2 password-protected shared link(s)')),
    } as unknown as ForkHandoffService;
    const command = new ForkHandoffPrepareOfficialCommand(service);

    await expect(command.run([])).rejects.toThrow('2 password-protected shared link(s)');
    expect(service.sharedLinkPasswordPreflight).toHaveBeenCalledWith({ acknowledgeSharedLinkPasswords: false });
    expect(service.prepareOfficial).not.toHaveBeenCalled();
  });

  it('continues with --acknowledge-shared-link-passwords and says how many links stay locked (FL-161)', async () => {
    const service = {
      prepareOfficial: vi.fn().mockResolvedValue({ id: 'checkpoint-1' }),
      sharedLinkPasswordPreflight: vi.fn().mockResolvedValue({ hashed: 2, plaintext: 1 }),
    } as unknown as ForkHandoffService;
    const command = new ForkHandoffPrepareOfficialCommand(service);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const warning = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await command.run([], { acknowledgeSharedLinkPasswords: command.parseAcknowledgeSharedLinkPasswords() });

    expect(service.prepareOfficial).toHaveBeenCalledWith({ acknowledgeSharedLinkPasswords: true });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('2 password-protected shared link(s) stay locked'));
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('1 other password-protected shared link(s) keep working'),
    );
    expect(output).toHaveBeenCalledWith('{"id":"checkpoint-1"}\n');
  });

  it.each([0, -1, 1.5, NaN, Infinity])(
    'rejects invalid batch size %s before invoking return preparation',
    async (batchSize) => {
      const service = { prepareFork: vi.fn() } as unknown as ForkHandoffService;
      const command = new ForkHandoffPrepareForkCommand(service);

      await expect(command.run([], { batchSize })).rejects.toThrow('Batch size must be a positive integer');
      expect(service.prepareFork).not.toHaveBeenCalled();
    },
  );

  it('rejects positional compatibility aliases before invoking the service', async () => {
    const service = { prepareFork: vi.fn() } as unknown as ForkHandoffService;
    const command = new ForkHandoffPrepareForkCommand(service);

    await expect(command.run(['1'], { batchSize: 1 })).rejects.toThrow('Prepare fork accepts named options only');
    expect(service.prepareFork).not.toHaveBeenCalled();
  });

  it('passes the validated batch size and prints canonical one-line JSON', async () => {
    const report = { supportedTag: 'v3.1.0', active: true, phase: 'active' };
    const service = { prepareFork: vi.fn().mockResolvedValue(report) } as unknown as ForkHandoffService;
    const command = new ForkHandoffPrepareForkCommand(service);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await command.run([], { batchSize: 3 });

    expect(service.prepareFork).toHaveBeenCalledWith({ batchSize: 3 });
    expect(output).toHaveBeenCalledWith('{"active":true,"phase":"active","supportedTag":"v3.1.0"}\n');
  });
});
