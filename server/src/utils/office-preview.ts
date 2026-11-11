import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { executionSignal } from 'src/utils/execution-signal.js';
import { makeWorkDirFor } from 'src/utils/locked-read.js';
import { ConverterExitError, runConverter } from 'src/utils/still-converters.js';

const filters: Readonly<Record<string, string>> = {
  '.doc': 'writer',
  '.docx': 'writer',
  '.html': 'writer',
  '.key': 'impress',
  '.numbers': 'calc',
  '.pages': 'writer',
  '.txt': 'writer',
  '.potx': 'impress',
  '.ppt': 'impress',
  '.pptx': 'impress',
  '.xls': 'calc',
  '.xlsx': 'calc',
};

export const isOfficePreviewFile = (name: string) => Object.hasOwn(filters, extname(name).toLowerCase());

const LIMIT = 64 * 1024 * 1024;
const profileSettings = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
    <prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>
  </item>
</oor:items>`;

/** Remove only the socket names derived from this disposable LibreOffice profile. */
async function clearOfficeSocket(profileUrl: string) {
  // LibreOffice hashes the UTF-16 profile URL and prints each MD5 byte without padding.
  const hash = Array.from(createHash('md5').update(profileUrl, 'utf16le').digest(), (byte) => byte.toString(16)).join(
    '',
  );
  for (const prefix of ['OSL_PIPE_SingleOfficeIPC_', `OSL_PIPE_${process.getuid?.()}_SingleOfficeIPC_`]) {
    const socket = join('/tmp', prefix + hash);
    if ((await lstat(socket).catch(() => {}))?.isSocket()) {
      await rm(socket, { force: true });
    }
  }
}

/** Convert in a fresh profile with network access and unrelated library files unavailable. */
export async function withOfficePreview<T>(
  source: string,
  name: string,
  usePdf: (path: string) => Promise<T>,
  options: { allPages?: boolean; signal?: AbortSignal } = {},
): Promise<T | undefined> {
  const extension = extname(name).toLowerCase();
  if (!isOfficePreviewFile(name) || process.platform !== 'linux' || (await stat(source)).size > LIMIT) {
    return;
  }
  const signal = options.signal ?? executionSignal();
  signal?.throwIfAborted();
  // A plain copy of a Locked original stays in the Locked temporary folder (tmpfs), never on disk.
  const directory = await makeWorkDirFor(source, 'office');
  const profile = join(directory, 'profile');
  const profileUrl = pathToFileURL(profile).href;
  try {
    const input = join(directory, `source${extension}`);
    const output = join(directory, 'source.pdf');
    await copyFile(source, input);
    await mkdir(join(profile, 'user'), { recursive: true });
    await writeFile(join(profile, 'user', 'registrymodifications.xcu'), profileSettings);
    const pdfOptions = JSON.stringify({
      ...(options.allPages ? {} : { PageRange: { type: 'string', value: '1' } }),
      ExportFormFields: { type: 'boolean', value: 'false' },
    });
    const limit = AbortSignal.timeout(25_000);
    const convert = () =>
      runConverter(
        'setpriv',
        [
          '--no-new-privs',
          '--landlock-access',
          'fs',
          '--landlock-rule',
          'path-beneath:execute,read-file,read-dir:/usr/bin',
          '--landlock-rule',
          'path-beneath:execute,read-file,read-dir:/usr/lib',
          '--landlock-rule',
          'path-beneath:read-file,read-dir:/usr/share/fonts',
          '--landlock-rule',
          'path-beneath:read-file,read-dir:/usr/share/liblangtag',
          '--landlock-rule',
          'path-beneath:read-file,read-dir:/etc/fonts',
          '--landlock-rule',
          'path-beneath:read-file,read-dir:/etc/libreoffice',
          '--landlock-rule',
          'path-beneath:read-file:/etc/ld.so.cache',
          '--landlock-rule',
          'path-beneath:read-file,write-file:/dev/null',
          '--landlock-rule',
          'path-beneath:read-file:/dev/urandom',
          '--landlock-rule',
          'path-beneath:make-sock:/tmp',
          '--landlock-rule',
          `path-beneath:read-file,read-dir,write-file,make-reg,make-dir,make-sock,remove-file,remove-dir,refer,truncate:${directory}`,
          '--seccomp-filter',
          '/usr/local/share/frameleaf/office-network-filter.bpf',
          '/usr/bin/env',
          '-i',
          'PATH=/usr/bin:/bin',
          'LANG=C.UTF-8',
          `HOME=${directory}`,
          `TMPDIR=${directory}`,
          'SAL_USE_VCLPLUGIN=svp',
          '/usr/lib/libreoffice/program/soffice.bin',
          `-env:UserInstallation=${profileUrl}`,
          '--headless',
          '--norestore',
          '--convert-to',
          `pdf:${filters[extension]}_pdf_Export:${pdfOptions}`,
          '--outdir',
          directory,
          input,
        ],
        signal ? AbortSignal.any([signal, limit]) : limit,
        LIMIT,
      );
    try {
      try {
        await convert();
      } catch (error) {
        // A fresh profile can request one restart. The sandbox cannot unlink a socket in /tmp.
        if (!(error instanceof ConverterExitError) || error.exitCode !== 81) {
          throw error;
        }
        await clearOfficeSocket(profileUrl);
        await convert();
      }
      const { size } = await stat(output);
      if (!size || size > LIMIT) {
        return;
      }
    } catch (error) {
      signal?.throwIfAborted();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC' || code === 'EDQUOT') {
        throw error;
      }
      return;
    }
    return await usePdf(output);
  } finally {
    await clearOfficeSocket(profileUrl).finally(() => rm(directory, { recursive: true, force: true }));
  }
}
