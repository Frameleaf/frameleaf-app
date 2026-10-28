// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Frameleaf. Independently authored release tooling; no application code.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const products = {
  Cloud: ["FC"],
  Library: ["FL"],
  iOS: ["FL", "FIOS"],
  Android: ["FL"],
};
const sha = /^[a-f0-9]{40}$/;
export function issueKeys(text, allowedProjects) {
  return [
    ...new Set(
      [
        ...text.matchAll(
          /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]*-[1-9][0-9]*)(?![A-Za-z0-9_])/g,
        ),
      ]
        .map((m) => m[1])
        .filter((key) => allowedProjects.includes(key.split("-")[0])),
    ),
  ].sort();
}
export function gitIssueKeys(base, head, allowedProjects, cwd = process.cwd()) {
  assert(
    sha.test(base) && sha.test(head),
    "Release boundaries must be full commit SHAs",
  );
  execFileSync("git", ["merge-base", "--is-ancestor", base, head], { cwd });
  return issueKeys(
    execFileSync("git", ["log", "--format=%B", `${base}..${head}`], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
    allowedProjects,
  );
}
function httpsUrl(value) {
  const u = new URL(value);
  assert(
    u.protocol === "https:" && !u.username && !u.password,
    "Evidence must be an HTTPS URL",
  );
  return u.href;
}
export function validateReceipt(receipt, product) {
  assert(products[product], "Unknown product");
  assert(["planned", "shipped"].includes(receipt.mode), "Invalid release mode");
  assert(
    typeof receipt.version === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9.+_() -]{0,150}$/.test(receipt.version),
    "Invalid release version",
  );
  assert(Array.isArray(receipt.issueKeys), "issueKeys must be an array");
  assert(
    receipt.issueKeys.every(
      (k) =>
        issueKeys(k, products[product]).length === 1 &&
        issueKeys(k, products[product])[0] === k,
    ),
    "Unexpected Jira issue project/key",
  );
  httpsUrl(receipt.evidenceUrl);
  if (receipt.mode === "shipped") {
    assert(
      sha.test(receipt.sourceSha) && sha.test(receipt.previousSha),
      "Missing exact shipment source/baseline",
    );
    assert(
      /^\d{4}-\d{2}-\d{2}T/.test(receipt.releasedAt) &&
        !Number.isNaN(Date.parse(receipt.releasedAt)),
      "Missing shipment date",
    );
    const channels = {
      Cloud: "production",
      Library: "library-release",
      iOS: "app-store",
      Android: "google-play-production",
    };
    assert.equal(receipt.channel, channels[product], "Not a shipping channel");
  } else {
    assert(
      /^Frameleaf\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(receipt.planKey),
      "Missing PR plan identity",
    );
  }
}

export function jiraClient(env = process.env) {
  const base = env.JIRA_BASE_URL || "https://heroit.atlassian.net";
  assert.equal(
    new URL(base).origin,
    "https://heroit.atlassian.net",
    "Unexpected Jira site",
  );
  assert(env.JIRA_EMAIL && env.JIRA_API_TOKEN, "Jira credentials are required");
  const authorization = `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64")}`;
  return async (path, method = "GET", body) => {
    assert(path.startsWith("/rest/api/3/"), "Unexpected Jira endpoint");
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(new URL(path, base), {
        method,
        headers: {
          authorization,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      if (
        (response.status === 429 || response.status >= 500) &&
        method === "GET" &&
        attempt < 3
      ) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(
              Number(response.headers.get("retry-after")) || 2 ** attempt,
              30,
            ) * 1000,
          ),
        );
        continue;
      }
      if (!response.ok) {
        const error = new Error(
          `Jira ${method} ${path.split("?")[0]} failed: HTTP ${response.status}`,
        );
        error.status = response.status;
        throw error; // Never echo a response that might contain credentials or private issue content.
      }
      return response.status === 204 ? null : response.json();
    }
  };
}

export async function syncRelease(receipt, { product, request }) {
  validateReceipt(receipt, product);
  const keys = [...new Set(receipt.issueKeys)].sort();
  if (!keys.length) return { issues: 0, versions: [] };
  const name = `${product} ${receipt.version}`;
  const shipped = receipt.mode === "shipped";
  const cache = new Map();
  const issueRows = [];
  // Preflight all issues before writing any release association.
  for (const key of keys) {
    const issue = await request(
      `/rest/api/3/issue/${key}?fields=fixVersions,project`,
    );
    assert.equal(
      issue.fields.project.key,
      key.split("-")[0],
      "Issue project mismatch",
    );
    issueRows.push({ key, issue });
  }
  async function findVersion(project) {
    let startAt = 0;
    for (;;) {
      const page = await request(
        `/rest/api/3/project/${project}/version?maxResults=100&startAt=${startAt}&query=${encodeURIComponent(name)}`,
      );
      const match = page.values.filter((v) => v.name === name);
      assert(match.length <= 1, "Ambiguous Jira version");
      if (match.length) return match[0];
      if (page.isLast || startAt + page.values.length >= page.total)
        return null;
      assert(page.values.length, "Incomplete version pagination");
      startAt += page.values.length;
    }
  }
  async function checkMembership(project, version) {
    let nextPageToken;
    do {
      const page = await request("/rest/api/3/search/jql", "POST", {
        jql: `project = ${project} AND fixVersion = ${version.id}`,
        fields: ["key"],
        maxResults: 100,
        ...(nextPageToken ? { nextPageToken } : {}),
      });
      assert(
        page.issues.every((i) => keys.includes(i.key)),
        "Version contains deferred issues; reconcile their planned target before releasing",
      );
      nextPageToken = page.nextPageToken;
    } while (nextPageToken);
  }
  for (const { issue } of issueRows) {
    const project = issue.fields.project.key;
    if (cache.has(project)) continue;
    let version = await findVersion(project);
    if (version) {
      assert(!version.archived, "Release version is archived");
      if (!shipped && version.released)
        assert(
          issueRows
            .filter((row) => row.issue.fields.project.key === project)
            .every((row) =>
              row.issue.fields.fixVersions?.some((v) => v.id === version.id),
            ),
          "Cannot plan new work in an already released version",
        );
      if (shipped && version.released)
        assert(
          version.description?.includes(`Source: ${receipt.sourceSha}\n`),
          "Released version has different or unknown source",
        );
    } else {
      try {
        version = await request("/rest/api/3/version", "POST", {
          name,
          project: issue.fields.project.key,
          released: false,
          description: `Planned ${product} release. Managed by GitHub.`,
        });
      } catch (error) {
        // A competing workflow may have created the version, or the POST response was lost.
        version = await findVersion(project);
        if (!version) throw error;
        assert(
          !version.archived && !version.released,
          "Concurrent release must be retried",
        );
      }
    }
    if (shipped && !version.released) await checkMembership(project, version);
    cache.set(project, version);
  }
  for (const { key, issue } of issueRows) {
    const version = cache.get(issue.fields.project.key);
    if (!shipped && version.released) continue; // Already-recorded historical shipment; do not turn it into a plan.
    const existing = issue.fields.fixVersions || [];
    let plans;
    const propertyPath = `/rest/api/3/issue/${key}/properties/frameleaf.release-plans.${product.toLowerCase()}`;
    if (!shipped) {
      try {
        plans = (await request(propertyPath)).value;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      plans ||= { refs: {}, owned: [] };
      assert(
        plans.refs && Array.isArray(plans.owned),
        "Invalid existing plan ledger",
      );
      plans.pendingRemovals ||= [];
    }
    const updates = [];
    if (!existing.some((v) => v.id === version.id)) {
      updates.push({ add: { id: version.id } });
      if (plans && !plans.owned.includes(version.id))
        plans.owned.push(version.id);
    }
    if (plans) {
      const old = plans.refs[receipt.planKey];
      plans.refs[receipt.planKey] = version.id;
      if (
        old &&
        old !== version.id &&
        plans.owned.includes(old) &&
        !Object.values(plans.refs).includes(old)
      )
        plans.pendingRemovals.push(old);
      plans.pendingRemovals = [...new Set(plans.pendingRemovals)].filter(
        (id) => !Object.values(plans.refs).includes(id),
      );
      for (const id of plans.pendingRemovals)
        if (existing.some((v) => v.id === id && !v.released))
          updates.push({ remove: { id } });
      // Save ownership and removals first so any failed issue edit is recoverable on retry.
      await request(propertyPath, "PUT", plans);
    }
    if (updates.length)
      await request(`/rest/api/3/issue/${key}`, "PUT", {
        update: { fixVersions: updates },
      });
    const saved = await request(`/rest/api/3/issue/${key}?fields=fixVersions`);
    assert(
      saved.fields.fixVersions.some((v) => v.id === version.id),
      `Version read-back failed for ${key}`,
    );
    for (const update of updates.filter((u) => u.remove))
      assert(
        !saved.fields.fixVersions.some((v) => v.id === update.remove.id),
        "Old plan removal failed",
      );
    if (plans) {
      plans.owned = plans.owned.filter(
        (id) => !plans.pendingRemovals.includes(id),
      );
      plans.pendingRemovals = [];
      await request(propertyPath, "PUT", plans);
      assert.deepEqual(
        (await request(propertyPath)).value,
        plans,
        "Plan ledger read-back failed",
      );
    }
    if (shipped) {
      const evidencePath = `/rest/api/3/issue/${key}/properties/frameleaf.shipment.${version.id}`;
      let evidence = {
        product,
        version: receipt.version,
        sourceSha: receipt.sourceSha,
        previousSha: receipt.previousSha,
        channel: receipt.channel,
        releasedAt: receipt.releasedAt,
        evidenceUrl: receipt.evidenceUrl,
        ...(receipt.build ? { build: String(receipt.build) } : {}),
      };
      try {
        const previous = (await request(evidencePath)).value;
        assert(
          previous.sourceSha === receipt.sourceSha &&
            previous.channel === receipt.channel &&
            previous.version === receipt.version,
          "Existing shipment evidence conflicts",
        );
        evidence = previous; // Retain first verified evidence even if a later retry observes the store again.
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      await request(evidencePath, "PUT", evidence);
      assert.deepEqual(
        (await request(evidencePath)).value,
        evidence,
        "Shipment evidence read-back failed",
      );
      await request(`/rest/api/3/issue/${key}/remotelink`, "POST", {
        globalId: `frameleaf:${product}:${version.id}`,
        object: {
          url: evidence.evidenceUrl,
          title: `Shipped ${name}${evidence.build ? ` (build ${evidence.build})` : ""} — ${receipt.channel}`,
        },
      });
    }
  }
  if (shipped)
    for (const [project, version] of cache) {
      if (!version.released) {
        await checkMembership(project, version);
        const description = `Product: ${product}\nSource: ${receipt.sourceSha}\nChannel: ${receipt.channel}\nEvidence: ${receipt.evidenceUrl}\n${receipt.build ? `Build: ${receipt.build}\n` : ""}`;
        await request(`/rest/api/3/version/${version.id}`, "PUT", {
          released: true,
          releaseDate: receipt.releasedAt.slice(0, 10),
          description,
        });
        const saved = await request(`/rest/api/3/version/${version.id}`);
        assert(
          saved.released && saved.description === description,
          "Release read-back failed",
        );
      }
    }
  return {
    issues: keys.length,
    versions: [...cache.values()].map((v) => v.id),
    mode: receipt.mode,
  };
}

export async function cancelPlan(keys, planKey, { product, request }) {
  assert(
    products[product] &&
      /^Frameleaf\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(planKey),
    "Invalid plan identity",
  );
  for (const key of keys) {
    assert.deepEqual(issueKeys(key, products[product]), [key]);
    const path = `/rest/api/3/issue/${key}/properties/frameleaf.release-plans.${product.toLowerCase()}`;
    let plans;
    try {
      plans = (await request(path)).value;
    } catch (e) {
      if (e.status === 404) continue;
      throw e;
    }
    const id = plans.refs[planKey];
    if (!id && !plans.pendingRemovals?.length) continue;
    delete plans.refs[planKey];
    plans.pendingRemovals = [
      ...new Set([...(plans.pendingRemovals || []), id]),
    ].filter(
      (v) => plans.owned.includes(v) && !Object.values(plans.refs).includes(v),
    );
    await request(path, "PUT", plans);
    const current = await request(
      `/rest/api/3/issue/${key}?fields=fixVersions`,
    );
    for (const removeId of plans.pendingRemovals) {
      if (
        current.fields.fixVersions.some((v) => v.id === removeId && !v.released)
      ) {
        await request(`/rest/api/3/issue/${key}`, "PUT", {
          update: { fixVersions: [{ remove: { id: removeId } }] },
        });
        assert(
          !(
            await request(`/rest/api/3/issue/${key}?fields=fixVersions`)
          ).fields.fixVersions.some((v) => v.id === removeId),
          "Cancelled plan read-back failed",
        );
      }
      plans.owned = plans.owned.filter((v) => v !== removeId);
    }
    plans.pendingRemovals = [];
    await request(path, "PUT", plans);
    assert.deepEqual(
      (await request(path)).value,
      plans,
      "Cancelled plan ledger read-back failed",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await syncRelease(
      JSON.parse(readFileSync(process.argv[2], "utf8")),
      { product: process.env.JIRA_PRODUCT, request: jiraClient() },
    );
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
