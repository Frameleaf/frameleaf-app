import { Permission } from '@immich/sdk';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateAlbums } from 'src/commands/migrate/albums';
import { audit, type AuditMeta, type AuditReport } from 'src/commands/migrate/audit';
import { ServerClient } from 'src/commands/migrate/client';
import { Controller } from 'src/commands/migrate/controller';
import { dedupe } from 'src/commands/migrate/dedupe';
import { enumerate } from 'src/commands/migrate/enumerate';
import { Ledger } from 'src/commands/migrate/ledger';
import { applyMetadata } from 'src/commands/migrate/metadata';
import { migratePeople } from 'src/commands/migrate/people';
import { sanitizeUrl } from 'src/commands/migrate/report';
import { startDashboard } from 'src/commands/migrate/server';
import { migrateStacks } from 'src/commands/migrate/stacks';
import { migrateTags } from 'src/commands/migrate/tags';
import { transfer } from 'src/commands/migrate/transfer';
import type { MigrateOptions, MigrateRawOptions } from 'src/commands/migrate/types';

const SOURCE_REQUIRED = [Permission.AssetRead, Permission.AssetDownload, Permission.AlbumRead, Permission.TagRead];
const SOURCE_OPTIONAL = [Permission.StackRead, Permission.PersonRead];
const DEST_REQUIRED = [
  Permission.AssetUpload,
  Permission.AssetUpdate,
  Permission.AlbumCreate,
  Permission.AlbumAssetCreate,
  Permission.TagCreate,
  Permission.TagAsset,
];
const DEST_OPTIONAL = [
  Permission.StackCreate,
  Permission.PersonCreate,
  Permission.PersonReassign,
  Permission.FaceRead, // needed to find which face on B a name should attach to
];

const die = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const normalize = (raw: MigrateRawOptions): MigrateOptions => ({
  // Verification only reads the destination; the source URL comes from the ledger.
  from: raw.verify
    ? { url: raw.fromUrl ?? '', key: raw.fromKey ?? '' }
    : { url: raw.fromUrl || die('Missing --from-url'), key: raw.fromKey || die('Missing --from-key') },
  to: { url: raw.toUrl || die('Missing --to-url'), key: raw.toKey || die('Missing --to-key') },
  ledger: raw.ledger,
  concurrency: Math.max(1, Number(raw.concurrency) || 1),
  dryRun: !!raw.dryRun,
  includeTrashed: !!raw.includeTrashed,
  retryFailed: !!raw.retryFailed,
  faces: raw.faces,
  serve: !!raw.serve,
  port: Number(raw.port) || 2285,
  preflight: !!raw.preflight,
  verify: !!raw.verify,
});

const checkPermissions = (permissions: Permission[], required: Permission[], optional: Permission[], label: string) => {
  if (permissions.includes(Permission.All)) {
    return;
  }
  const missingRequired = required.filter((p) => !permissions.includes(p));
  if (missingRequired.length > 0) {
    die(`${label} API key is missing required permissions: ${missingRequired.join(', ')}`);
  }
  const missingOptional = optional.filter((p) => !permissions.includes(p));
  if (missingOptional.length > 0) {
    console.warn(`Warning: ${label} API key lacks ${missingOptional.join(', ')} — related items will be skipped.`);
  }
};

const removePartials = async (dir: string) => {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(entries.filter((f) => f.endsWith('.part')).map((f) => rm(join(dir, f), { force: true })));
};

/**
 * The whole resumable run: snapshot the source, match what the destination already holds,
 * copy and organise the rest, then audit. Nothing here ever deletes from either server.
 */
export async function runPipeline(
  from: ServerClient,
  to: ServerClient,
  ledger: Ledger,
  options: MigrateOptions,
  controller: Controller,
  tmpDir: string,
  auditPath: string,
  meta: AuditMeta,
): Promise<AuditReport | undefined> {
  controller.running = true;
  try {
    await enumerate(from, ledger, options, controller);
    if (controller.stopped) {
      return undefined;
    }
    await dedupe(to, ledger, controller);
    if (controller.stopped) {
      return undefined;
    }

    if (!options.dryRun) {
      await transferAndOrganize(from, to, ledger, options, controller, tmpDir);
      if (controller.stopped) {
        return undefined;
      }
    }

    return await audit(to, ledger, controller, auditPath, meta);
  } finally {
    controller.running = false;
  }
}

async function transferAndOrganize(
  from: ServerClient,
  to: ServerClient,
  ledger: Ledger,
  options: MigrateOptions,
  controller: Controller,
  tmpDir: string,
) {
  await transfer(from, to, ledger, options, controller, tmpDir);
  if (controller.stopped) {
    return;
  }
  await applyMetadata(from, to, ledger, options, controller);
  if (controller.stopped) {
    return;
  }
  await migrateTags(from, to, ledger, options, controller);
  if (controller.stopped) {
    return;
  }
  await migrateAlbums(from, to, ledger, options, controller);
  if (controller.stopped) {
    return;
  }
  await migrateStacks(to, ledger, controller);
  if (controller.stopped) {
    return;
  }
  await migratePeople(from, to, ledger, options, controller);
}

const printSummary = (report: AuditReport | undefined, ledgerPath: string, auditPath: string) => {
  if (!report) {
    console.log('\nStopped. State saved — re-run the same command to resume.');
    return;
  }
  const t = report.totals;
  console.log('\n──────── Migration summary ────────');
  console.log(`Assets:  ${t.uploaded}/${t.assets} on B   (${t.failed} failed, ${t.missing} missing)`);
  console.log(`Verified on B by checksum: ${report.assets.verified}/${report.assets.total}`);
  console.log(`Albums:  ${t.albumsLinked}/${t.albums}   Tags: ${t.tagsAssigned}/${t.tags}`);
  console.log(`Stacks:  ${t.stacksDone}/${t.stacks}   People: ${t.peopleDone}/${t.people}`);
  console.log(`Audit report: ${auditPath}`);
  console.log(`Ledger:       ${ledgerPath}`);
  if (report.unresolvedCount > 0) {
    console.log(`Unresolved:   ${report.unresolvedCount} item(s) — listed in the audit report`);
  }
  if (report.dryRun) {
    console.log('\nDRY RUN — nothing was written to SERVER B. This preview never clears SERVER A for decommissioning.');
  } else if (report.ok && report.unresolvedCount > 0) {
    console.log(
      `\n✅ PASS — every asset is present on SERVER B, but ${report.unresolvedCount} album/tag/stack/person item(s) ` +
        'are unresolved. Resolve or accept them (see the audit report) before decommissioning SERVER A.',
    );
  } else if (report.ok) {
    console.log('\n✅ PASS — every asset is present on SERVER B. SERVER A is safe to decommission.');
  } else if (report.complete) {
    console.log(
      `\n⚠️  INCOMPLETE — ${t.missing} asset(s) missing, ${t.failed} failed. Re-run to resume; see the audit report.`,
    );
  } else {
    console.log(
      `\n⚠️  AUDIT INCOMPLETE — stopped after verifying ${report.verified}/${t.uploaded} transferred asset(s).` +
        `\n   This is NOT a pass. Re-run to finish the audit before decommissioning anything.`,
    );
  }
};

export async function migrate(raw: MigrateRawOptions) {
  try {
    await runMigrate(raw);
  } catch (error) {
    console.error(`\nMigration error: ${error instanceof Error ? error.message : String(error)}`);
    console.error('State is saved in the ledger — fix the issue and re-run to resume.');
    process.exit(1);
  }
}

async function runMigrate(raw: MigrateRawOptions) {
  const options = normalize(raw);
  if (options.preflight && options.verify) {
    die('Choose either --preflight or --verify, not both.');
  }
  if (options.verify) {
    const ignored = [
      options.dryRun && '--dry-run',
      options.serve && '--serve',
      options.retryFailed && '--retry-failed',
      options.includeTrashed && '--include-trashed',
      !options.faces && '--no-faces',
    ].filter(Boolean);
    if (ignored.length > 0) {
      die(`--verify only re-checks the destination; remove ${ignored.join(', ')}.`);
    }
  }
  if (options.verify) {
    await runVerify(options);
    return;
  }

  console.log('Connecting to source and destination…');
  const [{ client: from, user: fromUser }, { client: to, user: toUser }] = await Promise.all([
    ServerClient.connect(options.from.url, options.from.key),
    ServerClient.connect(options.to.url, options.to.key),
  ]);

  const [fromKey, toKey] = await Promise.all([from.getMyApiKey(), to.getMyApiKey()]);
  checkPermissions(fromKey.permissions, SOURCE_REQUIRED, SOURCE_OPTIONAL, 'Source');
  checkPermissions(toKey.permissions, DEST_REQUIRED, DEST_OPTIONAL, 'Destination');
  if (fromUser.email !== toUser.email) {
    console.warn(
      `Warning: source user (${fromUser.email}) differs from destination user (${toUser.email}). ` +
        `All migrated content will be owned by ${toUser.email} on SERVER B.`,
    );
  }

  if (options.preflight) {
    printPreflight(options, from, to, fromUser.email, toUser.email);
    process.exit(0);
  }

  const ledger = new Ledger(options.ledger);
  const startedAt = new Date().toISOString();
  ledger.initRun({
    fromUrl: from.baseUrl,
    toUrl: to.baseUrl,
    userEmail: toUser.email,
    sourceEmail: fromUser.email,
    startedAt,
    dryRun: options.dryRun,
  });
  if (options.retryFailed) {
    ledger.clearErrors();
  }

  const tmpDir = `${options.ledger}.tmp`;
  const auditPath = `${options.ledger}.audit.json`;
  await mkdir(tmpDir, { recursive: true });
  await removePartials(tmpDir);

  const controller = new Controller();
  controller.startedAt = startedAt;
  const meta: AuditMeta = {
    from: from.baseUrl,
    to: to.baseUrl,
    user: toUser.email,
    sourceUser: fromUser.email,
    dryRun: options.dryRun,
    secrets: [options.from.key, options.to.key],
  };

  const priorCounts = ledger.counts();
  if (priorCounts.assetsUploaded > 0) {
    console.log(`Resuming: ${priorCounts.assetsUploaded}/${priorCounts.assetsTotal} assets already on B.`);
  }

  process.on('SIGINT', () => {
    if (controller.stopped) {
      // Already winding down and the user asked again — don't make them wait out an
      // in-flight upload. The ledger is committed per item, so this is still resumable.
      console.log('\nForce quit.');
      process.exit(130);
    }
    console.log('\nStopping after the current items (state is saved; re-run to resume)…');
    console.log('Press Ctrl+C again to quit immediately.');
    controller.stop();
  });

  let dashboard;
  if (options.serve) {
    dashboard = await startDashboard(options.port, controller, ledger, meta, auditPath, options.dryRun);
    console.log(`Dashboard: ${dashboard.url}  (close the browser anytime; this process keeps running)`);
  }

  const report = await runPipeline(from, to, ledger, options, controller, tmpDir, auditPath, meta);
  printSummary(report, options.ledger, auditPath);

  if (dashboard && !controller.stopped) {
    controller.phase = 'done';
    console.log('\nDashboard still running for review. Press Ctrl+C to exit.');
    return; // keep the process alive via the HTTP server
  }

  dashboard?.close();
  ledger.close();
  // A stopped/interrupted run is NOT a success: only a complete, clean audit exits 0.
  process.exit(report?.ok ? 0 : 2);
}

/**
 * `--preflight`: prove both keys work and carry the permissions the run needs (checked by
 * the caller), name the owners on each side and describe any existing ledger. Reads only:
 * an absent ledger is not created, an existing one is opened read-only.
 */
export function describePreflight(
  ledgerPath: string,
  fromUrl: string,
  toUrl: string,
  source: string,
  dest: string,
): { lines: string[]; warnings: string[] } {
  const lines = [
    `Source:      ${sanitizeUrl(fromUrl)}  (owner ${source})`,
    `Destination: ${sanitizeUrl(toUrl)}  (owner ${dest})`,
    'Permissions: all required permissions present',
  ];
  const warnings: string[] = [];
  if (!existsSync(ledgerPath)) {
    lines.push(`Ledger:      ${ledgerPath} (new — the first run creates it)`);
    return { lines, warnings };
  }
  const ledger = new Ledger(ledgerPath, { readonly: true });
  try {
    const run = ledger.runInfo();
    const counts = ledger.counts();
    lines.push(`Ledger:      ${ledgerPath} (resumes: ${counts.assetsUploaded}/${counts.assetsTotal} assets on B)`);
    if (run && (sanitizeUrl(run.fromUrl) !== sanitizeUrl(fromUrl) || sanitizeUrl(run.toUrl) !== sanitizeUrl(toUrl))) {
      warnings.push(
        `This ledger was recorded for ${sanitizeUrl(run.fromUrl)} -> ${sanitizeUrl(run.toUrl)}. ` +
          'Use a separate --ledger for a different pair of servers.',
      );
    }
  } finally {
    ledger.close();
  }
  return { lines, warnings };
}

function printPreflight(options: MigrateOptions, from: ServerClient, to: ServerClient, source: string, dest: string) {
  const { lines, warnings } = describePreflight(options.ledger, from.baseUrl, to.baseUrl, source, dest);
  console.log('\n──────── Preflight ────────');
  for (const line of lines) {
    console.log(line);
  }
  for (const warning of warnings) {
    console.warn(`Warning: ${warning}`);
  }
  console.log('\nPreflight passed. Nothing was written to either server.');
}

/**
 * `--verify`: re-audit an existing ledger against the destination only. Use it right
 * before retiring the source, or to regenerate the report file for the web migration checklist.
 * It never contacts the source and never transfers; it refuses a different destination.
 */
export async function verifyLedger(
  to: ServerClient,
  destinationUser: string,
  ledgerPath: string,
  controller: Controller,
  secrets: string[],
): Promise<{ report: AuditReport; auditPath: string }> {
  if (!existsSync(ledgerPath)) {
    throw new Error(`No ledger at ${ledgerPath}. Run the migration first, or pass the --ledger it used.`);
  }
  const ledger = new Ledger(ledgerPath);
  try {
    const run = ledger.runInfo();
    if (!run) {
      throw new Error(`${ledgerPath} has no recorded run. Run the migration first.`);
    }
    if (sanitizeUrl(run.toUrl) !== sanitizeUrl(to.baseUrl)) {
      throw new Error(
        `This ledger was recorded for destination ${sanitizeUrl(run.toUrl)}, not ${sanitizeUrl(to.baseUrl)}. ` +
          'Verify against the destination the ledger was written for.',
      );
    }
    const auditPath = `${ledgerPath}.audit.json`;
    const report = await audit(to, ledger, controller, auditPath, {
      from: run.fromUrl,
      to: to.baseUrl,
      user: destinationUser,
      sourceUser: run.sourceEmail,
      // A ledger only ever used for dry runs verifies as a dry run, never as a pass.
      dryRun: run.dryRun,
      secrets,
    });
    return { report, auditPath };
  } finally {
    ledger.close();
  }
}

async function runVerify(options: MigrateOptions) {
  console.log('Connecting to destination…');
  const { client: to, user: toUser } = await ServerClient.connect(options.to.url, options.to.key);
  const controller = new Controller();
  process.on('SIGINT', () => controller.stop());
  const { report, auditPath } = await verifyLedger(
    to,
    toUser.email,
    options.ledger,
    controller,
    [options.to.key, options.from.key].filter(Boolean),
  );
  printSummary(report, options.ledger, auditPath);
  process.exit(report.ok ? 0 : 2);
}
