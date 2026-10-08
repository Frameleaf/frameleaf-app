import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Transaction, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AssetStatus } from 'src/enum.js';
import { AssetLocalEffectRepository } from 'src/repositories/asset-local-effect.repository.js';
import { currentAuth } from 'src/repositories/icloud-audit.repository.js';
import type { EditPublication } from 'src/repositories/icloud-edit-authority.repository.js';
import { requireEditPublicationBinding } from 'src/repositories/icloud-edit-transaction.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { DB } from 'src/schema/index.js';
import { TrashReviewAction } from 'src/utils/trash-review.js';

export type EditPolicyReceipt = {
  formatVersion: 1;
  config: { epoch: number; digest: string };
  authority: { generation: number; holder: string; currentVersionId: string; versionId: string };
  proofs: { assetId: string; versionId: string; sha256: string; isOriginal: boolean }[];
  stack: { stackId: string; primaryAssetId: string; memberAssetIds: string[] };
  trashedAssetIds: string[];
  effect: { effectId: string; streamEpoch: string; sequence: string };
};
function review(reason: string): never { throw new ConflictException(reason); }

/** Same-transaction private policy receipt; administrative bindings never imply provider order. */
export async function applyEditPolicyWithin(tx: Transaction<DB>, ownerId: string, publication: EditPublication,
  assetId: string, sessionId: string): Promise<EditPolicyReceipt> {
  const binding = requireEditPublicationBinding(tx, publication.item);
  const authority = await tx.selectFrom('icloud_edit_authority').selectAll().where('ownerId','=',ownerId)
    .where('item','=',publication.item).executeTakeFirstOrThrow();
  if(authority.generation!==publication.generation || authority.holder!==publication.holder) review('edit_owner_stale');
  const versions = await tx.selectFrom('icloud_edit_version').selectAll().where('ownerId','=',ownerId)
    .where('item','=',publication.item).orderBy('assetId').limit(101).execute();
  if(versions.length>100) review('edit_family_too_large');
  const members=[...new Set([...versions.map(v=>v.assetId),assetId])].sort();
  if(versions.some(v=>!binding.family.assetIds.includes(v.assetId))) review('edit_family_unstable');
  const assets=await tx.selectFrom('asset').select(['id','ownerId','status','deletedAt','stackId'])
    .where('id','in',members).orderBy('id').forUpdate().execute();
  if(assets.length!==members.length || assets.some(a=>a.ownerId!==ownerId || (a.status!==AssetStatus.Active && a.status!==AssetStatus.Trashed))) review('edit_evidence_unavailable');
  const stackIds=[...new Set(assets.flatMap(a=>a.stackId ? [a.stackId]:[]))].sort();
  if(stackIds.length>1) review('edit_manual_stack_conflict');
  const stack=stackIds.length ? await tx.selectFrom('stack').selectAll().where('id','=',stackIds[0]).where('ownerId','=',ownerId)
    .forUpdate().executeTakeFirst() : undefined;
  const existingMembers=stack ? await tx.selectFrom('asset').select('id').where('stackId','=',stack.id).orderBy('id').execute():[];
  if(stack && existingMembers.some(a=>!members.includes(a.id))) review('edit_manual_stack_conflict');
  const decisions=await tx.selectFrom('icloud_edit_decision').select('evidence').where('ownerId','=',ownerId)
    .where('item','=',publication.item).where('assetId','is not',null).execute();
  const applied=decisions.map(d=>d.evidence.publication as EditPolicyReceipt|undefined)
    .filter((r):r is EditPolicyReceipt=>!!r && r.formatVersion===1 && r.authority.versionId===authority.currentVersionId);
  const sourceStates=stack ? (await sql<{state: unknown}>`SELECT source#>'{_sync,relations}' AS state FROM icloud_resource
    WHERE "ownerId"=${ownerId}::uuid AND source#>>'{_sync,relations,stackId}'=${stack.id}`.execute(tx)).rows.map(r=>r.state as {stackId:string;appliedPrimaryAssetId:string;memberAssetIds:string[]}) : [];
  const fences=[...applied.map(r=>r.stack),...sourceStates.map(s=>({stackId:s.stackId,primaryAssetId:s.appliedPrimaryAssetId,memberAssetIds:[...(s.memberAssetIds??[])].sort()}))];
  if(stack && (!fences.length || fences.some(f=>f.stackId!==stack.id || f.primaryAssetId!==stack.primaryAssetId || !isDeepStrictEqual([...f.memberAssetIds].sort(),existingMembers.map(a=>a.id))))) review('edit_manual_stack_conflict');
  // All waits precede the current session/PIN/privacy and byte proof checks.
  const live=await currentAuth(tx,ownerId,sessionId,true);
  if(!live) throw new ForbiddenException('edit_owner_session_required');
  const proofs:EditPolicyReceipt['proofs']=[];
  for(const v of versions) {
    const a=assets.find(a=>a.id===v.assetId)!;
    const safe=await new IntegrityRepository(tx).getLifecycleSafetyQuery(live,a.status as AssetStatus.Active|AssetStatus.Trashed,[v.sha256.toString('hex')])
      .where('asset.id','=',v.assetId).executeTakeFirst();
    if(!safe) review('edit_evidence_unavailable');
    const receipt=await sql`SELECT 1 FROM icloud_source_identity WHERE "ownerId"=${ownerId}::uuid AND "assetId"=${v.assetId}::uuid
      AND upper("cplAssetRecordName")=${publication.item} AND sha256=${v.sha256} AND role=${v.isOriginal?'original':'edit-render'}
      UNION ALL SELECT 1 FROM icloud_edit_decision d JOIN asset_upload_resource r ON r.id=d."resourceId" AND r."ownerId"=d."ownerId"
      WHERE d."ownerId"=${ownerId}::uuid AND d.item=${publication.item} AND d."versionId"=${v.id}::uuid AND d.channel='device'
        AND d."assetId"=${v.assetId}::uuid AND r."resultAssetId"=d."assetId" AND r.state='published'
        AND r."verifiedChecksum"=${v.sha256} AND d.evidence->>'sha256'=encode(${v.sha256}::bytea,'hex') LIMIT 1`.execute(tx);
    if(!receipt.rows.length) review('edit_member_evidence_unproven');
    proofs.push({assetId:v.assetId,versionId:v.id,sha256:v.sha256.toString('hex'),isOriginal:v.isOriginal});
  }
  const incoming=await new IntegrityRepository(tx).getSafetyQuery(live,[publication.sha256.toString('hex')]).where('asset.id','=',assetId).executeTakeFirst();
  if(!incoming) review('edit_evidence_unavailable');
  const trash=publication.policy==='supersede' ? versions.filter(v=>!v.isOriginal && v.assetId!==assetId && assets.find(a=>a.id===v.assetId)!.status===AssetStatus.Active).map(v=>v.assetId).sort():[];
  if(trash.length) {
    if(!binding.epoch!.trashEnabled) review('edit_trash_disabled');
    const shared=await tx.selectFrom('icloud_edit_authority as a').innerJoin('icloud_edit_version as v','v.id','a.currentVersionId')
      .select('v.assetId').where('a.ownerId','=',ownerId).where('a.item','!=',publication.item).where('v.assetId','in',trash).execute();
    if(shared.length) review('edit_shared_current_conflict');
    const privacy=live.hiddenContent??live.hideNsfwAssets;
    const changed=await new TrashRepository(tx).applyReviewedWithin(tx,ownerId,TrashReviewAction.Trash,trash,
      {lockedOwnerId:live.session?.hasElevatedPermission?ownerId:undefined,privacy:typeof privacy==='object'?{hiddenContent:privacy}:privacy?{excludeNsfw:true}:{}},
      rows=>isDeepStrictEqual(rows.map(r=>r.id).sort(),trash));
    if(!changed || changed.length!==trash.length) review('edit_evidence_unavailable');
  }
  const activeCount=versions.filter(v=>!v.isOriginal && v.assetId!==assetId && assets.find(a=>a.id===v.assetId)!.status===AssetStatus.Active && !trash.includes(v.assetId)).length;
  if(activeCount>=20 && !versions.some(v=>v.assetId===assetId)) review('edit_capacity_reached');
  const stackId=stack?.id??randomUUID();
  if(!stack) await tx.insertInto('stack').values({id:stackId,ownerId,primaryAssetId:assetId}).execute();
  else {
    const changed=await tx.updateTable('stack').set({primaryAssetId:assetId}).where('id','=',stackId)
      .where('primaryAssetId','=',stack.primaryAssetId).returning('id').execute();
    if(changed.length!==1) review('edit_manual_stack_conflict');
  }
  await tx.updateTable('asset').set({stackId}).where('ownerId','=',ownerId).where('id','in',members).execute();
  const effect=await new AssetLocalEffectRepository(tx).append(tx,ownerId,publication.decisionId,{origin:{kind:'publication',decisionId:publication.decisionId},
    assets:[{assetId,status:AssetStatus.Active,revoke:false},...trash.map(assetId=>({assetId,status:AssetStatus.Trashed as const,revoke:true}))],
    stacks:[{stackId,primaryAssetId:assetId,memberAssetIds:members}]});
  return {formatVersion:1,config:{epoch:binding.epoch!.epoch,digest:binding.epoch!.digest},
    authority:{generation:publication.generation,holder:publication.holder,currentVersionId:authority.currentVersionId,versionId:publication.versionId},
    proofs,stack:{stackId,primaryAssetId:assetId,memberAssetIds:members},trashedAssetIds:trash,
    effect:{effectId:effect.effectId,streamEpoch:effect.streamEpoch,sequence:effect.sequence}};
}
