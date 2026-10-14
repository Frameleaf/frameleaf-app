import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  deriveClaimFonts,
  facesFor,
  verifyFontBytes,
} from "./render-worker-font-inputs.mjs";

const fontDirectory = new URL("../../server/resources/studio-fonts/", import.meta.url);
const read = (file) => readFileSync(new URL(file, fontDirectory));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const file = (name, weight, style, subset) => ({
  inputId: `font:Anton#${name}`,
  file: name,
  weight,
  style,
  subset,
  format: "ttf",
  checksum: sha(read(name)),
});
const claim = () => {
  const files = [
    file("anton-latin-400-normal.ttf", 400, "normal", "latin"),
    file("anton-latin-ext-400-normal.ttf", 400, "normal", "latin-ext"),
  ];
  return {
    snapshot: {
      studio: {
        resources: [
          { key: "library-asset:clip-1", kind: "library-asset", id: "clip-1", grant: "render", checksum: "x" },
          { key: "font:Anton", kind: "font", id: "Anton", grant: "render", checksum: files[0].checksum, files },
        ],
      },
    },
    inputs: [
      { inputId: "font:Anton", kind: "font", resourceId: "Anton", checksum: files[0].checksum },
      ...files.map((entry) => ({ inputId: entry.inputId, kind: "font", resourceId: "Anton", checksum: entry.checksum })),
    ],
  };
};

test("a font resource with files gives one face per file, bound to its input", () => {
  const faces = deriveClaimFonts(claim());
  assert.deepEqual(
    faces.map((face) => [face.family, face.weight, face.style, face.subset, face.inputId]),
    [
      ["Anton", 400, "normal", "latin", "font:Anton#anton-latin-400-normal.ttf"],
      ["Anton", 400, "normal", "latin-ext", "font:Anton#anton-latin-ext-400-normal.ttf"],
    ],
  );
  for (const face of faces) assert.equal(verifyFontBytes(face, read(face.file)).length > 0, true);
});

test("a font resource of the old one-file shape is one regular face read through its own input", () => {
  const prepared = claim();
  delete prepared.snapshot.studio.resources[1].files;
  prepared.inputs = prepared.inputs.slice(0, 1);
  assert.deepEqual(deriveClaimFonts(prepared), [
    {
      family: "Anton",
      weight: 400,
      style: "normal",
      subset: "latin",
      file: null,
      inputId: "font:Anton",
      checksum: prepared.inputs[0].checksum,
    },
  ]);
});

test("a claim whose font files and inputs disagree is refused", () => {
  const cases = [
    ["FONT_INPUT_MISSING", (prepared) => prepared.inputs.pop()],
    ["FONT_IDENTITY_CHANGED", (prepared) => (prepared.inputs[1].checksum = "0".repeat(64))],
    ["INVALID_FONT_FILE", (prepared) => (prepared.snapshot.studio.resources[1].files[0].inputId = "font:Anton#../x.ttf")],
    ["INVALID_FONT_FILE", (prepared) => (prepared.snapshot.studio.resources[1].files[0].file = "../anton.ttf")],
    ["INVALID_FONT_FILE", (prepared) => (prepared.snapshot.studio.resources[1].files[0].format = "woff2")],
    ["INVALID_FONT_FILE", (prepared) => (prepared.snapshot.studio.resources[1].files[0].weight = 450)],
    ["INVALID_FONT_FILES", (prepared) => (prepared.snapshot.studio.resources[1].files = [])],
    ["DUPLICATE_FONT_FILE", (prepared) => prepared.snapshot.studio.resources[1].files.push(prepared.snapshot.studio.resources[1].files[0])],
    ["INVALID_FONT_RESOURCE", (prepared) => (prepared.snapshot.studio.resources[1].grant = "none")],
  ];
  for (const [message, change] of cases) {
    const prepared = claim();
    change(prepared);
    assert.throws(() => deriveClaimFonts(prepared), { message }, message);
  }
});

test("fetched bytes must be the named TrueType file", () => {
  const [face] = deriveClaimFonts(claim());
  const bytes = read(face.file);
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] ^= 1;
  assert.throws(() => verifyFontBytes(face, changed), { message: "FONT_IDENTITY_CHANGED" });
  const woff2 = Buffer.from("wOF2 not a font at all");
  assert.throws(() => verifyFontBytes({ ...face, checksum: sha(woff2) }, woff2), { message: "FONT_FORMAT_REFUSED" });
  assert.throws(() => verifyFontBytes(face, Buffer.alloc(4)), { message: "FONT_BYTES_REFUSED" });
});

test("faces for a title: nearest weight, asked style or normal, latin before latin-ext", () => {
  const face = (weight, style, subset) => ({ family: "Inter", weight, style, subset });
  const faces = [
    face(400, "normal", "latin-ext"),
    face(400, "normal", "latin"),
    face(700, "normal", "latin"),
    face(700, "italic", "latin"),
    { ...face(400, "normal", "latin"), family: "Anton" },
  ];
  assert.deepEqual(facesFor(faces, "Inter", 400), [faces[1], faces[0]]);
  assert.deepEqual(facesFor(faces, "Inter", 600), [faces[2]]);
  assert.deepEqual(facesFor(faces, "Inter", 500), [faces[1], faces[0]]);
  assert.deepEqual(facesFor(faces, "Inter", 700, "italic"), [faces[3]]);
  assert.deepEqual(facesFor(faces, "Anton", 700, "italic"), [faces[4]]);
  assert.deepEqual(facesFor(faces, "Roboto"), []);
});
