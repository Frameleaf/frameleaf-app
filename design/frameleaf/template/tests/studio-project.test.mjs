import test from "node:test";
import assert from "node:assert/strict";
import { media } from "../src/media.js";
import {
  activeSequence,
  addClip,
  addMusic,
  addTitle,
  addVoiceover,
  clipAt,
  clipEnd,
  clipFromAsset,
  commit,
  createHistory,
  deleteClip,
  estimateRender,
  findClip,
  frameTimecode,
  gradeFilter,
  layoutTrack,
  linkedClips,
  loadProject,
  moveClip,
  parseProject,
  redo,
  reorder,
  sampleCaptions,
  sampleProject,
  saveProject,
  setKenBurns,
  setSpeed,
  setTransition,
  snapPoints,
  snapTime,
  splitClipAt,
  timelineLength,
  trackOfKind,
  trimClipEnd,
  trimClipStart,
  undo,
  updateClip,
  waveform,
} from "../src/studio-project.mjs";

const project = () => sampleProject(media);
const videoTrack = (p) => trackOfKind(activeSequence(p), "video");
const audioTrack = (p) => trackOfKind(activeSequence(p), "audio");
const clips = (p, kind = "video") => trackOfKind(activeSequence(p), kind).clips;
const videoEnd = (p) => clipEnd(clips(p).at(-1));
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, message || `${a} ≈ ${b}`);
const contiguousAndSorted = (track) => {
  for (let i = 1; i < track.clips.length; i += 1)
    assert.ok(
      track.clips[i].start >= clipEnd(track.clips[i - 1]) - 1e-6,
      `${track.name}: ${track.clips[i].name} overlaps ${track.clips[i - 1].name}`,
    );
};

test("sample project is valid, uses the collection videos and keeps camera audio linked", () => {
  const p = project();
  assert.equal(p.schemaVersion, 1);
  assert.equal(p.sequences.length, 2);
  const video = videoTrack(p);
  assert.equal(video.clips.filter((clip) => clip.kind === "video").length, 3);
  assert.ok(video.clips.some((clip) => clip.kind === "photo" && clip.kenBurns));
  const audio = audioTrack(p);
  assert.equal(audio.clips.length, 3);
  for (const clip of audio.clips) {
    const twin = video.clips.find((item) => item.linkId === clip.linkId);
    assert.ok(twin, "audio clip has a linked video clip");
    near(twin.start, clip.start);
    near(twin.duration, clip.duration);
  }
  for (const track of activeSequence(p).tracks) contiguousAndSorted(track);
  assert.ok(timelineLength(p) > 60);
  // Every clip's out point is derived from in, duration and speed.
  for (const track of activeSequence(p).tracks)
    for (const clip of track.clips) near(clip.out, clip.in + clip.duration * clip.speed);
});

test("split at the playhead keeps total duration and cuts linked audio at the same time", () => {
  const p = project();
  const before = timelineLength(p);
  const count = clips(p).length;
  const split = splitClipAt(p, 10);
  assert.equal(clips(split).length, count + 1);
  near(timelineLength(split), before);
  const [left, right] = clips(split);
  near(clipEnd(left), 10);
  near(right.start, 10);
  near(left.duration + right.duration, 20);
  near(right.in, left.out, "right half continues from the left half's source time");
  assert.equal(right.transitionIn, null);
  // Linked audio was split too and the halves are still linked pairwise.
  const audio = clips(split, "audio");
  assert.equal(audio.length, 4);
  assert.equal(audio[0].linkId, left.linkId);
  assert.equal(audio[1].linkId, right.linkId);
  assert.notEqual(left.linkId, right.linkId);
  // Splitting outside any clip or at a boundary is a no-op.
  assert.equal(splitClipAt(p, 0), p);
  assert.equal(splitClipAt(p, 10_000), p);
});

test("splitting a Ken Burns photo interpolates the motion at the cut", () => {
  const p = project();
  const photo = clips(p).find((clip) => clip.kind === "photo");
  const middle = photo.start + photo.duration / 2;
  const split = splitClipAt(p, middle, { clipIds: [photo.id] });
  const [left, right] = clips(split).filter((clip) => clip.assetId === photo.assetId && clip.kind === "photo");
  assert.deepEqual(left.kenBurns.to, right.kenBurns.from);
  near(left.kenBurns.to.w, (photo.kenBurns.from.w + photo.kenBurns.to.w) / 2);
  assert.equal(clips(split).length, clips(p).length + 1, "only the requested clip was split");
});

test("ripple trims shift later clips while plain trims open or close a gap", () => {
  const p = project();
  const [first, second] = clips(p);
  const rippled = trimClipEnd(p, first.id, clipEnd(first) - 4, { ripple: true });
  near(clips(rippled)[0].duration, first.duration - 4);
  near(clips(rippled)[1].start, second.start - 4, "later clip moved left with the ripple");
  near(videoEnd(rippled), videoEnd(p) - 4);
  near(clips(rippled, "audio")[0].duration, first.duration - 4, "linked audio trimmed too");

  const plain = trimClipEnd(p, first.id, clipEnd(first) - 4);
  near(clips(plain)[1].start, second.start, "later clip stays put without ripple");
  near(videoEnd(plain), videoEnd(p));

  const head = trimClipStart(p, second.id, second.start + 2);
  const trimmed = clips(head)[1];
  near(trimmed.start, second.start + 2);
  near(trimmed.duration, second.duration - 2);
  const headRipple = trimClipStart(p, second.id, second.start + 2, { ripple: true });
  near(clips(headRipple)[1].start, second.start, "ripple head trim keeps the clip in place");
  near(clips(headRipple)[2].start, clips(p)[2].start - 2);

  // A video head trim advances the source in point and cannot go past the source.
  const bounded = trimClipStart(p, first.id, first.start + 5);
  near(clips(bounded)[0].in, 5);
  const overshoot = trimClipEnd(p, first.id, clipEnd(first) + 500, { ripple: true });
  near(clipEnd(clips(overshoot)[0]), first.start + (first.sourceDuration - first.in) / first.speed);
  // Trims cannot make a clip shorter than the minimum.
  const collapsed = trimClipEnd(p, first.id, first.start);
  assert.ok(clips(collapsed)[0].duration >= 0.1);
});

test("moving a clip never leaves overlaps, keeps linked audio in sync and can change track", () => {
  const p = project();
  const [first, second, third] = clips(p);
  // Dropped in the first half of the first clip: it goes first, everything else follows.
  const moved = moveClip(p, third.id, { start: 3 });
  const track = videoTrack(moved);
  contiguousAndSorted(track);
  assert.equal(track.clips[0].id, third.id);
  near(track.clips[0].start, 0);
  assert.equal(track.clips[1].id, first.id);
  near(track.clips[1].start, third.duration);
  const audio = clips(moved, "audio").find((clip) => clip.linkId === third.linkId);
  near(audio.start, 0, "linked camera audio follows");
  near(videoEnd(moved), videoEnd(p), "a move never changes the cut length");
  // Dropped in the second half of the first clip: lands right after it.
  const after = videoTrack(moveClip(p, third.id, { start: 15 }));
  assert.equal(after.clips[1].id, third.id);
  near(after.clips[1].start, clipEnd(first));
  assert.equal(after.clips[2].id, second.id);
  contiguousAndSorted(after);
  // Cannot move before zero.
  near(clips(moveClip(p, first.id, { start: -20 }))[0].start, 0);
  // Cross-track move onto a compatible track.
  const overlay = trackOfKind(activeSequence(p), "overlay");
  const photo = clips(p).find((clip) => clip.kind === "photo");
  const relocated = moveClip(p, photo.id, { start: 2, trackId: overlay.id });
  assert.ok(!clips(relocated).some((clip) => clip.id === photo.id));
  assert.ok(trackOfKind(activeSequence(relocated), "overlay").clips.some((clip) => clip.id === photo.id));
  // Incompatible or locked targets are refused.
  assert.equal(moveClip(p, photo.id, { start: 2, trackId: audioTrack(p).id }), p);
});

test("delete ripples by default and lift leaves a gap", () => {
  const p = project();
  const [, second, third] = clips(p);
  const removed = deleteClip(p, second.id);
  assert.ok(!clips(removed).some((clip) => clip.id === second.id));
  near(clips(removed).find((clip) => clip.id === third.id).start, third.start - second.duration);
  near(videoEnd(removed), videoEnd(p) - second.duration);
  const lifted = deleteClip(p, second.id, { ripple: false });
  near(clips(lifted).find((clip) => clip.id === third.id).start, third.start);
  // Deleting a video clip removes its linked camera audio.
  const first = clips(p)[0];
  const audioGone = deleteClip(p, first.id);
  assert.ok(!clips(audioGone, "audio").some((clip) => clip.linkId === first.linkId));
});

test("speed changes rescale duration, ripple later clips and keep source range", () => {
  const p = project();
  const [first, second] = clips(p);
  const faster = setSpeed(p, first.id, 2);
  const clip = clips(faster)[0];
  near(clip.duration, first.duration / 2);
  near(clip.out, first.out);
  near(clips(faster)[1].start, second.start - first.duration / 2);
  near(clips(faster, "audio")[0].duration, first.duration / 2);
  assert.equal(setSpeed(p, first.id, 3), p, "unsupported speed is ignored");
  const photo = clips(p).find((item) => item.kind === "photo");
  assert.equal(setSpeed(p, photo.id, 2), p, "photos have no speed");
});

test("slow-motion clips keep how missing frames are made, defaulting to blended frames", () => {
  const p = project();
  const [first] = clips(p);
  const slow = setSpeed(p, first.id, 0.5);
  assert.equal(clips(slow)[0].retime, "blend");
  const ai = updateClip(slow, first.id, { retime: "ai", retimeModel: "rife-4.25@1" });
  assert.equal(clips(ai)[0].retime, "ai");
  assert.equal(clips(ai)[0].retimeModel, "rife-4.25@1");
  assert.equal(clips(updateClip(ai, first.id, { retime: "magic" }))[0].retime, "blend", "unknown methods fall back");
});

test("transitions are clamped to the neighbouring clips and Ken Burns rects stay in frame", () => {
  const p = project();
  const [, second] = clips(p);
  const withTransition = setTransition(p, second.id, { type: "Wipe", duration: 9 });
  const clip = clips(withTransition)[1];
  assert.equal(clip.transitionIn.type, "Wipe");
  assert.ok(clip.transitionIn.duration <= 2);
  assert.ok(clip.transitionIn.duration <= second.duration / 2 + 1e-6);
  assert.equal(clips(setTransition(p, second.id, null))[1].transitionIn, null);
  assert.equal(setTransition(p, second.id, { type: "Explode" }), p);
  const photo = clips(p).find((item) => item.kind === "photo");
  const framed = setKenBurns(p, photo.id, { from: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, to: { x: -1, y: 0, w: 3, h: 3 } });
  const kb = findClip(framed, photo.id).clip.kenBurns;
  assert.deepEqual(kb.from, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  assert.deepEqual(kb.to, { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(setKenBurns(p, clips(p)[0].id, kb), p, "videos have no Ken Burns");
});

test("adding clips, titles, music and voiceovers lands them on the right tracks", () => {
  const p = project();
  const asset = media.find((item) => item.type === "video");
  const clip = clipFromAsset(asset, { id: "added" });
  // 15 s is in the second half of the 20 s lake clip, so the new clip lands after it.
  const added = addClip(p, videoTrack(p).id, clip, 15);
  const placed = findClip(added, "added");
  assert.ok(placed && placed.track.kind === "video");
  near(placed.clip.start, 20);
  near(videoEnd(added), videoEnd(p) + clip.duration);
  contiguousAndSorted(videoTrack(added));
  assert.ok(clips(added, "audio").some((item) => item.linkId === "added"), "video brings linked audio");
  assert.equal(linkedClips(added, "added").length, 2);

  const titled = addTitle(p, { id: "t1", text: "Hello", at: 3, duration: 2, style: "Bold" });
  const title = findClip(titled, "t1");
  assert.equal(title.track.kind, "title");
  assert.equal(title.clip.text, "Hello");
  assert.equal(title.clip.style, "Bold");

  const scored = addMusic(p, "riverbank", 10, { id: "m1" });
  const music = findClip(scored, "m1");
  assert.equal(music.track.kind, "music");
  assert.ok(music.clip.duration <= 182);
  assert.equal(addMusic(p, "not-a-track", 0), p);

  const voiced = addVoiceover(p, { id: "v1", at: 20, duration: 3, seed: 7 });
  assert.equal(findClip(voiced, "v1").track.kind, "voice");
  // Wrong kind for the track is refused.
  assert.equal(addClip(p, audioTrack(p).id, clip, 0), p);
});

test("reorder re-flows the track contiguously and drags linked audio along", () => {
  const p = project();
  const [first, second] = clips(p);
  const swapped = reorder(p, videoTrack(p).id, second.id, 0);
  const track = videoTrack(swapped);
  assert.equal(track.clips[0].id, second.id);
  assert.equal(track.clips[1].id, first.id);
  contiguousAndSorted(track);
  near(track.clips[0].start, 0);
  near(track.clips[1].start, second.duration);
  const audio = clips(swapped, "audio").find((clip) => clip.linkId === first.linkId);
  near(audio.start, second.duration);
});

test("undo and redo round-trip through history", () => {
  let history = createHistory(project());
  const original = history.present;
  history = commit(history, splitClipAt(history.present, 10));
  history = commit(history, deleteClip(history.present, clips(history.present)[0].id));
  assert.equal(history.past.length, 2);
  history = undo(history);
  assert.equal(clips(history.present).length, clips(original).length + 1);
  history = undo(history);
  assert.equal(history.present, original);
  assert.equal(undo(history), history, "nothing more to undo");
  history = redo(history);
  history = redo(history);
  assert.equal(clips(history.present).length, clips(original).length);
  assert.equal(redo(history), history);
  assert.equal(commit(history, history.present), history, "no-op commits are ignored");
  const branched = commit(undo(history), addTitle(history.present, { text: "x" }));
  assert.equal(branched.future.length, 0, "a new commit clears redo");
});

test("persistence rejects bad shapes and repairs what it can", () => {
  assert.equal(loadProject("not json"), null);
  assert.equal(loadProject(""), null);
  assert.equal(loadProject(JSON.stringify([])), null);
  assert.equal(loadProject(JSON.stringify({ schemaVersion: 2, sequences: [] })), null);
  assert.equal(parseProject({ schemaVersion: 1, sequences: [{ id: "s" , tracks: "nope" }] })?.sequences.length, 1);
  const saved = saveProject(project());
  const restored = loadProject(saved, { assetIds: media.map((asset) => asset.id) });
  assert.deepEqual(
    { ...restored, updatedAt: "" },
    { ...project(), updatedAt: "" },
    "save/load round-trips",
  );
  // Unknown assets, bad numbers and overlapping clips are repaired.
  const messy = parseProject(
    {
      schemaVersion: 1,
      name: 42,
      sequences: [
        {
          id: "s1",
          tracks: [
            {
              id: "v",
              kind: "video",
              clips: [
                { id: "a", kind: "video", assetId: "1", start: 0, duration: 5, sourceDuration: 24 },
                { id: "b", kind: "video", assetId: "1", start: 2, duration: 5, sourceDuration: 24 },
                { id: "ghost", kind: "video", assetId: "nope", start: 0, duration: 5 },
                { id: "bad", kind: "video", assetId: "1", start: "x", duration: -1 },
                { id: "audio-on-video", kind: "audio", start: 0, duration: 5 },
                { id: "c", kind: "photo", assetId: "2", start: 100, duration: 3, kenBurns: { from: { x: 5 }, to: 7 } },
              ],
            },
          ],
          captions: [{ start: 3, end: 1, text: "backwards" }, { start: 1, end: 2, text: "ok" }],
        },
      ],
      settings: { mode: "wizard" },
    },
    { assetIds: ["1", "2"] },
  );
  assert.equal(messy.name, "Untitled project");
  const track = messy.sequences[0].tracks.find((item) => item.kind === "video");
  assert.deepEqual(track.clips.map((clip) => clip.id), ["a", "b", "c"]);
  near(track.clips[1].start, 5, "overlap pushed right");
  assert.deepEqual(track.clips[2].kenBurns.from, { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(messy.sequences[0].captions.length, 1);
  assert.equal(messy.settings.mode, "basic");
  assert.equal(messy.sequences[0].tracks.length, 6, "missing track kinds are added");
  assert.equal(messy.activeSequenceId, "s1");
});

test("timeline queries: length, clipAt, snapping and layout", () => {
  const p = project();
  const sequence = activeSequence(p);
  const track = videoTrack(p);
  assert.equal(clipAt(track, 0).id, track.clips[0].id);
  assert.equal(clipAt(track, clipEnd(track.clips[0])).id, track.clips[1].id);
  assert.equal(clipAt(track, timelineLength(p) + 1), null);
  const points = snapPoints(sequence, { exclude: [track.clips[0].id], extra: [12.345] });
  assert.ok(points.includes(0) && points.includes(12.345));
  assert.ok(points.every((value, index) => index === 0 || value > points[index - 1]));
  assert.equal(snapTime(19.9, points, 0.25), 20);
  assert.equal(snapTime(17, points, 0.25), 17);
  const laid = layoutTrack([
    { id: "x", start: 4, duration: 2 },
    { id: "y", start: 0, duration: 5 },
  ]);
  assert.deepEqual(laid.map((clip) => [clip.id, clip.start]), [["y", 0], ["x", 5]]);
  const base = [
    { id: "a", start: 0, duration: 4 },
    { id: "b", start: 4, duration: 4 },
  ];
  // Dropped in the first half of "a": lands before it and pushes the rest.
  const early = layoutTrack([...base, { id: "new", start: 1, duration: 3 }], "new");
  assert.deepEqual(early.map((clip) => [clip.id, clip.start]), [["new", 0], ["a", 3], ["b", 7]]);
  // Dropped in the second half of "a": lands after it.
  const late = layoutTrack([...base, { id: "new", start: 3, duration: 3 }], "new");
  assert.deepEqual(late.map((clip) => [clip.id, clip.start]), [["a", 0], ["new", 4], ["b", 7]]);
  // Dropped in a gap it fits in: nothing else moves.
  const gap = layoutTrack([{ id: "a", start: 0, duration: 2 }, { id: "b", start: 10, duration: 2 }, { id: "new", start: 4, duration: 3 }], "new");
  assert.deepEqual(gap.map((clip) => [clip.id, clip.start]), [["a", 0], ["new", 4], ["b", 10]]);
});

test("render estimates are monotonic and only cloud runs cost money", () => {
  const short = estimateRender({ durationSeconds: 30, resolution: "1080p", destination: "local" });
  const long = estimateRender({ durationSeconds: 60, resolution: "1080p", destination: "local" });
  assert.ok(long.seconds > short.seconds);
  assert.ok(long.sizeBytes > short.sizeBytes);
  assert.equal(short.cloudCost.amount, 0);
  assert.equal(short.cloudCost.uncertainty, 0);
  const uhd = estimateRender({ durationSeconds: 60, resolution: "2160p", destination: "local" });
  assert.ok(uhd.seconds > long.seconds && uhd.sizeBytes > long.sizeBytes);
  const creative = estimateRender({ durationSeconds: 60, resolution: "2160p", mode: "Creative" });
  assert.ok(creative.seconds > uhd.seconds);
  const upscaled = estimateRender({ durationSeconds: 60, resolution: "2160p", upscale: 4 });
  assert.ok(upscaled.seconds > uhd.seconds);
  const cloud = estimateRender({ durationSeconds: 60, resolution: "2160p", destination: "cloud" });
  assert.ok(cloud.cloudCost.amount > 0);
  assert.ok(cloud.cloudCost.uncertainty > 0 && cloud.cloudCost.uncertainty < cloud.cloudCost.amount);
  assert.equal(cloud.cloudCost.currency, "USD");
  const exported = estimateRender({ durationSeconds: 60, resolution: "2160p", kind: "export" });
  assert.ok(exported.seconds < uhd.seconds, "exports are cheaper than restorations");
  assert.deepEqual(estimateRender({ durationSeconds: -5 }).sizeBytes, 0);
});

test("waveforms are deterministic, bounded and sized", () => {
  const a = waveform(42, 32);
  const b = waveform(42, 32);
  assert.deepEqual(a, b);
  assert.equal(a.length, 32);
  assert.ok(a.every((value) => value >= 0.04 && value <= 1));
  assert.notDeepEqual(a, waveform(43, 32));
  assert.equal(waveform("junk", 0).length, 1);
});

test("timecodes, grades and sample captions", () => {
  assert.equal(frameTimecode(18.4, 30), "00:00:18:12");
  assert.equal(frameTimecode(3725, 30), "01:02:05:00");
  assert.equal(frameTimecode(-1), "00:00:00:00");
  assert.equal(gradeFilter(null), "none");
  assert.match(gradeFilter({ look: "alpine", intensity: 1, exposure: 0, contrast: 0, saturation: 0, temperature: 0, wheels: { lift: { x: 0, y: 0 }, gamma: { x: 0, y: 0 }, gain: { x: 0, y: 0 } } }), /contrast\(1\.080\)/);
  const p = project();
  const captions = sampleCaptions(activeSequence(p), "French");
  assert.equal(captions.length, 10);
  assert.ok(captions.every((line, index) => index === 0 || line.start >= captions[index - 1].end - 1e-6));
  assert.ok(captions.at(-1).end <= timelineLength(p));
  assert.match(captions[0].text, /lac/);
  const updated = updateClip(p, "title-main", { text: "New title", style: "Serif", position: "tc" });
  const title = findClip(updated, "title-main").clip;
  assert.equal(title.text, "New title");
  assert.equal(title.style, "Serif");
  assert.equal(updateClip(p, "title-main", { text: "Summer in the Rockies" }), p, "identical patch is a no-op");
});
