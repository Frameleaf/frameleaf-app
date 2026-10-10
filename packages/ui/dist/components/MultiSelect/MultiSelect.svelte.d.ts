import type { MultiSelectProps } from '../../types.js';
declare function $$render<T extends string>(): {
    props: MultiSelectProps<T>;
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
declare const MultiSelect: $$IsomorphicComponent;
type MultiSelect<T extends string> = InstanceType<typeof MultiSelect<T>>;
export default MultiSelect;
