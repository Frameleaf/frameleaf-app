import { describe, expect, it } from 'vite-plus/test'
import { changeAppLanguage, i18n } from '@/i18n'
import { TRANSCRIPT_ENGINE_STRINGS, transcriptEngineStrings } from '@frameleaf/host/transcript-strings'
import { STABILISE_ENGINE_STRINGS } from '@frameleaf/host/stabilise-strings'
import { CAPTION_STYLE_ENGINE_STRINGS } from '@frameleaf/host/caption-style-strings'
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

  it('FL-562: every transcript panel string has engine English with the same run-time values', async () => {
    await changeAppLanguage('en')
    for (const entry of Object.values(TRANSCRIPT_ENGINE_STRINGS)) {
      const english = i18n.t(entry.engine)
      expect(english, entry.engine).not.toBe(entry.engine)
      const markers = [...(i18n.getResource('en', 'translation', entry.engine) as string).matchAll(/\{\{(\w+)\}\}/g)]
        .map((match) => match[1])
        .toSorted()
      expect(markers, entry.engine).toEqual([...('values' in entry ? entry.values : [])].toSorted())
    }
  })

  it('FL-562: a host translation of a transcript string keeps working with run-time values', async () => {
    await changeAppLanguage('en')
    const strings = transcriptEngineStrings((key, options) =>
      key === 'frameleaf_studio_transcript_selected'
        ? `Gewählt: ${options?.values?.count} · ${options?.values?.seconds} s`
        : key,
    )
    expect(strings.transcriptSelected).toBe('Gewählt: {{count}} · {{seconds}} s')
    applyHostEngineStrings(i18n, { transcriptSelected: strings.transcriptSelected })
    expect(i18n.t('transcript.edit.selected', { count: 3, seconds: '0.8' })).toBe('Gewählt: 3 · 0.8 s')
    i18n.addResource('en', 'translation', 'transcript.edit.selected', 'Selected: {{count}} · {{seconds}} s')
  })

  it('FL-638: every Stabilise card string has engine English with the same run-time values', async () => {
    await changeAppLanguage('en')
    for (const entry of Object.values(STABILISE_ENGINE_STRINGS)) {
      expect(i18n.t(entry.engine), entry.engine).not.toBe(entry.engine)
      const markers = [...(i18n.getResource('en', 'translation', entry.engine) as string).matchAll(/\{\{(\w+)\}\}/g)]
        .map((match) => match[1])
        .toSorted()
      expect(markers, entry.engine).toEqual([...('values' in entry ? entry.values : [])].toSorted())
    }
  })

  it('FL-640: every Caption style card string has engine English, and the host translation wins', async () => {
    await changeAppLanguage('en')
    for (const entry of Object.values(CAPTION_STYLE_ENGINE_STRINGS)) {
      expect(i18n.t(entry.engine), entry.engine).not.toBe(entry.engine)
    }
    const english = i18n.t('wordCaptions.title')
    applyHostEngineStrings(i18n, { captionTitle: 'Untertitelstil' })
    expect(i18n.t('wordCaptions.title')).toBe('Untertitelstil')
    i18n.addResource('en', 'translation', 'wordCaptions.title', english)
  })

  it('leaves the engine English when the host sends nothing', () => {
    const writes: unknown[] = []
    const engine = { language: 'en', addResource: (...args: unknown[]) => writes.push(args) }
    applyHostEngineStrings(engine, undefined)
    applyHostEngineStrings(engine, { lockedTrackRefused: '' })
    expect(writes).toEqual([])
  })
})
