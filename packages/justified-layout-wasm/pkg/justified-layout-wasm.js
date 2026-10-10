let wasm;

let cachedFloat32ArrayMemory0 = null;

function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let WASM_VECTOR_LEN = 0;

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}
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
 * @param {Float32Array} aspect_ratios
 * @param {number} row_height
 * @param {number} row_width
 * @param {number} spacing
 * @param {number} tolerance
 * @returns {Float32Array}
 */
export function get_justified_layout(aspect_ratios, row_height, row_width, spacing, tolerance) {
    const ptr0 = passArrayF32ToWasm0(aspect_ratios, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.get_justified_layout(ptr0, len0, row_height, row_width, spacing, tolerance);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

const EXPECTED_RESPONSE_TYPES = new Set(['basic', 'cors', 'default']);

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_export_0;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
        ;
    };

    return imports;
}

function __wbg_init_memory(imports, memory) {

}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedFloat32ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();

    __wbg_init_memory(imports);

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('justified-layout-wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    __wbg_init_memory(imports);

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
