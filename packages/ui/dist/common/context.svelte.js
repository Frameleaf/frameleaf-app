import { withPrefix } from '../utilities/internal.js';
import { getContext, setContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
const fieldKey = Symbol(withPrefix('field'));
export const setFieldContext = (context) => setContext(fieldKey, context);
export const getFieldContext = () => {
  return () => {
    const context = getContext(fieldKey);
    const {
      label,
      color = 'secondary',
      invalid = false,
      readOnly = false,
      required = false,
      disabled = false,
      description,
      ...restProps
    } = context?.() || {};
    return { label, description, color, invalid, readOnly, required, disabled, ...restProps };
  };
};
const tableKey = Symbol(withPrefix('table'));
export const setTableContext = (context) => setContext(tableKey, context);
export const getTableContext = () => {
  return () => {
    const context = getContext(tableKey);
    const { spacing = 'medium', size = 'medium', striped = false } = context?.() || {};
    return { spacing, size, striped };
  };
};
export const setChildContext = (key) => {
  const map = new SvelteMap();
  const context = {
    register: (child, data) => {
      const registration = { data };
      map.set(child, registration);
      return () => {
        if (map.get(child) === registration) map.delete(child);
      };
    },
  };
  setContext(withPrefix(key), () => context);
  return {
    getByKey: (key) => {
      const data = map.get(key)?.data;
      return data?.();
    },
  };
};
const noop = () => {};
const emptyChildContext = { register: () => noop };
export const getChildContext = (key) => {
  const contextKey = withPrefix(key);
  return () => {
    const context = getContext(contextKey);
    if (!context) {
      console.log(`Unable to find child context for key: ${key}`);
    }
    const { register } = context?.() ?? emptyChildContext;
    return { register };
  };
};
