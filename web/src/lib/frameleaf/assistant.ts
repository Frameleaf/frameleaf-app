import type { AssistantAskResponseDto, AssistantReasonItemDto } from '@frameleaf/sdk';
import {
  mdiAccountOutline,
  mdiCalendarBlankOutline,
  mdiFormatQuoteOpen,
  mdiMapMarkerOutline,
  mdiMicrophoneOutline,
  mdiPaw,
  mdiTextBoxOutline,
} from '@mdi/js';

/**
 * FL-885/FL-918: the Library Assistant's name in the interface. The product name is still undecided
 * (FL-763), so every screen takes it from here; it is a product name and is not translated.
 */
export const ASSISTANT_NAME = 'Library Assistant';

/** Why the assistant could not answer: it is turned off, or the request failed. */
export type AssistantProblem = 'disabled' | 'failed';

/**
 * The reasons a tile shows, in the approved mock's fixed order (prototype `assistant.mjs` `REASONS`),
 * each with its icon and the i18n key that words it around the stored value. Kinds the server adds later
 * are left out of the tile, but still appear in its full text.
 */
const REASON_ORDER = ['person', 'pet', 'place', 'date', 'text', 'speech', 'description'] as const;
type ShownKind = (typeof REASON_ORDER)[number];
type ReasonKey =
  | 'frameleaf_assistant_reason_value'
  | 'frameleaf_assistant_reason_text'
  | 'frameleaf_assistant_reason_speech'
  | 'frameleaf_assistant_reason_description';
const REASON_SHAPE: Record<ShownKind, { icon: string; key: ReasonKey }> = {
  person: { icon: mdiAccountOutline, key: 'frameleaf_assistant_reason_value' },
  pet: { icon: mdiPaw, key: 'frameleaf_assistant_reason_value' },
  place: { icon: mdiMapMarkerOutline, key: 'frameleaf_assistant_reason_value' },
  date: { icon: mdiCalendarBlankOutline, key: 'frameleaf_assistant_reason_value' },
  text: { icon: mdiFormatQuoteOpen, key: 'frameleaf_assistant_reason_text' },
  speech: { icon: mdiMicrophoneOutline, key: 'frameleaf_assistant_reason_speech' },
  description: { icon: mdiTextBoxOutline, key: 'frameleaf_assistant_reason_description' },
};

/** At most this many reasons under a tile, so the line stays one line; the tooltip has them all. */
export const WHY_LINE_MAX = 3;

export type WhyReason = { kind: ShownKind; icon: string; key: ReasonKey; value: string };

const isShown = (kind: string): kind is ShownKind => (REASON_ORDER as readonly string[]).includes(kind);

/** One tile's why-line: the reasons that carry a value, in the mock's order, at most three. */
export const whyLine = (items: AssistantReasonItemDto[]): WhyReason[] =>
  REASON_ORDER.flatMap((kind) => {
    const item = items.find((reason) => reason.kind === kind && reason.value);
    return item && isShown(item.kind) ? [{ kind, ...REASON_SHAPE[kind], value: item.value! }] : [];
  }).slice(0, WHY_LINE_MAX);

/** Every reason as the server words it, for the tile's tooltip and the info panel. */
export const whyText = (items: AssistantReasonItemDto[]) => items.map(({ text }) => text).join(' · ');

/** The reasons for each result, by asset id. */
export const reasonsByAsset = (response: AssistantAskResponseDto | undefined) =>
  new Map((response?.reasons ?? []).map(({ assetId, items }) => [assetId, items]));

/** The rules answered (no planner, or it could not plan): the mock's "simple search" state, no why-lines. */
export const answeredWithRules = (response: AssistantAskResponseDto | undefined) => response?.answeredBy === 'rules';
