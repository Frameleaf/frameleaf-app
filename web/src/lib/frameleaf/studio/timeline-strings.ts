/**
 * The words of the editor's timeline (FL-1822): the toolbar's Tool menu, In and Out, More menu and
 * tooltips; the track buttons and menu; the keyframes lane's header and Easing menu; and the Align
 * row that moved from above the transport into the inspector's Transform group. Translated by the
 * host, as for the shell strings (`shell-strings.ts`): the engine speaks fewer languages than the
 * host, so the host sends its translation in `context.strings` and the adapter writes it over the
 * engine key. A value filled in at run time travels as an i18next `{{name}}` marker. Several engine
 * keys can share one host message.
 */
export const TIMELINE_STRINGS = {
  timelineToolSelect: { host: 'frameleaf_studio_timeline_tool_select', engine: 'timeline.header.tools.select' },
  timelineToolSelectNote: {
    host: 'frameleaf_studio_timeline_tool_select_note',
    engine: 'timeline.header.tools.selectNote',
  },
  timelineToolTrim: { host: 'frameleaf_studio_timeline_tool_trim', engine: 'timeline.header.tools.trim' },
  timelineToolTrimNote: { host: 'frameleaf_studio_timeline_tool_trim_note', engine: 'timeline.header.tools.trimNote' },
  timelineToolRazor: { host: 'frameleaf_studio_timeline_tool_razor', engine: 'timeline.header.tools.razor' },
  timelineToolRazorNote: {
    host: 'frameleaf_studio_timeline_tool_razor_note',
    engine: 'timeline.header.tools.razorNote',
  },
  timelineToolStretch: { host: 'frameleaf_studio_timeline_tool_stretch', engine: 'timeline.header.tools.stretch' },
  timelineToolStretchNote: {
    host: 'frameleaf_studio_timeline_tool_stretch_note',
    engine: 'timeline.header.tools.stretchNote',
  },
  timelineToolSlip: { host: 'frameleaf_studio_timeline_tool_slip', engine: 'timeline.header.tools.slip' },
  timelineToolSlipNote: { host: 'frameleaf_studio_timeline_tool_slip_note', engine: 'timeline.header.tools.slipNote' },
  timelineToolSlide: { host: 'frameleaf_studio_timeline_tool_slide', engine: 'timeline.header.tools.slide' },
  timelineToolSlideNote: {
    host: 'frameleaf_studio_timeline_tool_slide_note',
    engine: 'timeline.header.tools.slideNote',
  },
  timelineToolAria: {
    host: 'frameleaf_studio_timeline_tool_aria',
    engine: 'timeline.header.toolAria',
    values: ['tool'],
  },
  timelineSnapping: { host: 'frameleaf_studio_timeline_snapping', engine: 'timeline.header.snapping' },
  timelineSnapOn: { host: 'frameleaf_studio_timeline_snap_on', engine: 'timeline.header.snapEnabled' },
  timelineSnapOff: { host: 'frameleaf_studio_timeline_snap_off', engine: 'timeline.header.snapDisabled' },
  timelineInOut: { host: 'frameleaf_studio_timeline_in_out', engine: 'timeline.header.inOut' },
  timelineIn: { host: 'frameleaf_studio_timeline_in', engine: 'timeline.header.in' },
  timelineOut: { host: 'frameleaf_studio_timeline_out', engine: 'timeline.header.out' },
  timelineSetIn: { host: 'frameleaf_studio_timeline_set_in', engine: 'timeline.header.setInPoint' },
  timelineSetInTooltip: { host: 'frameleaf_studio_timeline_set_in', engine: 'timeline.header.setInPointTooltip' },
  timelineSetOut: { host: 'frameleaf_studio_timeline_set_out', engine: 'timeline.header.setOutPoint' },
  timelineSetOutTooltip: { host: 'frameleaf_studio_timeline_set_out', engine: 'timeline.header.setOutPointTooltip' },
  timelineAddMarker: { host: 'frameleaf_studio_timeline_add_marker', engine: 'timeline.header.addMarker' },
  timelineAddMarkerTooltip: {
    host: 'frameleaf_studio_timeline_add_marker',
    engine: 'timeline.header.addMarkerTooltip',
  },
  timelineUndo: { host: 'frameleaf_studio_timeline_undo', engine: 'timeline.header.undo' },
  timelineUndoTooltip: { host: 'frameleaf_studio_timeline_undo', engine: 'timeline.header.undoTooltip' },
  timelineRedo: { host: 'frameleaf_studio_timeline_redo', engine: 'timeline.header.redo' },
  timelineRedoTooltip: { host: 'frameleaf_studio_timeline_redo', engine: 'timeline.header.redoTooltip' },
  timelineKeyframesShow: {
    host: 'frameleaf_studio_timeline_keyframes_show',
    engine: 'timeline.keyframeEditor.editLane.show',
  },
  timelineKeyframesHide: {
    host: 'frameleaf_studio_timeline_keyframes_hide',
    engine: 'timeline.keyframeEditor.editLane.hide',
  },
  timelineMore: { host: 'frameleaf_studio_timeline_more', engine: 'timeline.header.more' },
  timelineMoreAria: { host: 'frameleaf_studio_timeline_more_aria', engine: 'timeline.header.moreAria' },
  timelineLinked: { host: 'frameleaf_studio_timeline_linked', engine: 'timeline.header.linkedSelection' },
  timelineLinkedNote: {
    host: 'frameleaf_studio_timeline_linked_note',
    engine: 'timeline.header.linkedSelectionNote',
  },
  timelineScrubSound: { host: 'frameleaf_studio_timeline_scrub_sound', engine: 'timeline.header.soundWhileScrubbing' },
  timelineScrubSoundNote: {
    host: 'frameleaf_studio_timeline_scrub_sound_note',
    engine: 'timeline.header.soundWhileScrubbingNote',
  },
  timelineClearInOut: { host: 'frameleaf_studio_timeline_clear_in_out', engine: 'timeline.header.clearInOut' },
  timelineRemoveMarker: { host: 'frameleaf_studio_timeline_remove_marker', engine: 'timeline.header.removeMarker' },
  timelineClearMarkers: { host: 'frameleaf_studio_timeline_clear_markers', engine: 'timeline.header.clearMarkers' },
  timelineTrackHide: { host: 'frameleaf_studio_timeline_track_hide', engine: 'timeline.trackHeader.hideTrack' },
  timelineTrackShow: { host: 'frameleaf_studio_timeline_track_show', engine: 'timeline.trackHeader.showTrack' },
  timelineTrackMute: { host: 'frameleaf_studio_timeline_track_mute', engine: 'timeline.trackHeader.muteTrack' },
  timelineTrackUnmute: { host: 'frameleaf_studio_timeline_track_unmute', engine: 'timeline.trackHeader.unmuteTrack' },
  timelineTrackSolo: { host: 'frameleaf_studio_timeline_track_solo', engine: 'timeline.trackHeader.soloTrack' },
  timelineTrackUnsolo: { host: 'frameleaf_studio_timeline_track_unsolo', engine: 'timeline.trackHeader.unsoloTrack' },
  timelineTrackLock: { host: 'frameleaf_studio_timeline_track_lock', engine: 'timeline.trackHeader.lockTrack' },
  timelineTrackUnlock: { host: 'frameleaf_studio_timeline_track_unlock', engine: 'timeline.trackHeader.unlockTrack' },
  timelineTrackSynced: {
    host: 'frameleaf_studio_timeline_track_synced',
    engine: 'timeline.trackHeader.disableSyncLock',
  },
  timelineTrackNotSynced: {
    host: 'frameleaf_studio_timeline_track_not_synced',
    engine: 'timeline.trackHeader.enableSyncLock',
  },
  timelineTrackCloseGaps: {
    host: 'frameleaf_studio_timeline_track_close_gaps',
    engine: 'timeline.trackHeader.closeAllGaps',
  },
  timelineTrackAddVideo: {
    host: 'frameleaf_studio_timeline_track_add_video',
    engine: 'timeline.trackHeader.addVideoTrack',
  },
  timelineTrackAddAudio: {
    host: 'frameleaf_studio_timeline_track_add_audio',
    engine: 'timeline.trackHeader.addAudioTrack',
  },
  timelineTrackDelete: { host: 'frameleaf_studio_timeline_track_delete', engine: 'timeline.trackHeader.deleteTrack' },
  timelineTrackDeleteEmpty: {
    host: 'frameleaf_studio_timeline_track_delete_empty',
    engine: 'timeline.trackHeader.deleteEmptyTracks',
  },
  timelineTrackOff: { host: 'frameleaf_studio_timeline_track_off', engine: 'timeline.trackHeader.disableTrack' },
  timelineTrackOn: { host: 'frameleaf_studio_timeline_track_on', engine: 'timeline.trackHeader.enableTrack' },
  timelineAlignTitle: { host: 'frameleaf_studio_timeline_align_title', engine: 'preview.align.title' },
  timelineAlignLeft: { host: 'frameleaf_studio_timeline_align_left', engine: 'preview.align.left' },
  timelineAlignCentreAcross: { host: 'frameleaf_studio_timeline_align_centre_across', engine: 'preview.align.centerH' },
  timelineAlignRight: { host: 'frameleaf_studio_timeline_align_right', engine: 'preview.align.right' },
  timelineAlignTop: { host: 'frameleaf_studio_timeline_align_top', engine: 'preview.align.top' },
  timelineAlignCentreDown: { host: 'frameleaf_studio_timeline_align_centre_down', engine: 'preview.align.centerV' },
  timelineAlignBottom: { host: 'frameleaf_studio_timeline_align_bottom', engine: 'preview.align.bottom' },
  timelineAlignSpaceAcross: {
    host: 'frameleaf_studio_timeline_align_space_across',
    engine: 'preview.align.distributeH',
  },
  timelineAlignSpaceDown: { host: 'frameleaf_studio_timeline_align_space_down', engine: 'preview.align.distributeV' },
  timelineAlignSnap: { host: 'frameleaf_studio_timeline_align_snap', engine: 'preview.align.toggleCanvasSnap' },
  timelineKeyframesTitle: {
    host: 'frameleaf_studio_timeline_keyframes_title',
    engine: 'timeline.keyframeEditor.title',
  },
  timelineKeyframesInClip: {
    host: 'frameleaf_studio_timeline_keyframes_in_clip',
    engine: 'timeline.keyframeEditor.local',
  },
  timelineKeyframesInProject: {
    host: 'frameleaf_studio_timeline_keyframes_in_project',
    engine: 'timeline.keyframeEditor.global',
  },
  timelineKeyframesFrameInClip: {
    host: 'frameleaf_studio_timeline_keyframes_frame_in_clip',
    engine: 'timeline.keyframeEditor.localFrame',
  },
  timelineKeyframesFrameInProject: {
    host: 'frameleaf_studio_timeline_keyframes_frame_in_project',
    engine: 'timeline.keyframeEditor.globalFrame',
  },
  timelineKeyframesProperty: {
    host: 'frameleaf_studio_timeline_keyframes_property',
    engine: 'timeline.keyframeEditor.property',
  },
  timelineKeyframesWhich: {
    host: 'frameleaf_studio_timeline_keyframes_which',
    engine: 'timeline.keyframeEditor.propertyVisibility',
  },
  timelineKeyframesAnimated: {
    host: 'frameleaf_studio_timeline_keyframes_animated',
    engine: 'timeline.keyframeEditor.animatedProperties',
  },
  timelineKeyframesAll: {
    host: 'frameleaf_studio_timeline_keyframes_all',
    engine: 'timeline.keyframeEditor.allProperties',
  },
  keyframesEasing: {
    host: 'frameleaf_studio_timeline_keyframes_easing',
    engine: 'timeline.keyframeEditor.easingMenu',
  },
  keyframesEasingHold: {
    host: 'frameleaf_studio_timeline_keyframes_easing_hold',
    engine: 'timeline.keyframeEditor.easing.hold',
  },
  keyframesEasingLinear: {
    host: 'frameleaf_studio_timeline_keyframes_easing_linear',
    engine: 'timeline.keyframeEditor.easing.linear',
  },
  keyframesEasingIn: {
    host: 'frameleaf_studio_timeline_keyframes_easing_ease_in',
    engine: 'timeline.keyframeEditor.easing.easeIn',
  },
  keyframesEasingInOut: {
    host: 'frameleaf_studio_timeline_keyframes_easing_ease_in_out',
    engine: 'timeline.keyframeEditor.easing.easeInOut',
  },
  keyframesEasingOut: {
    host: 'frameleaf_studio_timeline_keyframes_easing_ease_out',
    engine: 'timeline.keyframeEditor.easing.easeOut',
  },
} as const satisfies Record<string, { host: string; engine: string; values?: readonly string[] }>;

export type TimelineString = keyof typeof TIMELINE_STRINGS;

type TimelineHostKey = (typeof TIMELINE_STRINGS)[TimelineString]['host'];
type Translate = (key: TimelineHostKey, options?: { values?: Record<string, string> }) => string;

/** The host's translation of every toolbar string, with engine markers left in place. */
export function timelineStrings(translate: Translate): Record<TimelineString, string> {
  const strings = {} as Record<TimelineString, string>;
  for (const [name, entry] of Object.entries(TIMELINE_STRINGS) as Array<
    [TimelineString, { host: TimelineHostKey; values?: readonly string[] }]
  >) {
    const values = Object.fromEntries((entry.values ?? []).map((value) => [value, `{{${value}}}`]));
    strings[name] = entry.values ? translate(entry.host, { values }) : translate(entry.host);
  }
  return strings;
}
