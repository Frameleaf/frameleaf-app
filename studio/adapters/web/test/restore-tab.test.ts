import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { WorkspaceSwitcher } from '@/features/editor/components/workspace-switcher'
import { usePlaybackStore } from '@/shared/state/playback'
import { post } from '../src/host-port'

vi.mock('../src/host-port', () => ({ post: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe("Studio's Restore tab (FL-1822)", () => {
  afterEach(cleanup)

  it('asks the host to open its Restore panel and pauses playback', () => {
    usePlaybackStore.getState().play()
    render(createElement(WorkspaceSwitcher))
    const restore = screen.getByRole('button', { name: 'toolbar.workspaces.restore' })
    // A button beside the workspace tabs, not one of them: it changes no layout.
    expect(screen.getByRole('tablist').contains(restore)).toBe(false)
    fireEvent.click(restore)
    expect(vi.mocked(post)).toHaveBeenCalledWith({ type: 'request-restore' })
    expect(usePlaybackStore.getState().isPlaying).toBe(false)
  })
})
