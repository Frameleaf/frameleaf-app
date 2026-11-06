import { DatabaseSync } from 'node:sqlite';
import fixture from 'src/library-import/fixtures/nextcloud/35-8-10.2-sqlite.json' with { type: 'json' };
import { openNextcloudSnapshot, readNextcloudManifest } from 'src/library-import/nextcloud.js';
import { type ImportedPasswordContext } from 'src/library-import/passwords.js';
import { qualifiedSource } from 'src/library-import/preparation/sqlite.js';
import {
  type PreparationAdapter,
  type SourceLogin,
  isQualificationRefusal,
  unrestrictedLogin,
} from 'src/library-import/preparation/types.js';
import { assertSqliteTextSafe } from 'src/library-import/sqlite.js';

const inventory = (revision: string) => ({
  complete: true as const,
  ownershipComplete: true as const,
  privacyComplete: true as const,
  writersStopped: true as const,
  revisionBefore: revision,
  revisionAfter: revision,
});

/** Strict reads also pin the Photos/Memories app state; a newer app with the same schema is still best effort. */
const openBestEffort = (path: string) => {
  try {
    return { snapshot: openNextcloudSnapshot(path, fixture.source.version), tested: true };
  } catch (error) {
    if (!isQualificationRefusal(error) && !(error as Error)?.message.includes('_APPLICATION_STATE_UNQUALIFIED'))
      throw error;
  }
  return { snapshot: openNextcloudSnapshot(path, fixture.source.version, { bestEffort: true }), tested: false };
};

type LoginFacts = { disabled: Set<string> | undefined; secondFactor: Set<string> | 'all' | undefined };

/**
 * Login facts and emails live outside the reader's projections. Each query that cannot be read leaves its fact
 * unknown, and unknown facts are reported restrictively.
 */
const readAccountFacts = (path: string) => {
  const emails = new Map<string, string>();
  const facts: LoginFacts = { disabled: undefined, secondFactor: undefined };
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
  } catch {
    return { emails, facts };
  }
  const read = (query: string) => {
    assertSqliteTextSafe(database, query);
    return database.prepare(query).all();
  };
  try {
    try {
      const preferences = read(
        "SELECT userid,appid,configkey,configvalue FROM oc_preferences WHERE (appid='core' AND configkey='enabled') OR (appid='settings' AND configkey='email')",
      );
      facts.disabled = new Set();
      for (const row of preferences) {
        const user = String(row.userid);
        if (row.appid === 'core' && row.configvalue !== 'true') facts.disabled.add(user);
        if (row.appid === 'settings' && typeof row.configvalue === 'string' && row.configvalue.includes('@'))
          emails.set(user, row.configvalue);
      }
    } catch {
      facts.disabled = undefined;
    }
    try {
      const enforced = read(
        "SELECT configvalue FROM oc_appconfig WHERE appid='core' AND configkey='twofactor_enforced'",
      );
      // ponytail: enforcement can be scoped to groups; treat any enforcement as applying to everyone.
      if (enforced.some((row) => row.configvalue === 'true')) facts.secondFactor = 'all';
      else
        facts.secondFactor = new Set(
          read('SELECT uid FROM oc_twofactor_providers WHERE enabled=1').map((row) => String(row.uid)),
        );
    } catch {
      facts.secondFactor = undefined;
    }
  } finally {
    database.close();
  }
  return { emails, facts };
};

const loginFor = (uid: string, facts: LoginFacts): SourceLogin => ({
  ...unrestrictedLogin,
  accountEnabled: facts.disabled !== undefined && !facts.disabled.has(uid),
  secondFactorRequired: facts.secondFactor === undefined || facts.secondFactor === 'all' || facts.secondFactor.has(uid),
});

/** Nextcloud SQLite: originals are mounted at the data directory; each local home storage `home::<uid>` is `<uid>/`. */
export const adapter: PreparationAdapter = {
  kind: 'nextcloud',
  databases: ['sqlite'],
  open(input) {
    const { snapshot, tested } = openBestEffort(input.snapshotPath!);
    const rows = (table: Parameters<typeof snapshot.rows>[0]) => [...snapshot.rows(table)].flat();
    try {
      const storageRoots: Record<string, string> = {};
      for (const storage of rows('oc_storages')) {
        const id = String(storage.id);
        if (id.startsWith('home::')) storageRoots[String(storage.numeric_id)] = id.slice('home::'.length);
      }
      // Memories indexes every file when it is enabled; otherwise the Photos metadata cache is the source view.
      const metadataView = rows('oc_memories').length > 0 ? ('memories' as const) : ('photos' as const);
      return Promise.resolve({
        tested,
        testedVersion: fixture.source.version,
        owners() {
          const { emails, facts } = readAccountFacts(input.snapshotPath!);
          const owners = rows('oc_users').map((user) => {
            const uid = String(user.uid);
            return {
              sourceId: uid,
              name: typeof user.displayname === 'string' && user.displayname ? user.displayname : uid,
              email: emails.get(uid) ?? null,
              login: loginFor(uid, facts),
              password: (context: ImportedPasswordContext) => snapshot.password(context),
            };
          });
          return Promise.resolve(owners);
        },
        files() {
          const mimetypes = new Map(rows('oc_mimetypes').map((row) => [String(row.id), String(row.mimetype)]));
          const files = rows('oc_filecache').flatMap((file) => {
            const home = Object.hasOwn(storageRoots, String(file.storage))
              ? storageRoots[String(file.storage)]
              : undefined;
            const mimetype = mimetypes.get(String(file.mimetype));
            if (home === undefined || !mimetype || !/^(image|video)\//u.test(mimetype)) return [];
            return [{ id: `file:${file.fileid}`, path: `${home}/${file.path}`, role: 'original' as const }];
          });
          return Promise.resolve(files);
        },
        manifest(files) {
          const result = readNextcloudManifest(snapshot, {
            source: qualifiedSource(input.source, fixture),
            inventory: inventory(input.source.revision),
            metadataView,
            storageRoots,
            // Nextcloud records whole-second modification times; the file system may keep sub-second precision.
            files: files.map((file) => ({
              ...file,
              modifiedAt: new Date(Math.floor(Date.parse(file.modifiedAt) / 1000) * 1000).toISOString(),
            })),
          });
          return Promise.resolve(result);
        },
        close: () => snapshot.close(),
      });
    } catch (error) {
      snapshot.close();
      throw error;
    }
  },
};
