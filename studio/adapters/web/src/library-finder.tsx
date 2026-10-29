/**
 * Add from your library inside Studio (FL-636): the bin's Library view.
 *
 * Freecut's bin holds only the media this project was handed. The Library view searches the person's
 * whole library from inside the bin, as the library's Search does (smart search, people, place, month,
 * photos or videos), through the host: the editor has no SDK and no token, so every search is a
 * `searchLibrary` service call and every result arrives as a host-authorized `StudioAssetRef`.
 *
 * A result becomes ordinary bin media when it is used: pressing, dragging or adding it asks the host
 * to adopt it (`addLibraryAssets`), which puts it in `StudioHostContext.assets`, and the seeder offers
 * it like any handoff item. Dragging then lands on the timeline through Freecut's own media drop, and
 * "Add at playhead" places it with Freecut's canvas-drop placement. The server's resource resolver
 * (FL-90) grants each placed item when the project is saved, so nothing here is an access decision.
 *
 * Locked items arrive only while the session is unlocked, and the host drops them again when it
 * locks; the panel says so in its note.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Image as ImageIcon, Loader2, Plus, Search, ShieldCheck, Video, X } from 'lucide-react'
import { toast } from 'sonner'
import type {
  StudioAssetRef,
  StudioHostContext,
  StudioLibraryFacets,
  StudioLibraryQuery,
  StudioLibraryResults,
  StudioLibraryType,
} from '@frameleaf/host/host-contract'
import { STUDIO_LIBRARY_TEXT_LIMIT } from '@frameleaf/host/frame-service-schema'
import { fillLibraryString, type LibraryPanelString } from '@frameleaf/host/library-strings'
import { registerLibraryPanel } from '@/features/media-library/library-panel-registry'
import { setMediaDragData } from '@/features/media-library/utils/drag-data-cache'
import { useMediaLibraryStore, resolveMediaUrl, importMediaLibraryService } from '@/features/preview/deps/media-library'
import {
  buildDroppedMediaTimelineItem,
  findBestCanvasDropPlacement,
  getDroppedMediaDurationInFrames,
} from '@/features/preview/deps/timeline-utils'
import { useTimelineStore } from '@/features/preview/deps/timeline-store'
import { usePlaybackStore } from '@/shared/state/playback'
import { useSelectionStore } from '@/shared/state/selection'
import { useProjectStore } from '@/features/projects/stores/project-store'
import type { MediaMetadata } from '@/types/storage'

/** How long a typed search waits for the person to stop typing. */
export const LIBRARY_SEARCH_DEBOUNCE_MS = 300
/** How long adopting a result may take before it is reported as failed. */
export const LIBRARY_ADOPT_TIMEOUT_MS = 15_000

export interface LibraryFinderHost {
  searchLibrary(query: StudioLibraryQuery): Promise<StudioLibraryResults>
  libraryFacets(): Promise<StudioLibraryFacets>
  addLibraryAssets(assetIds: string[]): Promise<StudioAssetRef[]>
  /** Offer refs to the bin now; the host's next update offers them again, which is harmless. */
  seed(assets: readonly StudioAssetRef[]): Promise<void>
}

/* ---------------- Host context: strings and language ---------------- */

interface FinderView {
  strings: Partial<Record<LibraryPanelString, string>>
  locale: string
  online: boolean
}

const ENGLISH: Record<LibraryPanelString, string> = {
  libraryTab: 'Library',
  librarySearch: 'Search your library',
  librarySuggestions: 'Try searching for',
  librarySuggestionBeach: 'dog on the beach',
  librarySuggestionSunset: 'sunset over the lake',
  librarySuggestionLaughing: 'friends laughing',
  librarySuggestionCampfire: 'campfire at night',
  libraryShow: 'Show',
  libraryAll: 'All',
  libraryPhotos: 'Photos',
  libraryVideos: 'Videos',
  libraryPeople: 'People',
  libraryPlace: 'Place',
  libraryAnywhere: 'Anywhere',
  libraryWhen: 'When',
  libraryAnyTime: 'Any time',
  libraryFacetCount: '{{label}} ({{count}})',
  libraryClearFilters: 'Clear filters',
  libraryResultOne: '1 result',
  libraryResults: '{{count}} results',
  libraryResultsFor: '{{results}} for “{{query}}”',
  libraryEmpty: 'Nothing in your library matches. Try other words or clear the filters.',
  librarySearching: 'Searching your library…',
  libraryUnavailable: 'Your library can’t be searched right now. Try again in a moment.',
  libraryMore: 'Show more',
  libraryMedia: 'Library media',
  libraryAddAtPlayhead: 'Add {{name}} at playhead',
  libraryAdded: '{{name}} added at the playhead',
  libraryAddFailed: 'This item can’t be added to Studio right now.',
  libraryNoTrack: 'There’s no free track to add this to. Unlock a track or add one, then try again.',
  libraryNote:
    'Searches your whole library, like Search. Locked items appear only while your session is unlocked.',
}

let view: FinderView = { strings: {}, locale: 'en', online: true }
const viewListeners = new Set<() => void>()
const subscribeView = (listener: () => void) => {
  viewListeners.add(listener)
  return () => {
    viewListeners.delete(listener)
  }
}
const useFinderView = () => useSyncExternalStore(subscribeView, () => view, () => view)

export const libraryText = (
  strings: FinderView['strings'],
  name: LibraryPanelString,
  values?: Readonly<Record<string, string | number>>,
): string => fillLibraryString(strings[name] || ENGLISH[name], values)

/** `2026-07` in the editor's language: "July 2026". */
export const monthLabel = (month: string, locale: string): string => {
  const [year = 0, number = 1] = month.split('-').map(Number)
  try {
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
      new Date(Date.UTC(year, number - 1, 1)),
    )
  } catch {
    return month
  }
}

/* ---------------- Adopting a result ---------------- */

/** Wait until Freecut's bin store holds this media id (the seeder created it and the bin reloaded). */
export function waitForBinMedia(mediaId: string, timeoutMs = LIBRARY_ADOPT_TIMEOUT_MS): Promise<MediaMetadata> {
  const present = () => useMediaLibraryStore.getState().mediaById[mediaId]
  const now = present()
  if (now) return Promise.resolve(now)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop()
      reject(new Error('LIBRARY_ADOPT_TIMEOUT'))
    }, timeoutMs)
    const stop = useMediaLibraryStore.subscribe(() => {
      const media = present()
      if (!media) return
      clearTimeout(timer)
      stop()
      resolve(media)
    })
  })
}

/**
 * One adoption per id at a time: pressing a tile, then dragging it, then pressing "+" share the
 * same request. A failed adoption is forgotten so the next attempt asks again.
 */
export function createAdopter(host: Pick<LibraryFinderHost, 'addLibraryAssets' | 'seed'>) {
  const pending = new Map<string, Promise<MediaMetadata>>()
  return (asset: StudioAssetRef): Promise<MediaMetadata> => {
    const existing = pending.get(asset.id)
    if (existing) return existing
    const adoption = (async () => {
      const [ref] = await host.addLibraryAssets([asset.id])
      if (!ref) throw new Error('LIBRARY_ADOPT_REFUSED')
      // Seeding also probes the media, which can take seconds for a video; the bin holds the item as
      // soon as its record exists. So the first of the two wins, but a failed seed is never dropped:
      // it rejects at once instead of waiting out the adoption timeout.
      const seeding = host.seed([ref])
      return Promise.race([waitForBinMedia(ref.id), seeding.then(() => waitForBinMedia(ref.id))])
    })()
    pending.set(asset.id, adoption)
    adoption.catch(() => pending.delete(asset.id))
    return adoption
  }
}

/**
 * Place bin media at the playhead, as a drop on the preview canvas does: the best free track at the
 * playhead, fitted to the frame, linked audio on its own track. Returns false when no track can take it.
 */
export async function placeAtPlayhead(media: MediaMetadata, label: string): Promise<boolean> {
  const mediaType = media.mimeType.startsWith('video/') ? 'video' : 'image'
  const timeline = useTimelineStore.getState()
  const selection = useSelectionStore.getState()
  const durationInFrames = getDroppedMediaDurationInFrames(media, mediaType, timeline.fps)
  const placement = findBestCanvasDropPlacement({
    tracks: timeline.tracks,
    items: timeline.items,
    activeTrackId: selection.activeTrackId,
    proposedFrame: usePlaybackStore.getState().currentFrame,
    durationInFrames,
    itemType: mediaType,
  })
  if (!placement) return false
  const blobUrl = await resolveMediaUrl(media.id)
  if (!blobUrl) throw new Error('LIBRARY_MEDIA_UNREADABLE')
  const { mediaLibraryService } = await importMediaLibraryService()
  const thumbnailUrl = await mediaLibraryService.getThumbnailBlobUrl(media.id)
  const metadata = useProjectStore.getState().currentProject?.metadata
  const item = buildDroppedMediaTimelineItem({
    media,
    mediaId: media.id,
    mediaType,
    label,
    timelineFps: timeline.fps,
    blobUrl,
    thumbnailUrl,
    canvasWidth: metadata?.width ?? 1920,
    canvasHeight: metadata?.height ?? 1080,
    placement: { trackId: placement.trackId, from: placement.from, durationInFrames },
  })
  if (item.type === 'video' && media.audioCodec) timeline.addItemWithLinkedAudio(item)
  else timeline.addItem(item)
  selection.setActiveTrack(placement.trackId)
  selection.selectItems([item.id])
  return true
}

/* ---------------- The panel ---------------- */

const shortDuration = (asset: StudioAssetRef) => {
  if (!asset.duration) return null
  const total = Math.round(asset.duration.num / asset.duration.den)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

interface ResultTileProps {
  asset: StudioAssetRef
  strings: FinderView['strings']
  adopt: (asset: StudioAssetRef) => Promise<MediaMetadata>
  onAdd: (asset: StudioAssetRef) => void
  busy: boolean
}

/** A result in the bin's own tile shape: thumbnail, name, length; drag it or add it at the playhead. */
function ResultTile({ asset, strings, adopt, onAdd, busy }: ResultTileProps) {
  const duration = shortDuration(asset)
  const startAdoption = () => void adopt(asset).catch(() => undefined)
  const onDragStart = (event: React.DragEvent) => {
    startAdoption()
    const dragData = {
      type: 'media-item' as const,
      mediaId: asset.id,
      mediaType: asset.kind,
      fileName: asset.name,
      duration: asset.duration ? asset.duration.num / asset.duration.den : 0,
    }
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData('application/json', JSON.stringify(dragData))
    setMediaDragData(dragData)
  }
  return (
    <div
      role="listitem"
      className="group relative rounded-md border border-border bg-secondary overflow-hidden"
      draggable={!asset.isOffline}
      onPointerDown={asset.isOffline ? undefined : startAdoption}
      onDragStart={asset.isOffline ? undefined : onDragStart}
      data-library-result={asset.id}
      title={asset.name}
    >
      <div className="relative aspect-video bg-muted">
        <img src={asset.thumbnailUrl} alt="" className="w-full h-full object-cover" draggable={false} loading="lazy" />
        <span className="absolute top-1 start-1 rounded bg-black/60 text-white p-0.5">
          {asset.kind === 'video' ? <Video className="w-3 h-3" /> : <ImageIcon className="w-3 h-3" />}
        </span>
        {duration && (
          <span className="absolute bottom-1 end-1 rounded bg-black/60 text-white text-[10px] px-1 tabular-nums">
            {duration}
          </span>
        )}
        <button
          type="button"
          className="absolute top-1 end-1 h-6 w-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center opacity-90 hover:opacity-100 focus-visible:opacity-100 disabled:opacity-50"
          aria-label={libraryText(strings, 'libraryAddAtPlayhead', { name: asset.name })}
          disabled={busy || asset.isOffline}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onAdd(asset)}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
        </button>
      </div>
      <p className="px-1.5 py-1 text-[11px] truncate text-foreground">{asset.name}</p>
    </div>
  )
}

type Filters = { type: StudioLibraryType; personId: string | null; city: string | null; month: string | null }
const NO_FILTERS: Filters = { type: 'all', personId: null, city: null, month: null }

export function LibraryFinderPanel({ host, className }: { host: LibraryFinderHost; className?: string }) {
  const { strings, locale, online } = useFinderView()
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [facets, setFacets] = useState<StudioLibraryFacets | null>(null)
  const [results, setResults] = useState<StudioAssetRef[]>([])
  const [nextPage, setNextPage] = useState<number | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [adding, setAdding] = useState<string | null>(null)
  const request = useRef(0)
  const adopt = useMemo(() => createAdopter(host), [host])

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), LIBRARY_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text])

  useEffect(() => {
    let live = true
    host.libraryFacets().then(
      (found) => live && setFacets(found),
      () => live && setFacets({ people: [], places: [], months: [] }),
    )
    return () => {
      live = false
    }
  }, [host])

  const search = useCallback(
    async (page: number) => {
      const id = ++request.current
      setStatus('loading')
      // A new first page replaces the old results: none of them may stay behind a search they don't match.
      if (page === 1) {
        setResults([])
        setNextPage(null)
      }
      try {
        const found = await host.searchLibrary({ text: query || null, ...filters, page })
        if (id !== request.current) return
        setResults((previous) => {
          if (page === 1) return found.items
          const known = new Set(previous.map((asset) => asset.id))
          return [...previous, ...found.items.filter((asset) => !known.has(asset.id))]
        })
        setNextPage(found.nextPage)
        setStatus('idle')
      } catch {
        if (id === request.current) setStatus('failed')
      }
    },
    [host, query, filters],
  )

  useEffect(() => {
    if (online) void search(1)
  }, [search, online])

  const onAdd = useCallback(
    async (asset: StudioAssetRef) => {
      setAdding(asset.id)
      try {
        const media = await adopt(asset)
        if (await placeAtPlayhead(media, asset.name)) {
          toast.success(libraryText(strings, 'libraryAdded', { name: asset.name }))
        } else {
          toast.warning(libraryText(strings, 'libraryNoTrack'))
        }
      } catch {
        toast.error(libraryText(strings, 'libraryAddFailed'))
      } finally {
        setAdding((current) => (current === asset.id ? null : current))
      }
    },
    [adopt, strings],
  )

  const filtered =
    filters.type !== 'all' || filters.personId !== null || filters.city !== null || filters.month !== null
  const suggestions: LibraryPanelString[] = [
    'librarySuggestionBeach',
    'librarySuggestionSunset',
    'librarySuggestionLaughing',
    'librarySuggestionCampfire',
  ]
  const count =
    results.length === 1
      ? libraryText(strings, 'libraryResultOne')
      : libraryText(strings, 'libraryResults', { count: `${results.length}${nextPage ? '+' : ''}` })
  const types: Array<{ id: StudioLibraryType; label: LibraryPanelString }> = [
    { id: 'all', label: 'libraryAll' },
    { id: 'photo', label: 'libraryPhotos' },
    { id: 'video', label: 'libraryVideos' },
  ]

  return (
    <div className={`${className ?? ''} flex flex-col min-h-0`} data-frameleaf-library-finder="">
      <div className="px-4 pt-1 pb-2 space-y-2 flex-shrink-0">
        <label className="relative group block">
          <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="search"
            maxLength={STUDIO_LIBRARY_TEXT_LIMIT}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={libraryText(strings, 'librarySearch')}
            aria-label={libraryText(strings, 'librarySearch')}
            className="w-full ps-8 pe-7 h-7 rounded-md bg-secondary border border-border focus:border-primary outline-none text-foreground placeholder:text-muted-foreground text-xs"
          />
          {text && (
            <button
              type="button"
              aria-label={libraryText(strings, 'libraryClearFilters')}
              onClick={() => setText('')}
              className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-primary"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </label>

        {!text.trim() && (
          <div className="flex flex-wrap gap-1" role="group" aria-label={libraryText(strings, 'librarySuggestions')}>
            {suggestions.map((name) => (
              <button
                key={name}
                type="button"
                className="h-6 px-2 rounded-full border border-border bg-secondary text-[11px] text-muted-foreground hover:text-foreground hover:border-primary/50"
                onClick={() => setText(libraryText(strings, name))}
              >
                {libraryText(strings, name)}
              </button>
            ))}
          </div>
        )}

        <div
          role="group"
          aria-label={libraryText(strings, 'libraryShow')}
          className="inline-flex items-center h-7 rounded-md border border-border bg-secondary p-0.5"
        >
          {types.map((type) => (
            <button
              key={type.id}
              type="button"
              aria-pressed={filters.type === type.id}
              onClick={() => setFilters((current) => ({ ...current, type: type.id }))}
              className={`h-6 px-2 rounded-[3px] text-[11px] ${
                filters.type === type.id
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {libraryText(strings, type.label)}
            </button>
          ))}
        </div>

        {facets && facets.people.length > 0 && (
          <div
            role="group"
            aria-label={libraryText(strings, 'libraryPeople')}
            className="flex gap-2 overflow-x-auto pb-1"
          >
            {facets.people.map((person) => {
              const on = filters.personId === person.id
              return (
                <button
                  key={person.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFilters((current) => ({ ...current, personId: on ? null : person.id }))}
                  className="flex flex-col items-center gap-0.5 w-12 flex-shrink-0 text-[10px] text-muted-foreground"
                >
                  <img
                    src={person.thumbnailUrl}
                    alt=""
                    className={`w-8 h-8 rounded-full object-cover border-2 ${on ? 'border-primary' : 'border-transparent'}`}
                  />
                  <span className={`truncate w-full text-center ${on ? 'text-foreground' : ''}`}>{person.name}</span>
                </button>
              )
            })}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
            <span>{libraryText(strings, 'libraryPlace')}</span>
            <select
              value={filters.city ?? ''}
              onChange={(event) => setFilters((current) => ({ ...current, city: event.target.value || null }))}
              className="h-7 rounded-md bg-secondary border border-border text-xs text-foreground px-1"
            >
              <option value="">{libraryText(strings, 'libraryAnywhere')}</option>
              {facets?.places.map((place) => (
                <option key={place.value} value={place.value}>
                  {libraryText(strings, 'libraryFacetCount', { label: place.value, count: place.count })}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
            <span>{libraryText(strings, 'libraryWhen')}</span>
            <select
              value={filters.month ?? ''}
              onChange={(event) => setFilters((current) => ({ ...current, month: event.target.value || null }))}
              className="h-7 rounded-md bg-secondary border border-border text-xs text-foreground px-1"
            >
              <option value="">{libraryText(strings, 'libraryAnyTime')}</option>
              {facets?.months.map((month) => (
                <option key={month.value} value={month.value}>
                  {libraryText(strings, 'libraryFacetCount', {
                    label: monthLabel(month.value, locale),
                    count: month.count,
                  })}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground" aria-live="polite">
          <span>
            {status === 'loading' && results.length === 0
              ? libraryText(strings, 'librarySearching')
              : query
                ? libraryText(strings, 'libraryResultsFor', { results: count, query })
                : count}
          </span>
          {filtered && (
            <button type="button" className="text-primary hover:underline" onClick={() => setFilters(NO_FILTERS)}>
              {libraryText(strings, 'libraryClearFilters')}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-2">
        <div role="list" aria-label={libraryText(strings, 'libraryMedia')} className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
          {results.map((asset) => (
            <ResultTile
              key={asset.id}
              asset={asset}
              strings={strings}
              adopt={adopt}
              onAdd={(item) => void onAdd(item)}
              busy={adding === asset.id}
            />
          ))}
        </div>
        {status === 'failed' && (
          <p className="text-xs text-muted-foreground py-3" role="status">
            {libraryText(strings, 'libraryUnavailable')}
          </p>
        )}
        {status !== 'failed' && status !== 'loading' && results.length === 0 && (
          <p className="text-xs text-muted-foreground py-3">{libraryText(strings, 'libraryEmpty')}</p>
        )}
        {nextPage && (
          <button
            type="button"
            disabled={status === 'loading'}
            onClick={() => void search(nextPage)}
            className="mt-2 w-full h-7 rounded-md border border-border bg-secondary text-xs text-muted-foreground hover:text-foreground"
          >
            {status === 'loading' ? <Loader2 className="inline w-3 h-3 animate-spin" /> : libraryText(strings, 'libraryMore')}
          </button>
        )}
      </div>

      <p className="px-4 py-2 border-t border-border flex items-start gap-1.5 text-[10px] text-muted-foreground flex-shrink-0">
        <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
        <span>{libraryText(strings, 'libraryNote')}</span>
      </p>
    </div>
  )
}

/* ---------------- Wiring ---------------- */

/**
 * Offer the Library view in the bin for this editor document. `update` follows the host context
 * (language, strings, online); `dispose` withdraws the view.
 */
export function createLibraryFinder(host: LibraryFinderHost) {
  let withdraw: (() => void) | null = null
  let label = ''
  let disposed = false
  const Panel = ({ className }: { className?: string }) => <LibraryFinderPanel host={host} className={className} />
  return {
    update(context: Pick<StudioHostContext, 'strings' | 'auth' | 'online'>) {
      if (disposed) return
      view = { strings: { ...context.strings }, locale: context.auth.locale, online: context.online }
      for (const listener of viewListeners) listener()
      const next = libraryText(view.strings, 'libraryTab')
      if (next !== label || !withdraw) {
        label = next
        withdraw?.()
        withdraw = registerLibraryPanel({ label, Panel })
      }
    },
    dispose() {
      disposed = true
      withdraw?.()
      withdraw = null
    },
  }
}
