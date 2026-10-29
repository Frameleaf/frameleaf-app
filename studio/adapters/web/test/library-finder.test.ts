import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StudioAssetRef, StudioLibraryFacets } from '@frameleaf/host/host-contract'
import { getLibraryPanel } from '@/features/media-library/library-panel-registry'
import { getMediaDragData, clearMediaDragData } from '@/features/media-library/utils/drag-data-cache'
import { useMediaLibraryStore } from '@/features/media-library/stores/media-library-store'
import type { MediaMetadata } from '@/types/storage'
import {
  LIBRARY_SEARCH_DEBOUNCE_MS,
  LibraryFinderPanel,
  createAdopter,
  createLibraryFinder,
  monthLabel,
  type LibraryFinderHost,
} from '../src/library-finder'

;(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const PERSON = '11111111-1111-4111-8111-111111111111'
const asset = (id: string, kind: 'image' | 'video' = 'image'): StudioAssetRef => ({
  id,
  kind,
  name: `${id}.${kind === 'video' ? 'mp4' : 'jpg'}`,
  duration: kind === 'video' ? { num: 25, den: 2 } : null,
  thumbnailUrl: `/api/assets/${id}/thumbnail`,
  previewUrl: `/api/assets/${id}/thumbnail?size=preview`,
  playbackUrl: kind === 'video' ? `/api/assets/${id}/video/playback` : null,
  isOffline: false,
})
const BEACH = asset('aaaaaaaa-0000-4000-8000-000000000001')
const LAKE = asset('aaaaaaaa-0000-4000-8000-000000000002', 'video')
const facets: StudioLibraryFacets = {
  people: [{ id: PERSON, name: 'Jamie', count: 4, thumbnailUrl: `/api/people/${PERSON}/thumbnail` }],
  places: [{ value: 'Banff', count: 3 }],
  months: [{ value: '2026-07', count: 5 }],
}
/** The host's strings, marked so the test can tell host text from the adapter's English fallback. */
const strings = {
  libraryTab: '[Library]',
  librarySearch: '[Search your library]',
  libraryNote: '[note]',
  libraryResults: '[{{count}} results]',
  libraryResultsFor: '[{{results}} for {{query}}]',
  libraryClearFilters: '[Clear filters]',
  libraryAddAtPlayhead: '[Add {{name}}]',
}
const context = { strings, auth: { locale: 'en' }, online: true } as never

const media = (id: string): MediaMetadata =>
  ({ id, fileName: `${id}.jpg`, mimeType: 'image/jpeg', duration: 0 }) as MediaMetadata

let root: Root
let element: HTMLElement
let host: { [K in keyof LibraryFinderHost]: ReturnType<typeof vi.fn> }
beforeEach(() => {
  host = {
    searchLibrary: vi.fn().mockResolvedValue({ items: [BEACH, LAKE], nextPage: null }),
    libraryFacets: vi.fn().mockResolvedValue(facets),
    addLibraryAssets: vi.fn(async (ids: string[]) => [BEACH, LAKE].filter((item) => ids.includes(item.id))),
    seed: vi.fn(async (assets: StudioAssetRef[]) => {
      useMediaLibraryStore.setState({
        mediaById: {
          ...useMediaLibraryStore.getState().mediaById,
          ...Object.fromEntries(assets.map((item) => [item.id, media(item.id)])),
        },
      })
    }),
  }
  useMediaLibraryStore.setState({ mediaById: {} })
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
})
afterEach(async () => {
  await act(async () => root.unmount())
  element.remove()
  clearMediaDragData()
})

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, LIBRARY_SEARCH_DEBOUNCE_MS + 50)))
const show = async () => {
  const finder = createLibraryFinder(host as unknown as LibraryFinderHost)
  finder.update(context)
  await act(async () => root.render(createElement(LibraryFinderPanel, { host: host as unknown as LibraryFinderHost })))
  await settle()
  return finder
}
const button = (label: string) =>
  [...element.querySelectorAll('button')].find(
    (item) => item.textContent === label || item.getAttribute('aria-label') === label,
  )!

describe('FL-636 the bin Library view', () => {
  it('offers itself in the bin under the host label, and withdraws on dispose', () => {
    const finder = createLibraryFinder(host as unknown as LibraryFinderHost)
    finder.update(context)
    expect(getLibraryPanel()?.label).toBe('[Library]')
    finder.dispose()
    expect(getLibraryPanel()).toBeNull()
  })

  it('searches the whole library through the host and shows the results, count and privacy note', async () => {
    await show()
    expect(host.searchLibrary).toHaveBeenCalledWith({
      text: null,
      type: 'all',
      personId: null,
      city: null,
      month: null,
      page: 1,
    })
    const tiles = element.querySelectorAll('[data-library-result]')
    expect([...tiles].map((tile) => tile.getAttribute('data-library-result'))).toEqual([BEACH.id, LAKE.id])
    expect(element.textContent).toContain('[2 results]')
    expect(element.textContent).toContain('[note]')
    expect(element.querySelector('input')?.getAttribute('aria-label')).toBe('[Search your library]')
  })

  it('runs a smart search for typed words, once typing stops', async () => {
    await show()
    const input = element.querySelector('input')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'dog on the beach')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle()
    expect(host.searchLibrary).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'dog on the beach', page: 1 }))
    expect(element.textContent).toContain('[[2 results] for dog on the beach]')
  })

  it('filters by a named person, photos or videos, and clears the filters', async () => {
    await show()
    await act(async () => button('Jamie').click())
    await act(async () => button('Videos').click())
    await settle()
    expect(host.searchLibrary).toHaveBeenLastCalledWith(
      expect.objectContaining({ personId: PERSON, type: 'video' }),
    )
    await act(async () => button('[Clear filters]').click())
    await settle()
    expect(host.searchLibrary).toHaveBeenLastCalledWith(
      expect.objectContaining({ personId: null, type: 'all', city: null, month: null }),
    )
  })

  it('offers places and months from the host facets', async () => {
    await show()
    const options = [...element.querySelectorAll('option')].map((option) => option.textContent)
    expect(options).toContain('Banff (3)')
    expect(options).toContain(`${monthLabel('2026-07', 'en')} (5)`)
    expect(monthLabel('2026-07', 'en')).toBe('July 2026')
  })

  it('drags a result as bin media and brings it into the bin', async () => {
    await show()
    const tile = element.querySelector(`[data-library-result="${LAKE.id}"]`)!
    const data = new Map<string, string>()
    const event = new Event('dragstart', { bubbles: true }) as DragEvent
    Object.defineProperty(event, 'dataTransfer', {
      value: { setData: (type: string, value: string) => data.set(type, value), effectAllowed: 'none' },
    })
    await act(async () => {
      tile.dispatchEvent(event)
    })
    expect(JSON.parse(data.get('application/json')!)).toEqual({
      type: 'media-item',
      mediaId: LAKE.id,
      mediaType: 'video',
      fileName: LAKE.name,
      duration: 12.5,
    })
    expect(getMediaDragData()).toMatchObject({ mediaId: LAKE.id })
    expect(host.addLibraryAssets).toHaveBeenCalledWith([LAKE.id])
    expect(host.seed).toHaveBeenCalledWith([LAKE])
    expect(useMediaLibraryStore.getState().mediaById[LAKE.id]).toBeDefined()
  })

  it('shows that the library cannot be searched when the host refuses', async () => {
    host.searchLibrary.mockRejectedValue(new Error('LIBRARY_SEARCH_UNAVAILABLE'))
    await show()
    expect(element.textContent).toContain('can’t be searched right now')
  })
})

describe('FL-636 adopting a library result', () => {
  it('asks the host once per item, seeds it and resolves when the bin holds it', async () => {
    const adopt = createAdopter(host as unknown as LibraryFinderHost)
    const [first, second] = await Promise.all([adopt(BEACH), adopt(BEACH)])
    expect(first).toBe(second)
    expect(first.id).toBe(BEACH.id)
    expect(host.addLibraryAssets).toHaveBeenCalledTimes(1)
  })

  it('fails when the host no longer offers the item, and asks again next time', async () => {
    host.addLibraryAssets.mockResolvedValueOnce([])
    const adopt = createAdopter(host as unknown as LibraryFinderHost)
    await expect(adopt(BEACH)).rejects.toThrow('LIBRARY_ADOPT_REFUSED')
    expect(host.seed).not.toHaveBeenCalled()
    await expect(adopt(BEACH)).resolves.toMatchObject({ id: BEACH.id })
    expect(host.addLibraryAssets).toHaveBeenCalledTimes(2)
  })
})
