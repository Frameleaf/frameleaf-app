export function probeGpu(ffmpeg, accelerator, run) {
  const output = run(ffmpeg, ['-hide_banner', '-hwaccels']);
  const available = output.split(/\r?\n/).map((line) => line.trim());
  return {
    name: 'gpu accelerator inventory',
    ok: available.includes(accelerator),
    detail: available.includes(accelerator)
      ? `${accelerator} advertised; actual GPU float processing remains unqualified`
      : `${accelerator} not advertised`,
  };
}
