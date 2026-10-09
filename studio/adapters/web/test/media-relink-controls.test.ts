import { mediaLibraryService } from '@/features/media-library/services/media-library-service'
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { VirtualWorkspace } from '../src/virtual-workspace'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GridMediaGrid } from '@/features/media-library/components/media-grid'
import { MissingMediaDialog } from '@/features/media-library/components/missing-media-dialog'
import { useMediaLibraryStore } from '@/features/media-library/stores/media-library-store'
import { registerMediaFileRelink } from '@/features/media-library/stores/media-relinking-actions'
import { projectImportRecord } from '../src/library-media'
import { hideFileSystemPickers } from '../src/browser-shims'
import { selectRelinkFile } from '../src/media-file-relink'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let workspace: VirtualWorkspace | undefined
let root: Root | undefined
let host: HTMLElement | undefined
let unregister: (() => void) | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  workspace?.dispose()
  setWorkspaceRoot(null)
  unregister?.()
  vi.restoreAllMocks()
})
const mount = async (element: ReturnType<typeof createElement>) => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(element))
}
const button = (text: string) =>
  Array.from(document.querySelectorAll('button,[role="menuitem"]')).find(
    (node) => node.textContent?.trim() === text,
  ) as HTMLElement
const setup = () => {
  workspace = new VirtualWorkspace()
  setWorkspaceRoot(workspace.handle())
  vi.spyOn(mediaLibraryService, 'getThumbnailBlobUrl').mockResolvedValue(null)
  hideFileSystemPickers()
  const selected = new File(['BBBB'], 'replacement.wav', { type: 'audio/wav' })
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
    Object.defineProperty(this, 'files', { value: [selected] })
    this.dispatchEvent(new Event('change'))
  })
  const selectedFile = vi.fn(async () => {
    expect(await selectRelinkFile(new AbortController().signal)).toBe(selected)
    return true
  })
  unregister = registerMediaFileRelink(selectedFile)
  const media = projectImportRecord(
    { id: 'A', name: 'missing.wav', kind: 'audio', mimeType: 'audio/wav', sizeBytes: 4, url: '/A' },
    0,
  )
  useMediaLibraryStore.setState({
    mediaItems: [media],
    mediaById: { A: media },
    brokenMediaIds: ['A'],
    brokenMediaInfo: new Map([
      ['A', { mediaId: 'A', fileName: media.fileName, errorType: 'file_missing' }],
    ]),
    showMissingMediaDialog: true,
    isLoading: false,
  })
  return { media, selectedFile }
}
describe('production relink controls with filesystem APIs hidden', () => {
  it('routes the missing-media Restore button to selectedFile', async () => {
    const f = setup()
    await mount(createElement(MissingMediaDialog))
    const restore = button('Locate') ?? button('media.missingMedia.locate')
    expect(restore).toBeDefined()
    await act(async () => restore.click())
    expect(f.selectedFile).toHaveBeenCalledWith('A')
    expect(window.showOpenFilePicker).toBeUndefined()
  })
  it('routes the media-card Relink File action to selectedFile', async () => {
    const f = setup()
    await mount(createElement(GridMediaGrid, { items: [f.media] }))
    const card =
      document.querySelector('[data-media-id="A"] [data-slot="context-menu-trigger"]') ??
      document.querySelector('[data-media-id="A"] > *')!
    await act(async () =>
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 })),
    )
    const relink = Array.from(document.querySelectorAll('[role="menuitem"]')).find((node) =>
      /relink/i.test(node.textContent ?? ''),
    ) as HTMLElement
    expect(relink).toBeDefined()
    await act(async () => relink.click())
    expect(f.selectedFile).toHaveBeenCalledWith('A')
    expect(window.showOpenFilePicker).toBeUndefined()
  })
})
