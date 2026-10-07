import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseBackupPlan, MAX_DATABASE_BACKUP_AGE_MS } from '../backup-policy.mjs';

const now = Date.parse('2026-10-04T21:00:00Z');
const sourceId = 'immich-home';
const backup = (age, overrides = {}) => ({sourceId, database:'immich', createdAt:new Date(now-age).toISOString(), status:'completed', readable:true, integrity:'passed', ...overrides});
const plan = items => databaseBackupPlan(items, {sourceId, database:'immich', now});

test('24 hours is inclusive; one millisecond older requires a new database backup', () => {
  assert.equal(plan([backup(MAX_DATABASE_BACKUP_AGE_MS)]).skipBackup, true);
  assert.equal(plan([backup(MAX_DATABASE_BACKUP_AGE_MS + 1)]).skipBackup, false);
  assert.equal(plan([backup(0)]).skipBackup, true);
});
test('selects the newest usable backup of the selected installation', () => {
  const older = backup(8*3600000), recent = backup(2*3600000);
  assert.equal(plan([older, recent, backup(1000, {sourceId:'another-install'})]).backup, recent);
});
test('missing, wrong-source, unreadable, incomplete and corrupt dumps never skip backup', () => {
  assert.equal(plan([]).skipBackup, false);
  for (const overrides of [{sourceId:'other'}, {database:'other'}, {readable:false}, {status:'running'}, {integrity:'failed'}, {createdAt:'unknown'}]) {
    assert.equal(plan([backup(1000, overrides)]).skipBackup, false);
  }
});
test('future timestamps and backups that expire before cutover do not qualify', () => {
  assert.equal(plan([backup(-1000)]).skipBackup, false);
  const recent = backup(MAX_DATABASE_BACKUP_AGE_MS - 500);
  assert.equal(plan([recent]).skipBackup, true);
  assert.equal(databaseBackupPlan([recent], {sourceId, database:'immich', now:now+1000}).skipBackup, false);
});
test('uses the resolved database name instead of assuming it is named immich', () => {
  assert.equal(databaseBackupPlan([backup(1000,{database:'family_photos'})], {sourceId, database:'family_photos', now}).skipBackup, true);
});
