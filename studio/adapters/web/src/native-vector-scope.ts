import { zipSync } from 'fflate'
import {
  describeLottieArchive,
  assertClosedLottieAnimation,
  assertArchiveExpressionsAbsent,
  parseArchiveJson,
  selectArchiveAnimation,
  rasterMime,
  archiveFontMime,
} from '@/infrastructure/lottie/lottie-archive'
import type { StudioHostContext } from '@frameleaf/host/host-contract'
import type { StudioSourceParentDto, StudioSourceSelectionDto } from '@frameleaf/sdk'
import { isStudioSourceRequest } from '@frameleaf/host/frame-service-schema'
import { studioSourceJson, verifyStudioSourceResult } from '@frameleaf/host/source-resolution'
import { call } from './host-port'
import type { ClosedVectorScope } from './closed-vector-sources'

type Use = { type?: string; mediaId?: string; graphicId?: string; animationId?: string; themeId?: string }

/** Source declarations restrict the server call; only the canonical saved revision grants bytes. */
export function nativeVectorScope(
  context: StudioHostContext,
  engineProjectId: string,
  generation: number,
  isCurrent: () => boolean,
): ClosedVectorScope {
  const graph = context.project.graph as {
    timeline?: { items?: Use[]; compositions?: Array<{ items?: Use[] }> }
    studioVectorDependencies?: { bindings?: Array<{ parent?: StudioSourceParentDto }> }
  } | null
  const uses = [
    ...(graph?.timeline?.items ?? []),
    ...(graph?.timeline?.compositions ?? []).flatMap((composition) => composition.items ?? []),
  ].filter((item) => item.type === 'lottie')
  const ids = new Set((context.projectImports ?? []).filter((item) => item.kind === 'vector').map((item) => item.id))
  for (const item of uses) if (item.mediaId) ids.add(item.mediaId)
  const expected = new Map<string, StudioSourceParentDto>()
  const contradictions = new Set<string>()
  const remember = (parent: StudioSourceParentDto) => {
    const previous = expected.get(parent.id)
    if (previous && studioSourceJson(previous) !== studioSourceJson(parent)) contradictions.add(parent.id)
    expected.set(parent.id, parent)
  }
  for (const item of context.projectImports ?? []) {
    if (item.kind !== 'vector' || !item.checksum) continue
    const placed = uses.filter((use) => use.mediaId === item.id)
    const kinds = new Set(placed.map((use) => use.graphicId === item.id ? 'vector-graphic' : 'project-import'))
    if (kinds.size > 1) contradictions.add(item.id)
    remember({ id: item.id, checksum: item.checksum, kind: kinds.has('vector-graphic') ? 'vector-graphic' : 'project-import' } as StudioSourceParentDto)
  }
  for (const binding of graph?.studioVectorDependencies?.bindings ?? []) {
    if (binding.parent) remember(binding.parent)
  }
  const scope = { userId: context.auth.userId, projectId: context.project.id, graphVersion: context.project.graphVersion ?? 0 }
  const current = () => isCurrent() && context.online && context.project.hasLease &&
    !!context.project.graphDigest && !!context.project.leaseExpiresAt &&
    Date.parse(context.project.leaseExpiresAt) > Date.now() && !context.draftHeld
  return {
    key: studioSourceJson({ context: { project: context.project, sourceEpoch: context.sourceEpoch,
      imports: context.projectImports, assets: context.assets, online: context.online, userId: context.auth.userId },
      engineProjectId, generation }),
    ids,
    current,
    async load(mediaId, signal) {
      const owned: Uint8Array[] = []
      let expiresAt = Infinity
      const check = () => {
        signal.throwIfAborted()
        if (!current() || Date.now() >= expiresAt) throw new Error('VECTOR_SOURCE_SUPERSEDED')
      }
      try {
        check()
        const parent = expected.get(mediaId)
        const placed = uses.filter((item) => item.mediaId === mediaId)
        if (!parent || !placed.length || contradictions.has(mediaId)) throw new Error('VECTOR_SOURCE_REFUSED')
        // Validate each root/composition use before selecting one request; deduplication cannot hide a bad use.
        const selections: StudioSourceSelectionDto[] = placed.map((item) => ({
          ...(item.animationId !== undefined && { animationId: item.animationId }),
          ...(item.themeId !== undefined && { themeId: item.themeId }),
        }))
        for (const selection of selections) {
          if (!isStudioSourceRequest({ revision: context.project.revision, graphDigest: context.project.graphDigest, parent, selection }))
            throw new Error('VECTOR_SOURCE_REFUSED')
        }
        const request = { revision: context.project.revision, graphDigest: context.project.graphDigest!, parent, selection: selections[0]! }
        const result = await call('resolveStudioProjectSource', request, scope)
        check()
        expiresAt = Math.min(Date.parse(result.expiresAt), Date.parse(context.project.leaseExpiresAt!))
        const { files, decoded, encoded } = await verifyStudioSourceResult(result, request, scope.projectId, check, owned)
        check()
        // Parsing holds UTF16 text/tokens/objects as well as file/ZIP/Blob bytes; reserve before parsing.
        if (encoded * 2 + decoded * 12 + result.files.length * 16 * 1024 > 32 * 1024 * 1024)
          throw new Error('VECTOR_SOURCE_ALLOCATION_LIMIT')
        if (result.archive) {
          const archive = describeLottieArchive(files)
          for (const [path, bytes] of Object.entries(files)) {
            if (/^(?:i|images)\//.test(path)) rasterMime(bytes)
            if (path.startsWith('f/')) archiveFontMime(bytes)
          }
          for (const animation of archive.animations) assertClosedLottieAnimation(animation.document, files)
          for (const selection of selections) {
            const animation = selectArchiveAnimation(archive, selection.animationId)
            if (selection.themeId && (!archive.themes.has(selection.themeId) ||
                (animation.themes && !animation.themes.includes(selection.themeId)))) throw new Error('VECTOR_SOURCE_SELECTION_CHANGED')
          }
        } else {
          if (Object.keys(files).length !== 1 || !files['animation.json'] ||
              selections.some((selection) => selection.animationId || selection.themeId)) throw new Error('VECTOR_SOURCE_REFUSED')
          const document = parseArchiveJson(new TextDecoder('utf-8', { fatal: true }).decode(files['animation.json']))
          if (typeof document.v !== 'string' || !Array.isArray(document.layers)) throw new Error('VECTOR_SOURCE_REFUSED')
          assertArchiveExpressionsAbsent(document)
          assertClosedLottieAnimation(document)
        }
        check()
        const bytes = result.archive ? zipSync(files, { level: 0 }) : files['animation.json']!
        if (result.archive) owned.push(bytes)
        check()
        const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], {
          type: result.archive ? 'application/zip+dotlottie' : 'application/lottie+json',
        })
        check()
        return { blob, expiresAt }
      } finally {
        for (const bytes of owned) bytes.fill(0)
      }
    },
  }
}
