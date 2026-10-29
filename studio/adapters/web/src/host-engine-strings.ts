/**
 * Engine messages the host translates (FL-450).
 *
 * The engine's own locale files carry only its English for strings Frameleaf adds by patch, and
 * the engine speaks fewer languages than the host. For the few such messages a person must
 * understand, the host sends its translation in `context.strings`, and this writes it over the
 * engine's key in the engine's current language, after each language change.
 */
import type { StudioHostContext } from '@frameleaf/host/host-contract'
import {
  TRANSCRIPT_ENGINE_STRINGS,
  type TranscriptEngineString,
} from '@frameleaf/host/transcript-strings'
import {
  CAPTION_STYLE_ENGINE_STRINGS,
  type CaptionStyleEngineString,
} from '@frameleaf/host/caption-style-strings'
import {
  CAPTION_LANGUAGE_ENGINE_STRINGS,
  type CaptionLanguageEngineString,
} from '@frameleaf/host/caption-language-strings'

type EngineI18n = {
  readonly language?: string
  readonly resolvedLanguage?: string
  addResource: (language: string, namespace: string, key: string, value: string) => unknown
}

/** Host string → engine translation key. */
export const HOST_ENGINE_STRINGS = {
  lockedTrackRefused: 'timeline.track.lockedTrackRefused',
  // The transcript panel (FL-562).
  ...(Object.fromEntries(
    Object.entries(TRANSCRIPT_ENGINE_STRINGS).map(([name, entry]) => [name, entry.engine]),
  ) as Record<TranscriptEngineString, string>),
  // The Caption style card (FL-640).
  ...(Object.fromEntries(
    Object.entries(CAPTION_STYLE_ENGINE_STRINGS).map(([name, entry]) => [name, entry.engine]),
  ) as Record<CaptionStyleEngineString, string>),
  // The captions Languages card (FL-641).
  ...(Object.fromEntries(
    Object.entries(CAPTION_LANGUAGE_ENGINE_STRINGS).map(([name, entry]) => [name, entry.engine]),
  ) as Record<CaptionLanguageEngineString, string>),
} as const

export function applyHostEngineStrings(i18n: EngineI18n, strings: StudioHostContext['strings']): void {
  const language = i18n.resolvedLanguage ?? i18n.language
  if (!language || !strings) return
  for (const [name, key] of Object.entries(HOST_ENGINE_STRINGS) as Array<
    [keyof typeof HOST_ENGINE_STRINGS, string]
  >) {
    const value = strings[name]
    if (value) i18n.addResource(language, 'translation', key, value)
  }
}
