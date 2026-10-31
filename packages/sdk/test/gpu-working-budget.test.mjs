import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  GpuWorkingBudgetHeadroomBytes,
  GpuWorkingBudgetMeasuredBytes,
  GpuWorkingBudgetMetric,
} from "../build/fetch-client.js";

test("generated GPU contracts preserve decimal budgets, strict receipt identity and nullable compatibility", async () => {
  const schemas = JSON.parse(
    await readFile(
      new URL("../../../open-api/immich-openapi-specs.json", import.meta.url),
    ),
  ).components.schemas;
  for (const name of [
    "RenderWorkerAdmissionDto",
    "RenderWorkerCreateDto",
    "RenderWorkerUpdateDto",
    "RenderWorkerDto",
    "RenderWorkerSessionDto",
  ]) {
    const memory = schemas[name].properties.gpuMemoryBytes;
    assert.equal(memory.type, "string");
    assert.equal(memory.nullable, true);
    assert.match("9223372036854775807", new RegExp(memory.pattern));
    assert.equal(new RegExp(memory.pattern).test("2.147e9"), false);
  }
  const response =
    schemas.RenderWorkerSessionDto.properties.gpuWorkingBudgetEvidence;
  assert.equal(response.nullable, true);
  assert.equal(response.additionalProperties, false);
  assert.equal(response.required.includes("workerId"), true);
  assert.deepEqual(schemas.GpuWorkingBudgetMeasuredBytes.enum, ["2147483648"]);
  assert.deepEqual(schemas.GpuWorkingBudgetHeadroomBytes.enum, ["536870912"]);
  const approval =
    schemas.RenderWorkerCreateDto.properties.gpuWorkingBudgetApproval;
  assert.equal(approval.nullable, true);
  assert.equal(approval.properties.evidence.additionalProperties, false);
  assert.equal(
    Object.hasOwn(approval.properties.evidence.properties, "workerId"),
    false,
  );
  assert.deepEqual(Object.values(GpuWorkingBudgetMetric), [
    "measured-usable-gpu-working-budget-v1",
  ]);
  assert.deepEqual(Object.values(GpuWorkingBudgetMeasuredBytes), [
    "2147483648",
  ]);
  assert.deepEqual(Object.values(GpuWorkingBudgetHeadroomBytes), ["536870912"]);
});
