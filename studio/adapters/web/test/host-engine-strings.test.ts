import { describe, expect, it } from 'vite-plus/test'
import { changeAppLanguage, i18n } from '@/i18n'
import { applyHostEngineStrings } from '../src/host-engine-strings'

describe('FL-450 host-translated engine messages', () => {
  it("the engine's locked-track refusal has its own English until the host sends a translation", async () => {
    await changeAppLanguage('en')
    expect(i18n.t('timeline.track.lockedTrackRefused')).toBe(
      'This track is locked. Unlock it to place clips here.',
    )
  })

  it("writes the host's translation over the engine key in the current language only", () => {
    const writes: Array<[string, string, string, string]> = []
    const engine = {
      resolvedLanguage: 'de',
      language: 'de-DE',
      addResource: (...args: [string, string, string, string]) => writes.push(args),
    }
    applyHostEngineStrings(engine, { lockedTrackRefused: 'Diese Spur ist gesperrt.', previewTitle: 'Vorschau' })
    expect(writes).toEqual([['de', 'translation', 'timeline.track.lockedTrackRefused', 'Diese Spur ist gesperrt.']])
  })

  it('leaves the engine English when the host sends nothing', () => {
    const writes: unknown[] = []
    const engine = { language: 'en', addResource: (...args: unknown[]) => writes.push(args) }
    applyHostEngineStrings(engine, undefined)
    applyHostEngineStrings(engine, { lockedTrackRefused: '' })
    expect(writes).toEqual([])
  })
})
