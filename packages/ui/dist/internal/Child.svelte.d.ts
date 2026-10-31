import { ChildKey } from '../constants.js';
import type { ChildData } from '../types.js';
type Props = {
    for: ChildKey;
    as: ChildKey;
} & ChildData;
declare const Child: import("svelte").Component<Props, {}, "">;
type Child = ReturnType<typeof Child>;
export default Child;
