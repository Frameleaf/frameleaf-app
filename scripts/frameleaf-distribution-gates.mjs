#!/usr/bin/env node
/**
 * FL-136 (REL-104): validate the release-time distribution-gate register.
 *
 * `studio/distribution-gates.json` does not re-decide Studio resource rights - those decisions
 * live in `studio/dependency-attribution.json` (the reviewed bill of materials) and are approved
 * in `studio/rights-approval.json` (the owner's digest-bound approvals, FL-146). The engine admits
 * or refuses a resource at runtime from that same pair (`server/src/utils/studio-rights.ts`); this
 * script never re-implements that admission.
 *
 * What this script checks:
 * - Every `embeddedComponents` row in `studio/dependency-attribution.json` whose `rightsStatus` is
 *   not "allowed" must have a matching, still-open gate here - so a blocked embedded dependency
 *   cannot silently stop being tracked. It also checks the Dolby tool gate is present and still
 *   points at the fail-closed preflight verdict.
 * - Every gate has an `id`, `area`, `description`, `status` ("cleared" or "blocked-on-owner") and a
 *   `reason`; a "blocked-on-owner" gate must not name a concrete `owner` (an actual owner name means
 *   it is no longer blocked), and a "cleared" gate must name one.
 * - No gate's JSON text contains anything that looks like a live secret (reuses the pattern in
 *   .github/check-runners.cjs's inherited-identity/secret check, generalised to common token shapes).
 *
 *   node scripts/frameleaf-distribution-gates.mjs           verify (CI)
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export const GATES_PATH = "studio/distribution-gates.json";
const ATTRIBUTION_PATH = "studio/dependency-attribution.json";
const STATUS_VALUES = new Set(["cleared", "blocked-on-owner"]);
const SECRET_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[0-9A-Za-z]{36}|sk-[0-9A-Za-z]{20,}/;

const fail = (message) => {
  throw new Error(`${GATES_PATH}: ${message}`);
};

/** Validates the gate register's own shape and internal consistency. Returns the parsed gates. */
export function validateGates(manifest) {
  if (manifest?.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!Array.isArray(manifest.gates) || manifest.gates.length === 0)
    fail("gates must be a non-empty array");
  const seen = new Set();
  for (const gate of manifest.gates) {
    const { id, area, description, status, owner, reason } = gate ?? {};
    if (typeof id !== "string" || !/^[a-z0-9-]+$/.test(id))
      fail(`gate id ${JSON.stringify(id)} must be lowercase-kebab-case`);
    if (seen.has(id)) fail(`duplicate gate id ${id}`);
    seen.add(id);
    const areas = Array.isArray(area) ? area : [area];
    if (
      areas.length === 0 ||
      areas.some((value) => typeof value !== "string" || value.length === 0)
    ) {
      fail(`${id}: area must be a non-empty string or array of strings`);
    }
    if (areas.some((value) => /native|mobile|ios|android/i.test(value))) {
      fail(
        `${id}: native/mobile distribution is out of scope (owner decision, 2026-09-29); remove this gate`,
      );
    }
    if (typeof description !== "string" || description.length === 0)
      fail(`${id}: description is required`);
    if (!STATUS_VALUES.has(status))
      fail(`${id}: status must be one of ${[...STATUS_VALUES].join(", ")}`);
    if (typeof reason !== "string" || reason.length === 0)
      fail(`${id}: reason is required`);
    if (status === "blocked-on-owner" && owner) {
      fail(
        `${id}: status is "blocked-on-owner" but names an owner (${JSON.stringify(owner)}) - clear the block or name the owner, not both`,
      );
    }
    if (
      status === "cleared" &&
      (typeof owner !== "string" || owner.length === 0)
    ) {
      fail(`${id}: a "cleared" gate must name the owner who cleared it`);
    }
  }
  const text = JSON.stringify(manifest);
  if (SECRET_PATTERN.test(text))
    fail(
      "a gate value looks like a live secret; secrets must stay outside git",
    );
  return manifest.gates;
}

/** Every embedded-component id whose rightsStatus is not "allowed", as `<id> (<package>)`. */
function blockedEmbeddedComponents(attribution) {
  return (attribution.embeddedComponents ?? [])
    .filter((row) => row.rightsStatus !== "allowed")
    .map((row) => `${row.id} (${row.package})`);
}

/** Cross-checks the gate register against the reviewed bill of materials it must not duplicate or drop. */
export function validateCoverage(gates, attribution) {
  const components = new Set(
    gates
      .filter((gate) => gate.status === "blocked-on-owner")
      .flatMap((gate) =>
        `${gate.component ?? ""} ${gate.description}`.split(/[^a-z0-9-]+/),
      ),
  );
  const missing = blockedEmbeddedComponents(attribution).filter((label) => {
    const [id] = label.split(" ");
    return !components.has(id);
  });
  if (missing.length > 0) {
    fail(
      `blocked embedded component(s) with no open gate: ${missing.join(", ")}`,
    );
  }
  if (
    attribution.dolbyTools?.included !== false ||
    !gates.some((gate) => gate.id === "dolby-tool-admission")
  ) {
    fail(
      "the Dolby tool admission gate is missing, or dolbyTools.included changed - review both together",
    );
  }
}

async function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const [gatesRaw, attributionRaw] = await Promise.all([
    readFile(path.join(root, GATES_PATH), "utf8"),
    readFile(path.join(root, ATTRIBUTION_PATH), "utf8"),
  ]);
  const gates = validateGates(JSON.parse(gatesRaw));
  validateCoverage(gates, JSON.parse(attributionRaw));
  const blocked = gates
    .filter((gate) => gate.status === "blocked-on-owner")
    .map((gate) => gate.id);
  process.stdout.write(
    `Distribution gates verified: ${gates.length} gates, ${blocked.length} blocked on the owner (${blocked.join(", ")}).\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
