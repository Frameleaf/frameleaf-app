// Title fonts of a render-worker claim (render-worker-claim.md, "Fonts"). The server lists each
// bundled family, and each family a project keeps with it (FL-1562), as one `font` resource with
// `files`; this adapter turns them into the faces a worker registers before it draws a title, and
// checks the bytes it fetched against the claim.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const WEIGHTS = [400, 500, 600, 700];
const FILE_LIMIT = 64;
/** A font kept with a project may be 32 MiB (the server's import limit); a bundled file is far smaller. */
const FONT_BYTES_LIMIT = 32 * 1024 * 1024;
/** A font kept with the project: its import id, and the format the server read from its bytes. */
const PROJECT_FILE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(ttf|otf|woff2)$/;
/** The first four bytes of each format. */
const SIGNATURES = { ttf: [0x00010000, 0x74727565], otf: [0x4f54544f], woff2: [0x774f4632] };

/** A bundled file (decoded TrueType, a Latin subset, a catalogue weight) or a project file. */
const validFontFile = (file) => {
  if (file?.subset === "full") {
    const match = typeof file.file === "string" ? PROJECT_FILE.exec(file.file) : null;
    return Boolean(
      match &&
        file.format === match[1] &&
        Number.isInteger(file.weight) &&
        file.weight >= 100 &&
        file.weight <= 900,
    );
  }
  return (
    typeof file?.file === "string" &&
    /^[a-z0-9-]+\.ttf$/.test(file.file) &&
    file.format === "ttf" &&
    WEIGHTS.includes(file.weight) &&
    (file.subset === "latin" || file.subset === "latin-ext")
  );
};

/**
 * The font faces a claim grants: one per file of every `font` resource, each with the input that
 * reads it. A resource without `files` (the shape before bundled families) is one regular face read
 * through the resource's own input. Refuses a claim whose font resources and inputs disagree.
 */
export function deriveClaimFonts(prepared) {
  const resources = prepared?.snapshot?.studio?.resources;
  assert.ok(Array.isArray(resources), "CLAIM_RESOURCES_REQUIRED");
  const inputs = new Map(
    (prepared.inputs ?? []).map((input) => [input.inputId, input]),
  );
  const faces = [];
  const seen = new Set();
  for (const resource of resources) {
    if (resource?.kind !== "font") continue;
    assert.ok(
      typeof resource.key === "string" &&
        typeof resource.id === "string" &&
        resource.id.length > 0 &&
        resource.grant === "render",
      "INVALID_FONT_RESOURCE",
    );
    const face = (inputId, checksum, file, weight, style, subset, format = "ttf") => {
      assert.ok(!seen.has(inputId), "DUPLICATE_FONT_FILE");
      seen.add(inputId);
      const input = inputs.get(inputId);
      assert.ok(
        input && input.kind === "font" && input.resourceId === resource.id,
        "FONT_INPUT_MISSING",
      );
      assert.ok(input.checksum === checksum, "FONT_IDENTITY_CHANGED");
      faces.push({ family: resource.id, weight, style, subset, format, file, inputId, checksum });
    };
    if (resource.files === undefined) {
      face(resource.key, resource.checksum, null, 400, "normal", "latin");
      continue;
    }
    assert.ok(
      Array.isArray(resource.files) &&
        resource.files.length > 0 &&
        resource.files.length <= FILE_LIMIT,
      "INVALID_FONT_FILES",
    );
    for (const file of resource.files) {
      assert.ok(
        validFontFile(file) &&
          file.inputId === `${resource.key}#${file.file}` &&
          (file.style === "normal" || file.style === "italic") &&
          SHA256.test(file.checksum ?? ""),
        "INVALID_FONT_FILE",
      );
      face(file.inputId, file.checksum, file.file, file.weight, file.style, file.subset, file.format);
    }
  }
  return faces;
}

/**
 * The bytes fetched for a face are the file the claim named: its hash, and a font of the format the
 * claim gives (TrueType for a bundled file; TrueType, OpenType or WOFF2 for a project file).
 */
export function verifyFontBytes(face, bytes) {
  assert.ok(
    Buffer.isBuffer(bytes) && bytes.length >= 12 && bytes.length <= FONT_BYTES_LIMIT,
    "FONT_BYTES_REFUSED",
  );
  assert.ok(
    createHash("sha256").update(bytes).digest("hex") === face.checksum,
    "FONT_IDENTITY_CHANGED",
  );
  assert.ok(
    (SIGNATURES[face.format ?? "ttf"] ?? []).includes(bytes.readUInt32BE(0)),
    "FONT_FORMAT_REFUSED",
  );
  return bytes;
}

/**
 * The faces to load for one title style, in fallback order: the family's files of the nearest
 * listed weight and the asked style (normal when the family has no italic), `latin` before
 * `latin-ext`. Empty when the claim does not grant the family: the worker then refuses the title.
 */
export function facesFor(faces, family, weight = 400, style = "normal") {
  const own = faces.filter((face) => face.family === family);
  if (own.length === 0) return [];
  const styled = own.some((face) => face.style === style)
    ? own.filter((face) => face.style === style)
    : own.filter((face) => face.style === "normal");
  const nearest = [...new Set(styled.map((face) => face.weight))].sort(
    (a, b) => Math.abs(a - weight) - Math.abs(b - weight) || a - b,
  )[0];
  return styled
    .filter((face) => face.weight === nearest)
    .sort((a, b) => (a.subset === b.subset ? 0 : a.subset === "latin" ? -1 : 1));
}

/**
 * FL-1562: the weight range a project face is registered with, so a browser draws the family's
 * nearest listed weight of the asked style (the lighter of two equally near), as {@link facesFor}
 * chooses, rather than by its own matching order. `"<low> <high>"` over CSS's 1 to 1000.
 */
export function weightRangeFor(faces, face) {
  const weights = [
    ...new Set(
      faces
        .filter((other) => other.family === face.family && other.style === face.style)
        .map((other) => other.weight),
    ),
  ].sort((a, b) => a - b);
  const index = weights.indexOf(face.weight);
  const low = index === 0 ? 1 : Math.floor((weights[index - 1] + face.weight) / 2) + 1;
  const high = index === weights.length - 1 ? 1000 : Math.floor((face.weight + weights[index + 1]) / 2);
  return `${low} ${high}`;
}
