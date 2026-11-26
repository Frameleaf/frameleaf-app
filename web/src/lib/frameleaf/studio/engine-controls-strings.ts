/**
 * The words of the editor controls added in one engine pass (FL-1562 "Your fonts", FL-1555 the
 * transition's sound and alignment, FL-1561 a sound clip's channels, FL-1563 marker ranges, notes and
 * clip markers, FL-1559 the grade panels), translated by the host.
 *
 * The controls live in the engine, whose locale files carry only its English for strings Frameleaf
 * adds. The host sends its own translation of each in `context.strings`, and the adapter writes it
 * over the engine key (`host-engine-strings.ts`), as for the transcript panel (FL-562). A value the
 * engine fills in at run time travels as an i18next `{{name}}` marker.
 */
export const ENGINE_CONTROLS_STRINGS = {
  controlsFontsYours: { host: 'frameleaf_studio_controls_fonts_yours', engine: 'engineControls.fonts.yourFonts' },
  controlsFontsAdd: { host: 'frameleaf_studio_controls_fonts_add', engine: 'engineControls.fonts.addFont' },
  controlsFontsFrameleaf: { host: 'frameleaf_studio_controls_fonts_frameleaf', engine: 'engineControls.fonts.frameleafFonts' },
  controlsFontsWeightCount: { host: 'frameleaf_studio_controls_fonts_weight_count', engine: 'engineControls.fonts.weightCount', values: ['number'] },
  controlsFontsKeptNote: { host: 'frameleaf_studio_controls_fonts_kept_note', engine: 'engineControls.fonts.keptNote' },
  controlsFontsAddFailed: { host: 'frameleaf_studio_controls_fonts_add_failed', engine: 'engineControls.fonts.addFailed' },
  controlsFontsFull: { host: 'frameleaf_studio_controls_fonts_full', engine: 'engineControls.fonts.full' },
  controlsTransitionAlignment: { host: 'frameleaf_studio_controls_transition_alignment', engine: 'engineControls.transition.alignment' },
  controlsTransitionAlignStart: { host: 'frameleaf_studio_controls_transition_align_start', engine: 'engineControls.transition.align.start' },
  controlsTransitionAlignCentre: { host: 'frameleaf_studio_controls_transition_align_centre', engine: 'engineControls.transition.align.centre' },
  controlsTransitionAlignEnd: { host: 'frameleaf_studio_controls_transition_align_end', engine: 'engineControls.transition.align.end' },
  controlsTransitionAlignNoteStart: { host: 'frameleaf_studio_controls_transition_align_note_start', engine: 'engineControls.transition.alignNote.start' },
  controlsTransitionAlignNoteCentre: { host: 'frameleaf_studio_controls_transition_align_note_centre', engine: 'engineControls.transition.alignNote.centre' },
  controlsTransitionAlignNoteEnd: { host: 'frameleaf_studio_controls_transition_align_note_end', engine: 'engineControls.transition.alignNote.end' },
  controlsTransitionSound: { host: 'frameleaf_studio_controls_transition_sound', engine: 'engineControls.transition.sound' },
  controlsTransitionCurvePower: { host: 'frameleaf_studio_controls_transition_curve_power', engine: 'engineControls.transition.curve.power' },
  controlsTransitionCurveGain: { host: 'frameleaf_studio_controls_transition_curve_gain', engine: 'engineControls.transition.curve.gain' },
  controlsTransitionCurveExponential: { host: 'frameleaf_studio_controls_transition_curve_exponential', engine: 'engineControls.transition.curve.exponential' },
  controlsTransitionCurveNotePower: { host: 'frameleaf_studio_controls_transition_curve_note_power', engine: 'engineControls.transition.curveNote.power' },
  controlsTransitionCurveNoteGain: { host: 'frameleaf_studio_controls_transition_curve_note_gain', engine: 'engineControls.transition.curveNote.gain' },
  controlsTransitionCurveNoteExponential: { host: 'frameleaf_studio_controls_transition_curve_note_exponential', engine: 'engineControls.transition.curveNote.exponential' },
  controlsTransitionCurveGraph: { host: 'frameleaf_studio_controls_transition_curve_graph', engine: 'engineControls.transition.curveGraph' },
  controlsTransitionSoundApplies: { host: 'frameleaf_studio_controls_transition_sound_applies', engine: 'engineControls.transition.soundApplies' },
  controlsTransitionSoundPair: { host: 'frameleaf_studio_controls_transition_sound_pair', engine: 'engineControls.transition.soundPair', values: ['before', 'after'] },
  controlsChannelsLabel: { host: 'frameleaf_studio_controls_channels_label', engine: 'engineControls.channels.label' },
  controlsChannelsStereo: { host: 'frameleaf_studio_controls_channels_stereo', engine: 'engineControls.channels.choice.stereo' },
  controlsChannelsMonoLeft: { host: 'frameleaf_studio_controls_channels_mono_left', engine: 'engineControls.channels.choice.monoLeft' },
  controlsChannelsMonoRight: { host: 'frameleaf_studio_controls_channels_mono_right', engine: 'engineControls.channels.choice.monoRight' },
  controlsChannelsDualMono: { host: 'frameleaf_studio_controls_channels_dual_mono', engine: 'engineControls.channels.choice.dualMono' },
  controlsChannelsFront: { host: 'frameleaf_studio_controls_channels_front', engine: 'engineControls.channels.choice.front' },
  controlsChannelsCentre: { host: 'frameleaf_studio_controls_channels_centre', engine: 'engineControls.channels.choice.centre' },
  controlsChannelsLfe: { host: 'frameleaf_studio_controls_channels_lfe', engine: 'engineControls.channels.choice.lfe' },
  controlsChannelsSurround: { host: 'frameleaf_studio_controls_channels_surround', engine: 'engineControls.channels.choice.surround' },
  controlsChannelsSurroundGroup: { host: 'frameleaf_studio_controls_channels_surround_group', engine: 'engineControls.channels.surroundGroup' },
  controlsChannelsMixed: { host: 'frameleaf_studio_controls_channels_mixed', engine: 'engineControls.channels.mixed' },
  controlsChannelsCustom: { host: 'frameleaf_studio_controls_channels_custom', engine: 'engineControls.channels.custom' },
  controlsChannelsNote: { host: 'frameleaf_studio_controls_channels_note', engine: 'engineControls.channels.note' },
  controlsMarkersLength: { host: 'frameleaf_studio_controls_markers_length', engine: 'engineControls.markers.length' },
  controlsMarkersNote: { host: 'frameleaf_studio_controls_markers_note', engine: 'engineControls.markers.note' },
  controlsMarkersAddNote: { host: 'frameleaf_studio_controls_markers_add_note', engine: 'engineControls.markers.addNote' },
  controlsMarkersClipMarkers: { host: 'frameleaf_studio_controls_markers_clip_markers', engine: 'engineControls.markers.clipMarkers' },
  controlsMarkersName: { host: 'frameleaf_studio_controls_markers_name', engine: 'engineControls.markers.name' },
  controlsMarkersTimeIn: { host: 'frameleaf_studio_controls_markers_time_in', engine: 'engineControls.markers.timeIn', values: ['time'] },
  controlsMarkersTrimmedOut: { host: 'frameleaf_studio_controls_markers_trimmed_out', engine: 'engineControls.markers.trimmedOut' },
  controlsMarkersAddClipMarker: { host: 'frameleaf_studio_controls_markers_add_clip_marker', engine: 'engineControls.markers.addClipMarker' },
  controlsMarkersRemoveClipMarker: { host: 'frameleaf_studio_controls_markers_remove_clip_marker', engine: 'engineControls.markers.removeClipMarker' },
  controlsMarkersClipMarkersNote: { host: 'frameleaf_studio_controls_markers_clip_markers_note', engine: 'engineControls.markers.clipMarkersNote' },
  controlsGradeHdr: { host: 'frameleaf_studio_controls_grade_hdr', engine: 'engineControls.grade.hdr' },
  controlsGradeCdlNote: { host: 'frameleaf_studio_controls_grade_cdl_note', engine: 'engineControls.grade.cdlNote' },
  controlsGradeFineAdjust: { host: 'frameleaf_studio_controls_grade_fine_adjust', engine: 'engineControls.grade.fineAdjust' },
  controlsGradeRowSlope: { host: 'frameleaf_studio_controls_grade_row_slope', engine: 'engineControls.grade.row.slope' },
  controlsGradeRowOffset: { host: 'frameleaf_studio_controls_grade_row_offset', engine: 'engineControls.grade.row.offset' },
  controlsGradeRowPower: { host: 'frameleaf_studio_controls_grade_row_power', engine: 'engineControls.grade.row.power' },
  controlsGradeRowLift: { host: 'frameleaf_studio_controls_grade_row_lift', engine: 'engineControls.grade.row.lift' },
  controlsGradeRowGamma: { host: 'frameleaf_studio_controls_grade_row_gamma', engine: 'engineControls.grade.row.gamma' },
  controlsGradeRowGain: { host: 'frameleaf_studio_controls_grade_row_gain', engine: 'engineControls.grade.row.gain' },
  controlsGradeLoadCdl: { host: 'frameleaf_studio_controls_grade_load_cdl', engine: 'engineControls.grade.loadCdl' },
  controlsGradeLoadFailed: { host: 'frameleaf_studio_controls_grade_load_failed', engine: 'engineControls.grade.loadFailed' },
  controlsGradeHueHue: { host: 'frameleaf_studio_controls_grade_hue_hue', engine: 'engineControls.grade.hue.hue' },
  controlsGradeHueSat: { host: 'frameleaf_studio_controls_grade_hue_sat', engine: 'engineControls.grade.hue.sat' },
  controlsGradeHueLuma: { host: 'frameleaf_studio_controls_grade_hue_luma', engine: 'engineControls.grade.hue.luma' },
  controlsGradeHueCurve: { host: 'frameleaf_studio_controls_grade_hue_curve', engine: 'engineControls.grade.hue.curve', values: ['kind'] },
  controlsGradeHuePoint: { host: 'frameleaf_studio_controls_grade_hue_point', engine: 'engineControls.grade.hue.point', values: ['degrees'] },
  controlsGradeHueHint: { host: 'frameleaf_studio_controls_grade_hue_hint', engine: 'engineControls.grade.hue.hint' },
} as const satisfies Record<string, { host: string; engine: string; values?: readonly string[] }>;

export type EngineControlsString = keyof typeof ENGINE_CONTROLS_STRINGS;

type EngineControlsHostKey = (typeof ENGINE_CONTROLS_STRINGS)[EngineControlsString]['host'];
type Translate = (key: EngineControlsHostKey, options?: { values?: Record<string, string> }) => string;

/** The host's translation of every control string, with engine markers left in place. */
export function engineControlsStrings(translate: Translate): Record<EngineControlsString, string> {
  const strings = {} as Record<EngineControlsString, string>;
  for (const [name, entry] of Object.entries(ENGINE_CONTROLS_STRINGS) as Array<
    [EngineControlsString, { host: EngineControlsHostKey; values?: readonly string[] }]
  >) {
    const values = Object.fromEntries((entry.values ?? []).map((value) => [value, `{{${value}}}`]));
    strings[name] = entry.values ? translate(entry.host, { values }) : translate(entry.host);
  }
  return strings;
}
