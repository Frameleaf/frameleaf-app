// The authoritative source is AdminConfig.machineLearning.urls. Endpoint
// capability reports and the persistent video profile have separate APIs.
export function normalizeWorkerUrl(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2048)
    return null;
  try {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function configuredWorkers(values) {
  return String(values.advancedMlUrls ?? "")
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function updateWorkerUrls(values, change) {
  const urls = configuredWorkers(values);
  const original = change.original;
  const index = urls.indexOf(original);
  if (change.kind !== "add" && index < 0)
    throw new Error(
      "This endpoint changed elsewhere. Close this form and review the current list.",
    );
  if (change.kind === "remove") {
    if (urls.length <= 1)
      throw new Error(
        "Keep at least one ML endpoint. Disable machine learning to stop new requests.",
      );
    urls.splice(index, 1);
  } else if (change.kind === "move") {
    const next = index + change.direction;
    if (![-1, 1].includes(change.direction) || next < 0 || next >= urls.length)
      throw new Error("This endpoint cannot move further.");
    [urls[index], urls[next]] = [urls[next], urls[index]];
  } else if (["add", "edit"].includes(change.kind)) {
    const normalized = normalizeWorkerUrl(change.url);
    if (!normalized)
      throw new Error(
        "Enter an HTTP or HTTPS endpoint without a password, query, or fragment.",
      );
    if (
      urls.some(
        (url, i) => i !== index && normalizeWorkerUrl(url) === normalized,
      )
    )
      throw new Error("This endpoint is already listed.");
    if (change.kind === "add") {
      if (urls.length >= 32)
        throw new Error("This page supports up to 32 endpoints.");
      urls.push(normalized);
    } else urls[index] = normalized;
  } else throw new Error("Choose a supported endpoint change.");
  return urls.join("\n");
}

export function workerRequestPreview(url, kind = "ml") {
  const endpoint = normalizeWorkerUrl(url);
  if (!endpoint)
    throw new Error(
      "Correct the endpoint URL before previewing a capability check.",
    );
  return {
    endpoint,
    kind,
    networkRequestSent: false,
    qualified: false,
    capabilities: null,
    availableMemoryBytes: null,
    result:
      "No endpoint was contacted. Model support, GPU memory and availability remain unverified.",
  };
}
