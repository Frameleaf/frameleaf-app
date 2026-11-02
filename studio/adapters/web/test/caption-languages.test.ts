import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { SubtitleSegmentItem, TextItem, TimelineItem, TimelineTrack, VideoItem } from '@/types/timeline'
import {
  buildTranslatedCaptionTrack,
  burnInChanges,
  burnedInLanguage,
  captionVoiceFor,
  collectOriginalCaptionLines,
  originalCaptionStyle,
  originalLineFor,
  placeVoiceLines,
  translatedCaptionItems,
  translatedLines,
} from '@/features/editor/utils/caption-languages'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { useTimelineCommandStore } from '@/features/timeline/stores/timeline-command-store'
import {
  addCaptionVoiceOver,
  addTranslatedCaptions,
  removeCaptionLanguage,
  setCaptionLanguageInPicture,
  updateCaptionTranslation,
  updateTranslatedCue,
} from '@/features/editor/utils/caption-language-actions'
import { encodeWav, mixVoiceLines } from '@/features/editor/services/caption-voice-over'
import { changeAppLanguage, i18n } from '@/i18n'
import { CAPTION_LANGUAGE_ENGINE_STRINGS } from '@frameleaf/host/caption-language-strings'
import { applyHostEngineStrings } from '../src/host-engine-strings'
import {
  CAPTION_TRANSLATION_BATCH,
  setCaptionTranslator,
  translateCaptionLines,
} from '@/features/editor/services/caption-translation-host'

const fps = 30
const track = (id: string, order: number, visible = true): TimelineTrack => ({
  id,
  name: id,
  kind: 'video',
  height: 48,
  locked: false,
  visible,
  muted: false,
  solo: false,
  order,
  items: [],
})

const clip: VideoItem = {
  id: 'clip',
  type: 'video',
  trackId: 'v1',
  from: 60,
  durationInFrames: 300,
  label: 'Lake',
  src: 'blob:lake',
  sourceStart: 90,
  sourceFps: 30,
  transcriptCaptions: {
    type: 'transcript',
    mediaId: 'm1',
    enabled: true,
    updatedAt: 1,
    cues: [
      { id: 'a', startSeconds: 2, endSeconds: 3.5, text: 'Before the trim' },
      { id: 'b', startSeconds: 4, endSeconds: 6, text: 'Look at the lake' },
      { id: 'c', startSeconds: 7, endSeconds: 9, text: '  ' },
      { id: 'd', startSeconds: 10, endSeconds: 12, text: 'Time to swim' },
    ],
  },
}

const segment: SubtitleSegmentItem = {
  id: 'seg',
  type: 'subtitle',
  trackId: 'captions',
  from: 600,
  durationInFrames: 90,
  label: 'Imported',
  source: { type: 'subtitle-import', fileName: 'talk.srt', format: 'srt', importedAt: 1 },
  cues: [{ id: '1', startSeconds: 0.5, endSeconds: 2, text: 'Thank you' }],
  color: '#ffee00',
  fontSize: 50,
}

const caption: TextItem = {
  id: 'cap',
  type: 'text',
  trackId: 'captions',
  from: 750,
  durationInFrames: 30,
  label: 'Caption',
  text: 'Bye',
  textRole: 'caption',
  color: '#ffffff',
}

describe('FL-641 original caption lines', () => {
  it('reads transcript captions, subtitle segments and caption text on the sequence clock', () => {
    const lines = collectOriginalCaptionLines([caption, segment, clip], fps)
    expect(lines).toEqual([
      // The clip starts at 2 s and plays its source from 3 s: cue b (4-6 s) sits at 3-5 s on the sequence.
      { id: 'clip:a', startSeconds: 2, endSeconds: 2.5, text: 'Before the trim' },
      { id: 'clip:b', startSeconds: 3, endSeconds: 5, text: 'Look at the lake' },
      { id: 'clip:d', startSeconds: 9, endSeconds: 11, text: 'Time to swim' },
      { id: 'seg:1', startSeconds: 20.5, endSeconds: 22, text: 'Thank you' },
      { id: 'cap', startSeconds: 25, endSeconds: 26, text: 'Bye' },
    ])
  })

  it('follows speed and leaves out what a trim hides', () => {
    const fast = { ...clip, speed: 2, durationInFrames: 60 }
    // Twice as fast and two seconds long: the last line falls after the trimmed end.
    expect(collectOriginalCaptionLines([fast], fps).map((line) => [line.startSeconds, line.endSeconds])).toEqual([
      [2, 2.25],
      [2.5, 3.5],
    ])
  })
})

describe('FL-641 translated tracks', () => {
  const lines = collectOriginalCaptionLines([clip, segment], fps)
  const build = (language: 'fr' | 'de', now = 10) =>
    buildTranslatedCaptionTrack({
      tracks: [track('v1', 1), track('captions', 0)],
      lines,
      translations: lines.map((line) => `${language}:${line.text}`),
      language,
      from: 'en',
      fps,
      canvasWidth: 1920,
      canvasHeight: 1080,
      name: `${language} captions`,
      style: originalCaptionStyle([segment]),
      now,
    })!

  it('keeps every line on its original timing, on a new hidden track above the others', () => {
    const { track: made, item } = build('fr')
    expect(made.visible).toBe(false)
    expect(made.order).toBe(-1)
    expect(item.trackId).toBe(made.id)
    expect(item.from).toBe(60)
    expect(translatedLines(item, fps)).toEqual(
      lines.map((line, index) => ({
        id: `fr-${index + 1}`,
        startSeconds: line.startSeconds,
        endSeconds: line.endSeconds,
        text: `fr:${line.text}`,
      })),
    )
    expect(item.source).toMatchObject({
      type: 'subtitle-import',
      translation: { language: 'fr', from: 'en', subtitle: true, translatedAt: 10 },
    })
    // The original's look carries over.
    expect(item.color).toBe('#ffee00')
    expect(item.fontSize).toBe(50)
  })

  it('skips lines the translation left empty and refuses a mismatched answer', () => {
    const empty = buildTranslatedCaptionTrack({
      tracks: [],
      lines,
      translations: lines.map(() => ' '),
      language: 'fr',
      from: 'en',
      fps,
      canvasWidth: 1,
      canvasHeight: 1,
      name: 'x',
    })
    expect(empty).toBeNull()
    expect(() =>
      buildTranslatedCaptionTrack({
        tracks: [],
        lines,
        translations: ['one'],
        language: 'fr',
        from: 'en',
        fps,
        canvasWidth: 1,
        canvasHeight: 1,
        name: 'x',
      }),
    ).toThrow()
  })

  it('lists translations in the order they were added and matches each line to its original', () => {
    const fr = build('fr', 20).item
    const de = build('de', 10).item
    const items: TimelineItem[] = [clip, segment, fr, de]
    expect(translatedCaptionItems(items).map((item) => item.source.translation.language)).toEqual(['de', 'fr'])
    const first = translatedLines(fr, fps)[1]!
    expect(originalLineFor(lines, first)?.text).toBe('Look at the lake')
    // A translated track is never read as an original line.
    expect(collectOriginalCaptionLines(items, fps)).toHaveLength(lines.length)
  })
})

describe('FL-641 the language in the picture', () => {
  const lines = collectOriginalCaptionLines([clip, segment], fps)
  const fr = buildTranslatedCaptionTrack({
    tracks: [],
    lines,
    translations: lines.map((line) => line.text),
    language: 'fr',
    from: 'en',
    fps,
    canvasWidth: 1,
    canvasHeight: 1,
    name: 'French',
    now: 1,
  })!
  const tracks = [track('v1', 1), track('captions', 0), { ...fr.track }]
  const items: TimelineItem[] = [clip, segment, caption, fr.item]

  it('starts with the original in the picture', () => {
    expect(burnedInLanguage(tracks, items)).toBe('original')
  })

  it('shows one language and hides the others, keeping the clip itself visible', () => {
    const changes = burnInChanges(tracks, items, 'fr')
    expect(changes.tracks).toEqual(
      expect.arrayContaining([
        { id: fr.track.id, visible: true },
        { id: 'captions', visible: false },
      ]),
    )
    // The video track is never hidden; its transcript captions are switched off instead.
    expect(changes.tracks.some((change) => change.id === 'v1')).toBe(false)
    expect(changes.items).toEqual([{ id: 'clip', enabled: false }])
    const after = tracks.map((candidate) => {
      const change = changes.tracks.find((item) => item.id === candidate.id)
      return change ? { ...candidate, visible: change.visible } : candidate
    })
    expect(burnedInLanguage(after, items)).toBe('fr')
  })

  it('puts the original back', () => {
    const hidden = tracks.map((candidate) =>
      candidate.id === 'captions' ? { ...candidate, visible: false } : candidate.id === fr.track.id ? { ...candidate, visible: true } : candidate,
    )
    const switched = items.map((item) =>
      item.id === 'clip' ? { ...clip, transcriptCaptions: { ...clip.transcriptCaptions!, enabled: false } } : item,
    )
    const changes = burnInChanges(hidden, switched, 'original')
    expect(changes.tracks).toEqual(
      expect.arrayContaining([
        { id: fr.track.id, visible: false },
        { id: 'captions', visible: true },
      ]),
    )
    expect(changes.items).toEqual([{ id: 'clip', enabled: true }])
  })

  it('leaves a shared track alone when it holds more than captions', () => {
    const mixed = [...items, { ...clip, id: 'b-roll', trackId: 'captions', transcriptCaptions: undefined } as VideoItem]
    expect(burnInChanges(tracks, mixed, 'fr').tracks.some((change) => change.id === 'captions')).toBe(false)
  })
})

describe('FL-641 voice-over', () => {
  it('offers the voices Studio has: Kokoro in English, Supertonic for the rest it speaks', () => {
    expect(captionVoiceFor('en')).toBe('kokoro')
    for (const language of ['fr', 'es', 'de', 'it', 'pt', 'nl', 'pl', 'sv', 'da'] as const) {
      expect(captionVoiceFor(language)).toBe('supertonic')
    }
    expect(captionVoiceFor('nb')).toBeNull()
  })

  it('speaks each line at its caption, and never over the line before', () => {
    const lines = [
      { id: '1', startSeconds: 10, endSeconds: 12, text: 'a' },
      { id: '2', startSeconds: 12.5, endSeconds: 14, text: 'b' },
      { id: '3', startSeconds: 20, endSeconds: 21, text: 'c' },
    ]
    const placed = placeVoiceLines(lines, [3, 1, 1])
    expect(placed.startSeconds).toBe(10)
    // Line 2 waits for line 1 (3 s long) to finish, plus a short pause.
    expect(placed.offsets).toEqual([0, 3.05, 10])
    expect(placed.lengthSeconds).toBe(11)
  })
})

describe('FL-641 translation through the host', () => {
  afterEach(() => setCaptionTranslator(null))

  it('needs the host', async () => {
    await expect(translateCaptionLines({ source: 'en', target: 'fr', lines: ['Hi'] })).rejects.toThrow()
  })

  it('sends long projects in parts and keeps the order', async () => {
    const translate = vi.fn(async ({ lines }: { lines: string[] }) => ({ lines: lines.map((line) => `fr:${line}`) }))
    setCaptionTranslator(translate)
    const lines = Array.from({ length: CAPTION_TRANSLATION_BATCH + 3 }, (_, index) => `line ${index}`)
    const progress: number[] = []
    const out = await translateCaptionLines({ source: 'en', target: 'fr', lines }, (done) => progress.push(done))
    expect(translate).toHaveBeenCalledTimes(2)
    expect(out.at(-1)).toBe(`fr:line ${CAPTION_TRANSLATION_BATCH + 2}`)
    expect(out).toHaveLength(lines.length)
    expect(progress).toEqual([CAPTION_TRANSLATION_BATCH, CAPTION_TRANSLATION_BATCH + 3])
  })

  it('refuses an answer that leaves lines out', async () => {
    setCaptionTranslator(async () => ({ lines: [] }))
    await expect(translateCaptionLines({ source: 'en', target: 'fr', lines: ['Hi'] })).rejects.toThrow()
  })
})

describe('FL-641 timeline edits, one undo step each', () => {
  const lines = collectOriginalCaptionLines([clip], fps)
  const made = () =>
    buildTranslatedCaptionTrack({
      tracks: useItemsStore.getState().tracks,
      lines,
      translations: lines.map((line) => `fr:${line.text}`),
      language: 'fr',
      from: 'en',
      fps,
      canvasWidth: 1920,
      canvasHeight: 1080,
      name: 'French captions',
    })!

  const reset = () => {
    useItemsStore.getState().setTracks([track('v1', 0)])
    useItemsStore.getState().setItems([clip])
  }

  it('adds a language, puts it in the picture, corrects a line and removes it again', () => {
    reset()
    const { track: french, item } = made()
    addTranslatedCaptions(french, item)
    let state = useItemsStore.getState()
    expect(translatedCaptionItems(state.items)).toHaveLength(1)
    expect(burnedInLanguage(state.tracks, state.items)).toBe('original')

    setCaptionLanguageInPicture('fr')
    state = useItemsStore.getState()
    expect(burnedInLanguage(state.tracks, state.items)).toBe('fr')
    const video = state.items.find((candidate) => candidate.id === 'clip') as VideoItem
    expect(video.transcriptCaptions?.enabled).toBe(false)
    // The clip's own track stays visible.
    expect(state.tracks.find((candidate) => candidate.id === 'v1')?.visible).toBe(true)

    updateTranslatedCue(item.id, item.cues[0]!.id, 'Regarde le lac')
    updateCaptionTranslation(item.id, { subtitle: false })
    const updated = translatedCaptionItems(useItemsStore.getState().items)[0]!
    expect(updated.cues[0]!.text).toBe('Regarde le lac')
    expect(updated.source.translation.subtitle).toBe(false)

    useTimelineCommandStore.getState().undo()
    expect(translatedCaptionItems(useItemsStore.getState().items)[0]!.source.translation.subtitle).toBe(true)

    removeCaptionLanguage(item.id)
    state = useItemsStore.getState()
    expect(translatedCaptionItems(state.items)).toHaveLength(0)
    expect(state.tracks.some((candidate) => candidate.id === french.id)).toBe(false)
    // Removing the language in the picture puts the original back.
    expect((state.items.find((candidate) => candidate.id === 'clip') as VideoItem).transcriptCaptions?.enabled).toBe(
      true,
    )
  })

  it('translating again replaces the language in place and keeps its settings', () => {
    reset()
    const first = made()
    addTranslatedCaptions(first.track, first.item)
    setCaptionLanguageInPicture('fr')
    updateCaptionTranslation(first.item.id, { subtitle: false })
    const again = buildTranslatedCaptionTrack({
      tracks: useItemsStore.getState().tracks,
      lines,
      translations: lines.map((line) => `FR:${line.text}`),
      language: 'fr',
      from: 'en',
      fps,
      canvasWidth: 1920,
      canvasHeight: 1080,
      name: 'French captions',
      previous: translatedCaptionItems(useItemsStore.getState().items)[0]!.source.translation,
    })!
    addTranslatedCaptions(again.track, again.item)
    const state = useItemsStore.getState()
    const items = translatedCaptionItems(state.items)
    expect(items).toHaveLength(1)
    expect(items[0]!.trackId).toBe(first.track.id)
    expect(items[0]!.cues[0]!.text.startsWith('FR:')).toBe(true)
    expect(items[0]!.source.translation.subtitle).toBe(false)
    expect(burnedInLanguage(state.tracks, state.items)).toBe('fr')
    expect(state.tracks.filter((candidate) => candidate.id === first.track.id)).toHaveLength(1)
  })

  it('places a voice-over on its own track, ducking the rest, and records it on the language', () => {
    reset()
    const { track: french, item } = made()
    addTranslatedCaptions(french, item)
    const voiceTrack = { ...track('voice-fr', 5), kind: 'audio' as const }
    const audio = {
      id: 'voice',
      type: 'audio' as const,
      trackId: 'voice-fr',
      from: 60,
      durationInFrames: 90,
      label: 'French voice-over',
      src: 'blob:voice',
      audioDucking: { duckOthersDb: -12 },
    }
    addCaptionVoiceOver(item.id, voiceTrack, audio)
    const state = useItemsStore.getState()
    expect(translatedCaptionItems(state.items)[0]!.source.translation.voiceTrackId).toBe('voice-fr')
    expect(state.items.find((candidate) => candidate.id === 'voice')).toMatchObject({
      audioDucking: { duckOthersDb: -12 },
    })
    removeCaptionLanguage(item.id)
    expect(useItemsStore.getState().items.some((candidate) => candidate.id === 'voice')).toBe(false)
  })
})

describe('FL-641 Languages card strings', () => {
  it('every card string has engine English with the same run-time values', async () => {
    await changeAppLanguage('en')
    for (const entry of Object.values(CAPTION_LANGUAGE_ENGINE_STRINGS)) {
      expect(i18n.t(entry.engine), entry.engine).not.toBe(entry.engine)
      const markers = [...(i18n.getResource('en', 'translation', entry.engine) as string).matchAll(/\{\{(\w+)\}\}/g)]
        .map((match) => match[1])
        .toSorted()
      expect(markers, entry.engine).toEqual([...('values' in entry ? entry.values : [])].toSorted())
    }
  })

  it("the host's translation replaces the engine English", async () => {
    await changeAppLanguage('en')
    applyHostEngineStrings(i18n, { captionLanguagesInPicture: "Dans l'image" })
    expect(i18n.t('captionLanguages.inPicture')).toBe("Dans l'image")
    i18n.addResource('en', 'translation', 'captionLanguages.inPicture', 'In the picture')
  })
})

describe('FL-641 voice-over sound', () => {
  it('writes 16-bit mono WAV and mixes lines at their offsets', async () => {
    const mixed = mixVoiceLines([new Float32Array([0.5, 0.5]), new Float32Array([-1])], [0, 1], 1.5)
    expect(mixed.length).toBe(36_000)
    expect(mixed[0]).toBe(0.5)
    expect(mixed[24_000]).toBe(-1)
    const wav = encodeWav(new Float32Array([0, 1, -1]))
    const bytes = new DataView(await wav.arrayBuffer())
    expect(bytes.byteLength).toBe(44 + 6)
    expect(bytes.getUint16(22, true)).toBe(1)
    expect(bytes.getUint32(24, true)).toBe(24_000)
    expect(bytes.getInt16(46, true)).toBe(32767)
    expect(bytes.getInt16(48, true)).toBe(-32767)
  })
})
