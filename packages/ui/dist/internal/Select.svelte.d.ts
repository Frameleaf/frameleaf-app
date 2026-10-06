import type { SelectCommonProps, SelectOption } from '../types.js';
import { Select } from 'bits-ui';
declare function $$render<T extends string>(): {
    props: {
        multiple?: boolean;
        values: T[];
        asLabel?: (items: SelectOption<T>[]) => string;
        onChange?: (values: T[]) => void;
        onSelect?: (items: SelectOption<T>[]) => void;
    } & SelectCommonProps<T>;
    exports: {};
    bindings: "values";
    slots: {};
    events: {};
};
declare class __sveltets_Render<T extends string> {
    props(): ReturnType<typeof $$render<T>>['props'];
    events(): ReturnType<typeof $$render<T>>['events'];
    slots(): ReturnType<typeof $$render<T>>['slots'];
    bindings(): "values";
    exports(): {};
}
interface $$IsomorphicComponent {
    new <T extends string>(options: import('svelte').ComponentConstructorOptions<ReturnType<__sveltets_Render<T>['props']>>): import('svelte').SvelteComponent<ReturnType<__sveltets_Render<T>['props']>, ReturnType<__sveltets_Render<T>['events']>, ReturnType<__sveltets_Render<T>['slots']>> & {
        $$bindings?: ReturnType<__sveltets_Render<T>['bindings']>;
    } & ReturnType<__sveltets_Render<T>['exports']>;
    <T extends string>(internal: unknown, props: ReturnType<__sveltets_Render<T>['props']> & {}): ReturnType<__sveltets_Render<T>['exports']>;
    z_$$bindings?: ReturnType<__sveltets_Render<any>['bindings']>;
}
declare const Select: $$IsomorphicComponent;
type Select<T extends string> = InstanceType<typeof Select<T>>;
export default Select;
