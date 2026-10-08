import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AssetStatus, AssetType, MediaOperationDestination, MediaOperationKind } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { AssetLocalEffectRepository } from 'src/repositories/asset-local-effect.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { ItemShareRepository } from 'src/repositories/item-share.repository.js';
import { DB } from 'src/schema/index.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { StudioDestination } from 'src/utils/studio-resources.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async()=> { db=await getKyselyDB(); });
afterAll(async()=> { await db.destroy(); });

it.each(['owner','shared'] as const)('C2 RED: old %s source grant remains revoked after identical-byte restore; fresh admission remains valid',async audience=>{
  const {sut,ctx}=newMediumService(StudioResourceService,{database:db,real:[AccessRepository,AssetRepository,CryptoRepository,IntegrityRepository],mock:[LoggingRepository]});
  const {user:owner}=await ctx.newUser();
  const {user:viewer}=audience==='owner'?{user:owner}:await ctx.newUser();
  const {asset}=await ctx.newAsset({ownerId:owner.id,type:AssetType.Image});
  if(audience==='shared') await new ItemShareRepository(db).add(owner.id,[asset.id],[viewer.id]);
  const auth=factory.auth({user:viewer});
  const context={projectId:randomUUID(),ownerId:viewer.id,revision:1,graph:{id:'sequence',tracks:[{id:'video',kind:'video',clips:[{assetId:asset.id}]}]},destination:StudioDestination.Local};
  const before=(await sut.resolveProjectResources(auth,context)).manifest;
  expect(before.complete).toBe(true);
  const token=sut.issuePreviewGrant(before,{workerId:'actual-worker'});
  expect((await sut.verifyReadGrant(token,{workerId:'actual-worker',auth})).valid).toBe(true);
  const repo=new AssetLocalEffectRepository(db);
  const transition=(status:AssetStatus.Active|AssetStatus.Trashed)=>db.transaction().execute(async tx=>{
    await tx.updateTable('asset').set({status,deletedAt:status===AssetStatus.Trashed?new Date():null}).where('id','=',asset.id).execute();
    return repo.append(tx,owner.id,randomUUID(),{origin:{kind:status===AssetStatus.Trashed?'trash':'restore'},assets:[{assetId:asset.id,status,revoke:status===AssetStatus.Trashed}],stacks:[]});
  });
  await transition(AssetStatus.Trashed);
  expect((await sut.verifyReadGrant(token,{workerId:'actual-worker',auth})).valid).toBe(false);
  await transition(AssetStatus.Active);
  expect((await sut.verifyReadGrant(token,{workerId:'actual-worker',auth})).valid).toBe(false);
  const fresh=(await sut.resolveProjectResources(auth,context)).manifest;
  expect(fresh.digest).not.toBe(before.digest);
  const operations = new MediaOperationRepository(db);
  const request = (sourceEpochs: typeof fresh.sourceEpochs) => ({ ownerId: viewer.id, kind: MediaOperationKind.StudioExport, destination: MediaOperationDestination.Local,
    label: 'actual source admission', snapshot: { kind: 'studio-export', sourceEpochs }, settings: {} });
  await expect(operations.create(request(before.sourceEpochs))).rejects.toThrow('studio_source_admission_changed');
  expect((await operations.create(request(fresh.sourceEpochs))).snapshot.sourceEpochs).toEqual(fresh.sourceEpochs);
  const newToken=sut.issuePreviewGrant(fresh,{workerId:'actual-worker'});
  expect((await sut.verifyReadGrant(newToken,{workerId:'actual-worker',auth})).valid).toBe(true);
});
