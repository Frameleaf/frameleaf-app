import { render } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { SettingInputFieldType } from '$lib/constants';
import SettingField from './SettingField.svelte';

describe('SettingField component', () => {
  it('clamps a number to its bounds on blur', async () => {
    const { getByRole } = render(SettingField, {
      props: {
        label: 'test-number-input',
        inputType: SettingInputFieldType.NUMBER,
        value: 0,
        min: 0,
        max: 100,
        step: '0.1',
      },
    });
    const user = userEvent.setup();

    const numberInput = getByRole('spinbutton') as HTMLInputElement;
    expect(numberInput.value).toEqual('0');

    await user.click(numberInput);
    await user.keyboard('100.1');
    expect(numberInput.value).toEqual('100.1');

    await user.click(document.body);
    expect(numberInput.value).toEqual('100');
  });

  it('allows emptying number inputs while editing', async () => {
    const { getByRole } = render(SettingField, {
      props: {
        label: 'test-number-input',
        inputType: SettingInputFieldType.NUMBER,
        value: 5,
      },
    });
    const user = userEvent.setup();

    const numberInput = getByRole('spinbutton') as HTMLInputElement;
    await user.click(numberInput);
    await user.keyboard('{Backspace}');
    expect(numberInput.value).toEqual('');
  });

  it('labels the control and its help text', () => {
    const { getByLabelText } = render(SettingField, {
      props: {
        label: 'External domain',
        description: 'Used in links sent by email',
        inputType: SettingInputFieldType.TEXT,
        value: 'https://photos.example',
      },
    });

    const input = getByLabelText('External domain') as HTMLInputElement;
    expect(input.value).toBe('https://photos.example');
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.querySelector(`#${CSS.escape(input.getAttribute('aria-describedby')!)}`)?.textContent).toContain(
      'Used in links sent by email',
    );
  });

  it('marks an unsaved change in words', () => {
    const { getByText } = render(SettingField, {
      props: { label: 'Welcome message', inputType: SettingInputFieldType.TEXT, value: 'Hi', isEdited: true },
    });

    expect(getByText('unsaved_change')).toBeTruthy();
  });

  it('is one compact row: label and help first, then the control column (Sept 24 settings)', () => {
    const { container } = render(SettingField, {
      props: {
        label: 'Keep for',
        description: 'Days before removal',
        inputType: SettingInputFieldType.NUMBER,
        value: 30,
        isEdited: true,
      },
    });
    const field = container.querySelector('.field')!;
    expect([...field.children].map((child) => child.className.split(' ', 1)[0])).toEqual(['copy', 'control']);
    expect(field.querySelector('.control')).toHaveClass('number');
    expect(field).toHaveClass('edited');
  });
});
