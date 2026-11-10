import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../../../i18n/en.json';
import Switch from './Switch.svelte';

describe('kit Switch', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  it('says On or Off and reports the change', async () => {
    const onChange = vi.fn();
    render(Switch, { label: 'Ask phones for missing photos', checked: true, onChange });

    const control = screen.getByRole('switch', { name: 'Ask phones for missing photos' });
    expect(control).toHaveTextContent('On');
    await fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('says "Always" for a promise: on, and never changed (FL-1338, settings-v2 kit Switch `disabled`)', () => {
    render(Switch, { label: 'Look for missing files', checked: false, always: true });

    const control = screen.getByRole('switch', { name: 'Look for missing files' });
    expect(control).toHaveTextContent('Always');
    expect(control).toHaveAttribute('aria-checked', 'true');
    expect(control).toBeDisabled();
  });
});
