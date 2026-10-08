import { ConflictException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AssetStatus } from 'src/enum.js';
import { AssetLocalEffectRepository, SourceEpoch } from 'src/repositories/asset-local-effect.repository.js';
import { DB } from 'src/schema/index.js';
import { STUDIO_MAX_REFERENCES, isStudioUuid } from 'src/utils/studio-resources.js';

/** Adds an epoch fence to an already-authorized server-derived snapshot; grants no access itself. */
export async function holdSourceAdmission(db: Kysely<DB>, snapshot: Record<string, unknown>): Promise<void> {
  const value=snapshot.sourceEpochs;
  // Historical snapshots retain their original representation; worker reads re-resolve their sources.
  if(value===undefined) return;
  const refuse=():never=>{ throw new ConflictException('studio_source_admission_changed'); };
  if(!db.isTransaction || !Array.isArray(value) || value.length>STUDIO_MAX_REFERENCES) refuse();
  const epochs=value as SourceEpoch[];
  if(epochs.some(row=>!row || !isStudioUuid(row.assetId) || !isStudioUuid(row.ownerId) || typeof row.epoch!=='string' || !/^(0|[1-9][0-9]*)$/.test(row.epoch))) refuse();
  const ids=[...new Set(epochs.map(row=>row.assetId))].sort();
  if(ids.length!==epochs.length) refuse();
  if(!ids.length) return;
  const assets=await db.selectFrom('asset').select(['id','ownerId','status','deletedAt']).where('id','in',ids).orderBy('id').forShare().execute();
  if(assets.length!==ids.length || assets.some(a=>a.status!==AssetStatus.Active || a.deletedAt!==null || epochs.every(e=>e.assetId!==a.id || e.ownerId!==a.ownerId))) refuse();
  const current=await AssetLocalEffectRepository.sourceEpochs(db,ids);
  if(current.length!==epochs.length || current.some(row=>epochs.every(e=>e.assetId!==row.assetId || e.ownerId!==row.ownerId || e.epoch!==row.epoch))) refuse();
}
