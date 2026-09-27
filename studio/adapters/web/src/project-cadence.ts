/**
 * The exact project cadence the adapter stores (FL-93). Freecut keeps its frame rate as the float
 * `metadata.fps`; the stored graph carries `metadata.frameRate` beside it, as `{ num, den }`, so the
 * server, the host and the headless render read 30000/1001 rather than a rounded decimal.
 */
import type { Project } from '@/types/project'
import { resolveAutoMatchProjectFps } from '@/features/projects/utils/project-fps'
import { withProjectCadence } from '@frameleaf/host/studio-timing'

/** The handed-over videos' shared frame rate when it is exactly one of the editor's project rates. */
export function handoffProjectFps(
  handoff: readonly string[],
  media: ReadonlyArray<{ id: string; mimeType: string; fps: number }>,
): number {
  const rates = new Set(
    media
      .filter((record) => handoff.includes(record.id) && record.mimeType.startsWith('video/'))
      .map((record) => record.fps),
  )
  if (rates.size !== 1) return 30
  const [rate] = rates
  const matched = resolveAutoMatchProjectFps(rate)
  return matched.exact && Number.isInteger(rate) ? matched.fps : 30
}

/**
 * FL-93: an existing project gains its exact cadence when it is opened, so its next save stores it.
 * A legacy graph whose `fps` has no exact reading is left as it is rather than given a guessed one.
 */
export function withStoredCadence(graph: Project): Project {
  if (!graph.metadata || typeof graph.metadata !== 'object') return graph
  try {
    return { ...graph, metadata: withProjectCadence(graph.metadata) }
  } catch {
    return graph
  }
}

