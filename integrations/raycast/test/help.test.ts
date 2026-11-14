import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const LANGUAGES = ["en", "da", "de", "es", "fr", "it", "nb_NO", "nl", "pl", "pt", "sv"];

test("help ships in all eleven Frameleaf languages with the same facts", async () => {
  const texts = await Promise.all(
    LANGUAGES.map((language) => readFile(join(process.cwd(), "help", `${language}.md`), "utf8")),
  );
  assert.equal(new Set(texts).size, LANGUAGES.length);
  for (const [index, text] of texts.entries()) {
    for (const fact of [
      "https://photos.example.com",
      "http://192.168.1.20:2283",
      "https://raycast.com/redirect?packageName=Extension",
      "Frameleaf Cloud",
      "**Original downloads**",
      "**Allow Original Downloads**",
      "**Disconnect Library**",
    ]) {
      assert.ok(text.includes(fact), `${LANGUAGES[index]}: ${fact}`);
    }
  }
});
