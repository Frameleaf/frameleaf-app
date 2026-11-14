/**
 * FL-1429: captions on Frameleaf Cloud for several selected clips (prototype
 * notes/cloud-caption-batches). The list says which clips can go and why the others can't; Review
 * prices hands them to the host one at a time, where each has its own price and its own confirmation.
 */
import { useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { useSettingsStore } from '@/features/media-library/deps/settings-contract'
import {
  getWhisperLanguageSelectValue,
  getWhisperLanguageSettingValue,
  WHISPER_LANGUAGE_OPTIONS,
} from '@/shared/utils/whisper-settings'
import type { CloudCaptionBatchRow } from './cloud-captions'

interface BatchRequest {
  clipIds: string[]
  rows: (clipIds: readonly string[]) => CloudCaptionBatchRow[]
  start: (clipIds: readonly string[], language: string) => void
}

let open: BatchRequest | null = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Open the list for these clips (the clip menu with several clips selected). */
export function openCloudCaptionBatch(request: BatchRequest | null) {
  open = request
  for (const listener of listeners) listener()
}

const length = (seconds: number) => {
  const whole = Math.max(0, Math.round(seconds))
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
}

export function CloudCaptionBatchDialog() {
  const { t } = useTranslation()
  const request = useSyncExternalStore(subscribe, () => open, () => open)
  const defaultLanguage = useSettingsStore((s) => s.defaultWhisperLanguage)
  const [language, setLanguage] = useState<string | null>(null)
  const listed = request ? request.rows(request.clipIds) : []
  const ready = listed.filter((row) => !row.reason)
  const close = () => {
    openCloudCaptionBatch(null)
    setLanguage(null)
  }
  const languageValue = language ?? getWhisperLanguageSelectValue(defaultLanguage)

  return (
    <Dialog open={!!request} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('transcript.cloud.batchTitle', { count: listed.length })}</DialogTitle>
          <DialogDescription>{t('transcript.cloud.batchNote')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cloud-caption-batch-language" className="text-sm">
              {t('media.transcribe.language')}
            </Label>
            <Combobox
              id="cloud-caption-batch-language"
              value={languageValue}
              onValueChange={setLanguage}
              options={WHISPER_LANGUAGE_OPTIONS}
              placeholder={t('media.transcribe.autoDetect')}
              searchPlaceholder={t('media.transcribe.searchLanguages')}
              emptyMessage={t('media.transcribe.noLanguages')}
            />
          </div>
          <ul
            className="max-h-[40vh] divide-y divide-border overflow-y-auto rounded-md border border-border text-sm"
            aria-label={t('transcript.cloud.batchTitle', { count: listed.length })}
          >
            {listed.map((row) => (
              <li
                key={row.clipId}
                className={`flex items-center justify-between gap-3 px-3 py-2${row.reason ? ' text-muted-foreground' : ''}`}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{row.name}</span>
                  <span className="text-xs text-muted-foreground">{length(row.seconds)}</span>
                </span>
                {row.reason && (
                  <span className="text-right text-xs">
                    {row.reason === 'running' ? t('transcript.cloud.batchRunning') : t('transcript.cloud.batchNoSound')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={ready.length === 0}
            onClick={() => {
              request?.start(
                ready.map((row) => row.clipId),
                getWhisperLanguageSettingValue(languageValue),
              )
              close()
            }}
          >
            {t('transcript.cloud.batchReview')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
