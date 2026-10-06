import type { Shape, Size } from '../types.js';
import type { DateValue } from '@internationalized/date';
import { DatePicker } from 'bits-ui';
type Props = {
    onChange?: (date?: DateValue) => void;
    minDate?: DateValue;
    maxDate?: DateValue;
    date?: DateValue;
    class?: string;
    shape?: Shape;
    size?: Size;
};
declare const DatePicker: import("svelte").Component<Props, {}, "date">;
type DatePicker = ReturnType<typeof DatePicker>;
export default DatePicker;
