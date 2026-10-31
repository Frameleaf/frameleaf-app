import { expect, it } from 'vite-plus/test'
import { installTimelineTouchEditing } from '../src/timeline-touch'
import { useTimelineCommandStore } from '@/features/timeline/stores/timeline-command-store'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Vitest disables CSS module processing; inspect the production stylesheet bytes directly.
const editorCss = readFileSync(resolve(__dirname, '../src/editor.css'), 'utf8')

it('routes one touch clip gesture through mouse tools, and rolls back cancellation without capturing page input', () => {
  document.body.innerHTML =
    '<div data-timeline-item><button>Fade</button><input><textarea></textarea><select></select><a href="#">Link</a></div><div id="scroll"></div>'
  const clip = document.querySelector('button')!
  const events: Array<[string, number, number]> = []
  const frames: FrameRequestCallback[] = []
  const requestFrame = window.requestAnimationFrame
  window.requestAnimationFrame = (callback) => {
    frames.push(callback)
    return frames.length
  }
  const paint = () => frames.splice(0).forEach((callback) => callback(0))
  const record = (event: MouseEvent) => events.push([event.type, event.clientX, event.buttons])
  for (const type of ['mousedown', 'mousemove', 'mouseup'])
    window.addEventListener(type, record as EventListener)
  const release = installTimelineTouchEditing()
  const history = useTimelineCommandStore.getState()
  const priorTracks = [
    {
      id: 'v1',
      name: 'Video',
      kind: 'video' as const,
      height: 60,
      locked: false,
      visible: true,
      muted: false,
      solo: false,
      order: 0,
    },
  ]
  useItemsStore.getState().setTracks(priorTracks)
  history.clearHistory()
  history.execute({ type: 'track.set' }, () => useItemsStore.getState().setTracks([]))
  history.undo() // An interrupted gesture must preserve an existing redo as well.
  const previousRedo = useTimelineCommandStore.getState().redoStack
  const beforeTracks = structuredClone(useItemsStore.getState().tracks)
  const pointer = (
    type: string,
    target: EventTarget = clip,
    fields: Record<string, unknown> = {},
    painted = true,
  ) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 20,
    })
    Object.defineProperties(
      event,
      Object.fromEntries(
        Object.entries({ pointerType: 'touch', pointerId: 1, isPrimary: true, ...fields }).map(
          ([key, value]) => [key, { value }],
        ),
      ),
    )
    target.dispatchEvent(event)
    if (painted) paint()
    return event.defaultPrevented
  }
  try {
    for (const target of [
      ...document.querySelectorAll('input, textarea, select, a'),
      document.querySelector('#scroll')!,
    ]) {
      expect(pointer('pointerdown', target)).toBe(false)
    }
    expect(pointer('pointerdown', clip, { pointerType: 'mouse' })).toBe(false)
    expect(pointer('pointerdown', clip, { isPrimary: false })).toBe(false)
    expect(events).toEqual([])
    pointer('pointerdown', clip, {}, false)
    expect(events).toEqual([['mousemove', 10, 0]]) // Hover paints before the tool is pressed.
    pointer('pointercancel')
    expect(events).toEqual([['mousemove', 10, 0]])
    events.length = 0
    pointer('pointerdown', clip, {}, false)
    pointer('pointerup', window, { clientX: 40 }) // A quick release still starts and finishes its tool.
    expect(events).toEqual([
      ['mousemove', 10, 0],
      ['mousedown', 10, 1],
      ['mousemove', 40, 1],
      ['mouseup', 40, 0],
    ])
    events.length = 0
    pointer('pointerdown', clip, {}, false)
    pointer('pointermove', window, { clientX: 40 }, false)
    paint()
    expect(events).toEqual([
      ['mousemove', 10, 0],
      ['mousedown', 10, 1],
      ['mousemove', 40, 1],
    ])
    pointer('pointercancel')
    events.length = 0
    expect(pointer('pointerdown')).toBe(true)
    pointer('pointermove', window, { pointerId: 2 })
    pointer('pointerup', window, { pointerId: 2 })
    expect(events).toEqual([
      ['mousemove', 10, 0],
      ['mousedown', 10, 1],
    ])
    pointer('pointermove', window, { clientX: 40 })
    expect(events.at(-1)).toEqual(['mousemove', 40, 1])
    const edit = () =>
      history.execute({ type: 'track.set' }, () => useItemsStore.getState().setTracks([]))
    window.addEventListener('mouseup', edit, { once: true })
    pointer('pointercancel', window)
    expect(events.at(-1)).toEqual(['mouseup', 40, 0])
    expect(useItemsStore.getState().tracks).toEqual(beforeTracks)
    expect(useTimelineCommandStore.getState().canUndo).toBe(false)
    expect(useTimelineCommandStore.getState().redoStack).toBe(previousRedo)
    expect(useTimelineCommandStore.getState().canRedo).toBe(true)
    events.length = 0
    pointer('pointerdown')
    pointer('pointerup')
    expect(events.slice(-2)).toEqual([
      ['mousemove', 10, 1],
      ['mouseup', 10, 0],
    ])
    pointer('pointerdown')
    history.execute({ type: 'track.set' }, () =>
      useItemsStore
        .getState()
        .setTracks([{ ...beforeTracks[0]!, name: 'Independent edit during touch' }]),
    )
    const independent = structuredClone(useItemsStore.getState().tracks)
    const independentUndo = useTimelineCommandStore.getState().undoStack
    window.addEventListener('mouseup', edit, { once: true })
    pointer('pointercancel')
    expect(useItemsStore.getState().tracks).toEqual(independent)
    expect(useTimelineCommandStore.getState().undoStack).toBe(independentUndo)
    pointer('pointerdown')
    history.setActiveContext('another-sequence')
    events.length = 0
    pointer('pointermove')
    pointer('pointerup')
    expect(events).toEqual([])
    expect(useTimelineCommandStore.getState().canUndo).toBe(false)
    history.setActiveContext(null)
    pointer('pointerdown', clip, {}, false)
    events.length = 0
    release()
    paint()
    events.length = 0
    pointer('pointerdown')
    expect(events).toEqual([])
  } finally {
    release()
    window.requestAnimationFrame = requestFrame
    for (const type of ['mousedown', 'mousemove', 'mouseup'])
      window.removeEventListener(type, record as EventListener)
    document.body.innerHTML = ''
    useItemsStore.getState().setTracks([])
    history.clearHistory()
  }
})

it.each([
  ['explicit', '<div data-timeline-item><span contenteditable="true">Edit</span></div>'],
  ['empty', '<div data-timeline-item><span contenteditable>Edit</span></div>'],
  [
    'plaintext-only',
    '<div data-timeline-item><span contenteditable="plaintext-only">Edit</span></div>',
  ],
  ['inherited', '<div data-timeline-item><div contenteditable><span>Edit</span></div></div>'],
  ['outside clip', '<div contenteditable><div data-timeline-item><span>Edit</span></div></div>'],
])('retains native touch in %s editable regions', (_variant, markup) => {
  document.body.innerHTML = markup
  const target = document.querySelector('span')!
  // jsdom lacks native isContentEditable, including its inherited/enumerated HTML semantics.
  // Supply the browser property here; the adapter must use it instead of matching one attribute value.
  Object.defineProperty(target, 'isContentEditable', { value: true })
  const release = installTimelineTouchEditing()
  try {
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
      pointerType: { value: 'touch' },
      pointerId: { value: 1 },
      isPrimary: { value: true },
    })
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    // Descendant auto cannot override ancestor none: the entire editable clip must stay native.
    const touchSelector = editorCss.match(
      /(\[data-timeline-item\][^{]*)\{\s*touch-action: none;\s*\}/,
    )?.[1]
    expect(touchSelector).toBeDefined()
    expect(document.querySelector('[data-timeline-item]')!.matches(touchSelector!)).toBe(false)
  } finally {
    release()
    document.body.innerHTML = ''
  }
})
