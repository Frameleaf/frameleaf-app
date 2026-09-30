// Fictional decoder and job state for the universal RAW design reference.
export const sampleRawFiles = [
  {
    id: "raw-01",
    name: "IMG_4821.CR3",
    camera: "Canon EOS R5",
    format: "CR3 · C-RAW",
    dimensions: "8192 × 5464",
    image: "/media/portrait.png",
    status: "ready",
    source: "Sensor render",
    pair: "IMG_4821.JPG",
  },
  {
    id: "raw-02",
    name: "DSC_2108.NEF",
    camera: "Nikon Z8",
    format: "NEF · High efficiency",
    dimensions: "8256 × 5504",
    image: "/media/hiking.png",
    status: "preview",
    source: "Embedded camera preview",
    pair: "DSC_2108.JPG",
  },
  {
    id: "raw-03",
    name: "DSC04219.ARW",
    camera: "Sony α7R V",
    format: "ARW · Lossless compressed",
    dimensions: "9504 × 6336",
    image: "/media/lake.png",
    status: "timeout",
    source: "Embedded camera preview",
  },
  {
    id: "raw-04",
    name: "DSCF8142.RAF",
    camera: "Fujifilm X-T5",
    format: "RAF · Compression variant",
    dimensions: "7728 × 5152",
    image: "/media/flowers.png",
    status: "unsupported",
    source: "Embedded camera preview",
  },
  {
    id: "raw-05",
    name: "IMG_1024.DNG",
    camera: "Apple iPhone 16 Pro",
    format: "DNG · Apple ProRAW",
    dimensions: "8064 × 6048",
    image: "/media/cabin.png",
    status: "damaged",
    source: "Preview unavailable",
  },
  {
    id: "raw-06",
    name: "P9163042.ORF",
    camera: "OM System OM-1",
    format: "ORF",
    dimensions: "5184 × 3888",
    image: "/media/summit.png",
    status: "dependency",
    source: "Embedded camera preview",
  },
];
export const rawStatus = {
  ready: {
    label: "Ready",
    detail: "Full-resolution sensor render available.",
    action: null,
  },
  preview: {
    label: "Preview only",
    detail:
      "A fast camera preview is available. Generate a sensor render for full-resolution viewing.",
    action: "Generate render",
  },
  timeout: {
    label: "Render timed out",
    detail: "The decoder took too long. Retry with fewer concurrent jobs.",
    action: "Retry render",
  },
  unsupported: {
    label: "Unsupported mode",
    detail:
      "This compression mode needs a compatible decoder. Your original is preserved.",
    action: "View capability",
  },
  damaged: {
    label: "File needs attention",
    detail:
      "The sample file could not be read. Verify the source or restore from a known good copy.",
    action: "View details",
  },
  dependency: {
    label: "Decoder unavailable",
    detail:
      "The local decoder is missing. Check the instance’s media dependencies, then retry.",
    action: "View details",
  },
};
export const repairableRawIds = (files) =>
  files
    .filter((file) => ["preview", "timeout"].includes(file.status))
    .map((file) => file.id);
export const advanceRawRepair = (job) =>
  job?.status !== "running"
    ? job
    : {
        ...job,
        completed: Math.min(job.total, job.completed + 1),
        repairedIds: [
          ...new Set([
            ...(job.repairedIds || []),
            ...(job.ids || []).slice(0, job.completed + 1),
          ]),
        ],
        status: job.completed + 1 >= job.total ? "complete" : "running",
      };
export const repairRawFiles = (files, ids) =>
  files.map((file) =>
    ids.includes(file.id) && ["preview", "timeout"].includes(file.status)
      ? { ...file, status: "ready", source: "Sensor render" }
      : file,
  );
