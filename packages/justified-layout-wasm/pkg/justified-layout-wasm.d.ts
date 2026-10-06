/* tslint:disable */
/* eslint-disable */
/**
 * Given an input of aspect ratios representing boxes, returns a vector 4 times its length + 4.
 * The first element is the maximum width across all rows, the second is the total height required
 * to display all rows, the next two are padding, and the remaining elements are sequences of 4
 * elements for each box, representing the top, left, width and height positions.
 * `row_height` is a positive float that is the target height of the row.
 *     It is not strictly followed; the actual height may be off by one due to truncation, and may be
 *     substantially different if only one box can fit on a row and this box cannot fit with the
 *     target height. The height cannot exceed this target unless `tolerance` is greater than zero.
 * `row_width` is a positive float that is the target width of the row.
 *     It can be exceeded by a rounding error or shorter if the boxes cannot fill the row
 *     width given the `tolerance`.
 * `spacing` is a non-negative float that controls the spacing between boxes, including between rows.
 *     Notably, there is no offset applied in directions where there is no box.
 *     The first box will have its top and left positions both at 0, not at `spacing`, and so on.
 * `tolerance` is a non-negative float that gives more freedom to fill the row width.
 *     When there is free space in the row and the next box cannot fit in this row, it can scale
 *     the boxes to a larger height to fill this space while respecting aspect ratios. Additionally,
 *     the height can be shorter if shrinking the row height would allow more boxes to fit
 *     in the row without causing the height to be more off from the target height. A value of 0.15
 *     signifies that the actual row height may be up to 15% shorter or taller than the target height.
 *
 * Note: The response being Vec<i32> rather than a struct or list of structs is important, as the
 *       JS-WASM interop is *massively* slower when moving structs to JS instead of an array and
 *       importing integers is faster than floats.
 */
export function get_justified_layout(aspect_ratios: Float32Array, row_height: number, row_width: number, spacing: number, tolerance: number): Float32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly get_justified_layout: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
