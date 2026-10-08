import { ConflictException } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { lockICloudItemClaims } from 'src/repositories/icloud-item-claim-lock.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { withEffectiveConfigRead } from 'src/utils/config.js';
import { parseCloudIdentifier } from 'src/utils/icloud-identity.js';

type Family = { items: string[]; assetIds: string[] };
type Binding = { family: Family; epoch?: { epoch: number; digest: string; trashEnabled: boolean } };
const bindings = new WeakMap<Transaction<DB>, Binding>();
class ExpandFamily extends Error {
  constructor(readonly family: Family, readonly configuration: boolean) { super('edit_family_retry'); }
}
const sorted = (values: string[]) => [...new Set(values)].sort();

/** Bounded complete current family, including retained Trash and Locked live-photo/derived members. */
async function discover(db: Kysely<DB>, ownerId: string, seed: Family): Promise<Family> {
  let items = sorted(seed.items.map(item=>item.toUpperCase()));
  let assetIds = sorted(seed.assetIds);
  for(let pass=0;pass<6;pass++) {
    const { rows } = await sql<{id:string;item:string|null}>`WITH known AS (
      SELECT "assetId" AS id FROM icloud_edit_version WHERE "ownerId"=${ownerId}::uuid AND item=ANY(${items}::text[])
      UNION SELECT "assetId" FROM icloud_source_identity WHERE "ownerId"=${ownerId}::uuid AND upper("cplAssetRecordName")=ANY(${items}::text[])
      UNION SELECT unnest(${assetIds}::uuid[])
    ), expanded AS (
      SELECT id FROM known
      UNION SELECT member.id FROM asset member JOIN asset base ON base."stackId"=member."stackId" WHERE base.id IN(SELECT id FROM known)
      UNION SELECT "livePhotoVideoId" FROM asset WHERE id IN(SELECT id FROM known) AND "livePhotoVideoId" IS NOT NULL
      UNION SELECT id FROM asset WHERE "livePhotoVideoId" IN(SELECT id FROM known)
      UNION SELECT v."resultAssetId" FROM studio_export_version_source s JOIN studio_export_version v ON v.id=s."versionId"
        WHERE s."assetId" IN(SELECT id FROM known) AND v.state='published' AND v."resultAssetId" IS NOT NULL
    ), owned AS (SELECT a.id FROM expanded e JOIN asset a ON a.id=e.id WHERE a."ownerId"=${ownerId}::uuid)
    SELECT o.id,v.item FROM owned o JOIN icloud_edit_version v ON v."assetId"=o.id AND v."ownerId"=${ownerId}::uuid
    UNION SELECT o.id,upper(i."cplAssetRecordName") FROM owned o JOIN icloud_source_identity i ON i."assetId"=o.id AND i."ownerId"=${ownerId}::uuid
    UNION SELECT id,NULL FROM owned ORDER BY id`.execute(db);
    const nextItems=sorted([...items,...rows.flatMap(row=>row.item ? [row.item] : [])]);
    const nextAssets=sorted([...assetIds,...rows.map(row=>row.id)]);
    if(nextItems.length>100 || nextAssets.length>100) throw new ConflictException('edit_family_too_large');
    if(JSON.stringify([items,assetIds])===JSON.stringify([nextItems,nextAssets])) return {items,assetIds};
    items=nextItems;assetIds=nextAssets;
  }
  throw new ConflictException('edit_family_unstable');
}

/** Domain caller owns resource order; this prefix acquires only config and all sorted item keys. */
export async function withEditFamilyTransaction<T>(
  db:Kysely<DB>, ownerId:string, seed:Family, callback:(tx:Transaction<DB>)=>Promise<T>, configuration=false,
):Promise<T> {
  let hints=seed, needsConfig=configuration;
  for(let attempt=0;attempt<3;attempt++) {
    try {
      return await db.transaction().execute(async tx=>{
        const execute=async(epoch?:Binding['epoch'])=>{
          const family=await discover(tx,ownerId,hints);
          await lockICloudItemClaims(tx,ownerId,family.items);
          const current=await discover(tx,ownerId,family);
          if(current.items.some(item=>!family.items.includes(item)) || current.assetIds.some(id=>!family.assetIds.includes(id))) throw new ExpandFamily(current,needsConfig);
          bindings.set(tx,{family:current,epoch});
          try { return await callback(tx); } finally { bindings.delete(tx); }
        };
        if(!needsConfig) return execute();
        return withEffectiveConfigRead({configRepo:new ConfigRepository(),metadataRepo:new SystemMetadataRepository(tx),logger:LoggingRepository.create()},tx,
          (_snapshot,epoch)=>execute({epoch:epoch.epoch,digest:epoch.digest,trashEnabled:epoch.trashEnabled}));
      });
    } catch(error) {
      if(!(error instanceof ExpandFamily)) throw error;
      hints={items:sorted([...hints.items,...error.family.items]),assetIds:sorted([...hints.assetIds,...error.family.assetIds])};
      needsConfig ||= error.configuration;
    }
  }
  throw new ConflictException('edit_family_unstable');
}

type Resource = {channel:'device'|'icloud-sync';id:string};
export async function withICloudPublicationTransaction<T>(db:Kysely<DB>,ownerId:string,resources:Resource[],callback:(tx:Transaction<DB>)=>Promise<T>):Promise<T> {
  const items:string[]=[];
  let configuration=false;
  for(const source of resources) {
    if(source.channel==='device') {
      const row=await db.selectFrom('asset_upload_resource').select(['metadata','state','resultAssetId']).where('id','=',source.id).where('ownerId','=',ownerId).executeTakeFirst();
      const identity=row?.metadata.sourceIdentity;
      if(identity?.role==='edit-render') {
        const parsed=parseCloudIdentifier(identity.cloudIdentifier);
        if(parsed) items.push(parsed.cplAssetRecordName.toUpperCase());
        configuration ||= row?.state!=='published' && !row?.resultAssetId;
      }
    } else {
      const {rows:[row]}=await sql<{item:string;first:boolean}>`SELECT upper("sourceAssetId") AS item,status NOT IN('committed','finalized') AS first
        FROM icloud_resource WHERE id=${source.id}::uuid AND "ownerId"=${ownerId}::uuid AND "auditRequestId" IS NULL AND role IN('edited-image','edited-video')`.execute(db);
      if(row) { items.push(row.item);configuration ||= row.first; }
    }
  }
  return withEditFamilyTransaction(db,ownerId,{items,assetIds:[]},callback,configuration);
}

/** First publication cannot turn an untrusted original/settlement hint into late config admission. */
export function requireEditPublicationBinding(tx:Transaction<DB>,item:string):Binding {
  const binding=bindings.get(tx);
  if(!binding?.epoch || !binding.family.items.includes(item)) throw new ExpandFamily({items:[item],assetIds:binding?.family.assetIds??[]},true);
  return binding;
}

export const hasEditConfiguration = (tx:Transaction<DB>) => !!bindings.get(tx)?.epoch;

export async function lockEditFamilyAssets(tx:Transaction<DB>,ownerId:string):Promise<void> {
  const binding=bindings.get(tx);
  if(!binding) throw new ConflictException('edit_family_authority_required');
  if(binding.family.assetIds.length) await tx.selectFrom('asset').select('id').where('ownerId','=',ownerId)
    .where('id','in',binding.family.assetIds).orderBy('id').forUpdate().execute();
}
