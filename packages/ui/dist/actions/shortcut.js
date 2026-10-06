import { mdiAppleKeyboardCommand, mdiAppleKeyboardOption, mdiAppleKeyboardShift, mdiArrowDown, mdiArrowLeft, mdiArrowRight, mdiArrowUp, mdiKeyboardReturn, mdiKeyboardTab, mdiKeyboardTabReverse, mdiMicrosoftWindows, } from '@mdi/js';
import { on } from 'svelte/events';
export const shortcutLabel = (shortcut) => {
    let label = '';
    if (shortcut.ctrl) {
        label += 'Ctrl ';
    }
    if (shortcut.alt) {
        label += 'Alt ';
    }
    if (shortcut.meta) {
        label += 'Cmd ';
    }
    if (shortcut.shift) {
        label += '⇧';
    }
    label += shortcut.key.toUpperCase();
    return label;
};
/** Determines whether an event should be ignored. The event will be ignored if:
 *  - The element dispatching the event is not the same as the element which the event listener is attached to
 *  - The element dispatching the event is an input field
 */
export const shouldIgnoreEvent = (event) => {
    if (event.target === event.currentTarget) {
        return false;
    }
    const type = event.target.type;
    return ['textarea', 'text', 'date', 'datetime-local', 'email', 'password'].includes(type);
};
export const matchesShortcut = (event, shortcut) => {
    return (shortcut.key.toLowerCase() === event.key.toLowerCase() &&
        Boolean(shortcut.alt) === event.altKey &&
        Boolean(shortcut.ctrl) === event.ctrlKey &&
        Boolean(shortcut.shift) === event.shiftKey &&
        Boolean(shortcut.meta) === event.metaKey);
};
const isMacOS = globalThis.navigator && /Mac(intosh|Intel)/.test(navigator.userAgent);
export const renderKeyboardEvent = (item) => {
    switch (item.key) {
        case 'ArrowLeft': {
            return { icon: mdiArrowLeft };
        }
        case 'ArrowRight': {
            return { icon: mdiArrowRight };
        }
        case 'ArrowUp': {
            return { icon: mdiArrowUp };
        }
        case 'ArrowDown': {
            return { icon: mdiArrowDown };
        }
        case 'Enter': {
            return { icon: mdiKeyboardReturn };
        }
        case 'Shift': {
            return { icon: mdiAppleKeyboardShift };
        }
        case 'Tab': {
            return { icon: item.shiftKey ? mdiKeyboardTabReverse : mdiKeyboardTab };
        }
        case 'Space':
        case ' ': {
            return { key: 'Space' };
        }
    }
    return { key: item.key };
};
export const renderShortcut = ({ alt, meta, ctrl, shift, key }) => {
    const results = [];
    if (alt) {
        results.push(isMacOS ? { icon: mdiAppleKeyboardOption } : { key: 'Alt' });
    }
    if (meta) {
        results.push(isMacOS ? { icon: mdiAppleKeyboardCommand } : { key: mdiMicrosoftWindows });
    }
    if (ctrl) {
        results.push({ key: 'Ctrl' });
    }
    if (shift) {
        results.push({ icon: mdiAppleKeyboardShift });
    }
    const item = renderKeyboardEvent({
        key,
        code: key,
        shiftKey: shift ?? false,
        altKey: alt ?? false,
        metaKey: meta ?? false,
        ctrlKey: ctrl ?? false,
    });
    results.push('key' in item ? { key: key.toUpperCase() } : item);
    return results;
};
/**
Bind a single keyboard shortcut to node.
*/
export const shortcut = (node, option) => {
    const { update: shortcutsUpdate, destroy } = shortcuts(node, [option]);
    return {
        update(newOption) {
            shortcutsUpdate?.([newOption]);
        },
        destroy,
    };
};
/**
Binds multiple keyboard shortcuts to node
*/
export const shortcuts = (node, options) => {
    function onKeydown(event) {
        if (event.defaultPrevented) {
            return;
        }
        const ignoreShortcut = shouldIgnoreEvent(event);
        for (const { shortcut, onShortcut, ignoreInputFields = true, preventDefault = true } of options) {
            if (ignoreInputFields && ignoreShortcut) {
                continue;
            }
            if (matchesShortcut(event, shortcut)) {
                if (preventDefault) {
                    event.preventDefault();
                }
                onShortcut(event);
                return;
            }
        }
    }
    const off = on(node, 'keydown', onKeydown);
    return {
        update(newOptions) {
            options = newOptions;
        },
        destroy() {
            off();
        },
    };
};
