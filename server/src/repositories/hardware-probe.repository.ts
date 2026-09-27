import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { access, constants, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import type { HostFacts, HostGpu, RenderNode, ServerHardwareFacts, TestTranscode } from 'src/utils/hardware-check.js';
import { isIntegratedGpu, testEncoderFor } from 'src/utils/hardware-check.js';

const run = promisify(execFile);
const PCI_VENDORS: Record<string, string> = { '0x10de': 'NVIDIA', '0x1002': 'AMD', '0x8086': 'Intel' };
/** Seconds of 1080p test video a test transcode encodes. */
const TEST_SECONDS = 4;

/** `major:minor` of a Linux device number, as /sys/dev/char names it. */
const deviceNumber = (rdev: number) => {
  const major = Math.floor(rdev / 256) & 0xf_ff;
  const minor = (rdev & 0xff) | (Math.floor(rdev / 4096) & 0xf_ff_00);
  return `${major}:${minor}`;
};

const firstLine = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 300) ?? null;

/**
 * Reads this (server) container's GPU for Hardware & GPU (FL-159): the NVIDIA card through
 * nvidia-smi, the render nodes passed in and whether they open, the encoders ffmpeg has, and a
 * short test transcode. Everything is read inside the container; nothing is guessed about the host.
 */
@Injectable()
export class HardwareProbeRepository {
  async readServer(): Promise<ServerHardwareFacts> {
    const [nvidia, renderNodes, encoders, nvidiaDevice, host] = await Promise.all([
      this.nvidiaSmi(),
      this.renderNodes(),
      this.encoders(),
      this.exists('/dev/nvidiactl'),
      this.readHost(),
    ]);
    const facts: ServerHardwareFacts = {
      nvidia: nvidia.gpu,
      nvidiaError: nvidia.error,
      nvidiaRequested: !!process.env.NVIDIA_VISIBLE_DEVICES,
      nvidiaDevice,
      renderNodes,
      encoders,
      test: null,
      host,
    };
    facts.test = await this.testTranscode(facts);
    return facts;
  }

  /**
   * Runs `use` with a test photo (a generated 1280×960 still, nothing from the library) and removes
   * it afterwards, for the description benchmark.
   */
  async withTestImage<T>(use: (path: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'frameleaf-benchmark-'));
    const path = join(directory, 'test.jpg');
    try {
      await run(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x960', '-frames:v', '1', path],
        { timeout: 30_000 },
      );
      return await use(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /** A short test transcode on the best encoder here, falling back to the processor if it fails. */
  async testTranscode(facts: Pick<ServerHardwareFacts, 'nvidia' | 'renderNodes' | 'encoders'>): Promise<TestTranscode> {
    const choice = testEncoderFor(facts);
    const attempt = await this.encode(choice.encoder, choice.node);
    if (attempt.speed !== null || choice.encoder === 'libx264') {
      return { encoder: choice.encoder, gpu: choice.encoder !== 'libx264', ...attempt };
    }
    const fallback = await this.encode('libx264', null);
    return { encoder: 'libx264', gpu: false, speed: fallback.speed, error: attempt.error };
  }

  private async encode(encoder: string, node: string | null): Promise<{ speed: number | null; error: string | null }> {
    const hardware =
      encoder === 'h264_vaapi' && node
        ? ['-init_hw_device', `vaapi=va:${node}`, '-filter_hw_device', 'va', '-vf', 'format=nv12,hwupload']
        : [];
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=1920x1080:rate=30:duration=${TEST_SECONDS}`,
      ...hardware,
      '-c:v',
      encoder,
      '-f',
      'null',
      '-',
    ];
    const started = performance.now();
    try {
      await run('ffmpeg', args, { timeout: 60_000 });
      const seconds = (performance.now() - started) / 1000;
      return { speed: Math.round((TEST_SECONDS / Math.max(seconds, 0.01)) * 10) / 10, error: null };
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? (error as Error).message;
      return { speed: null, error: firstLine(stderr) };
    }
  }

  private async nvidiaSmi(): Promise<{ gpu: ServerHardwareFacts['nvidia']; error: string | null }> {
    try {
      const { stdout } = await run(
        'nvidia-smi',
        ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'],
        { timeout: 5000 },
      );
      const [name, memory, driver] = (firstLine(stdout) ?? '').split(',').map((part) => part.trim());
      if (!name || !driver) {
        return { gpu: null, error: firstLine(stdout) };
      }
      const mib = Number(memory);
      return {
        gpu: { name, memoryTotalBytes: Number.isFinite(mib) ? mib * 1024 * 1024 : null, driver: `Driver ${driver}` },
        error: null,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { gpu: null, error: null };
      }
      const stderr = (error as { stderr?: string }).stderr ?? (error as Error).message;
      return { gpu: null, error: firstLine(stderr) };
    }
  }

  private async renderNodes(): Promise<RenderNode[]> {
    let entries: string[];
    try {
      entries = (await readdir('/dev/dri')).filter((entry) => entry.startsWith('renderD')).toSorted();
    } catch {
      return [];
    }
    return Promise.all(
      entries.map(async (node) => {
        const device = join('/sys/class/drm', node, 'device');
        const vendor = await readFile(join(device, 'vendor'), 'utf8')
          .then((value) => PCI_VENDORS[value.trim()] ?? null)
          .catch(() => null);
        const memoryTotalBytes = await readFile(join(device, 'mem_info_vram_total'), 'utf8')
          .then((value) => Number(value.trim()) || null)
          .catch(() => null);
        const path = join('/dev/dri', node);
        const accessible = await access(path, constants.R_OK | constants.W_OK)
          .then(() => true)
          .catch(() => false);
        const info = await stat(path).catch(() => null);
        // The host node this is, by device number: names inside can differ from the host's.
        const hostNode = info
          ? await realpath(`/sys/dev/char/${deviceNumber(info.rdev)}`)
              .then((target) => basename(target))
              .catch(() => null)
          : null;
        return { node, vendor, accessible, memoryTotalBytes, gid: info?.gid ?? null, hostNode };
      }),
    );
  }

  /**
   * What this container can read about the host: the kernel (WSL2, Docker Desktop, Unraid), every
   * GPU in the host's PCI list (sysfs shows the host's devices, not only the ones passed in), the
   * WSL2 GPU device and the groups this process runs with.
   */
  async readHost(): Promise<HostFacts> {
    const [kernel, gpus, dxg] = await Promise.all([
      readFile('/proc/sys/kernel/osrelease', 'utf8')
        .then((value) => value.trim() || null)
        .catch(() => null),
      this.hostGpus(),
      this.exists('/dev/dxg'),
    ]);
    // Supplementary groups do not always include the primary one.
    const groups = new Set([...(process.getgroups?.() ?? []), ...(process.getegid ? [process.getegid()] : [])]);
    return { kernel, gpus, dxg, groups: [...groups].toSorted((a, b) => a - b), root: process.geteuid?.() === 0 };
  }

  private async hostGpus(): Promise<HostGpu[] | null> {
    const root = '/sys/bus/pci/devices';
    let addresses: string[];
    try {
      addresses = (await readdir(root)).toSorted();
    } catch {
      return null;
    }
    const read = (path: string) =>
      readFile(path, 'utf8')
        .then((value) => value.trim())
        .catch(() => null);
    const gpus = await Promise.all(
      addresses.map(async (pciAddress): Promise<HostGpu | null> => {
        const device = join(root, pciAddress);
        // PCI class 0x03xxxx: display controllers (VGA, 3D, other).
        if (!(await read(join(device, 'class')))?.startsWith('0x03')) {
          return null;
        }
        const vendor = PCI_VENDORS[(await read(join(device, 'vendor'))) ?? ''];
        if (!vendor) {
          return null;
        }
        const memoryTotalBytes = Number(await read(join(device, 'mem_info_vram_total'))) || null;
        const renderNode =
          (await readdir(join(device, 'drm')).catch(() => [] as string[])).find((entry) =>
            entry.startsWith('renderD'),
          ) ?? null;
        return {
          pciAddress,
          vendor,
          renderNode,
          integrated: isIntegratedGpu(vendor, pciAddress, memoryTotalBytes),
          memoryTotalBytes,
        };
      }),
    );
    return gpus.filter((gpu): gpu is HostGpu => gpu !== null);
  }

  private async encoders(): Promise<string[]> {
    try {
      const { stdout } = await run('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 10_000 });
      return stdout
        .matchAll(/^\s*V\S*\s+(\S+)/gm)
        .map((match) => match[1])
        .toArray();
    } catch {
      return [];
    }
  }

  private exists(path: string) {
    return stat(path)
      .then(() => true)
      .catch(() => false);
  }
}
