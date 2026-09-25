import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import SettingToggle from './SettingToggle.svelte';

describe('SettingToggle component', () => {
  it('renders a switch named by the title and describes it with the subtitle', () => {
    render(SettingToggle, { props: { title: 'Trash', subtitle: 'Keep deleted items for a while', checked: true } });

    const toggle = screen.getByRole('switch', { name: 'Trash' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    const describedBy = toggle.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.querySelector(`#${CSS.escape(describedBy!)}`)?.textContent).toBe('Keep deleted items for a while');
  });

  it('reports the new state through onToggle and flips the checked state', async () => {
    const onToggle = vi.fn();
    render(SettingToggle, { props: { title: 'Trash', checked: false, onToggle } });
    const user = userEvent.setup();

    await user.click(screen.getByRole('switch', { name: 'Trash' }));

    expect(onToggle).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.getByRole('switch', { name: 'Trash' }).getAttribute('aria-checked')).toBe('true');
  });

  it('does not toggle while disabled', async () => {
    const onToggle = vi.fn();
    render(SettingToggle, { props: { title: 'Trash', checked: false, disabled: true, onToggle } });
    const user = userEvent.setup();

    await user.click(screen.getByRole('switch', { name: 'Trash' }));

    expect(onToggle).not.toHaveBeenCalled();
  });

  it('shows the unsaved marker in words, not colour alone', () => {
    render(SettingToggle, { props: { title: 'Trash', checked: true, isEdited: true } });
    expect(screen.getByText('unsaved_change')).toBeTruthy();
  });

  it('puts the switch after its label and help, in the right-hand control column', () => {
    const { container } = render(SettingToggle, { props: { title: 'Trash', subtitle: 'Keep deleted items' } });
    const field = container.querySelector('.field')!;
    expect(field.lastElementChild).toHaveClass('control');
    expect(field.lastElementChild!.querySelector('[role="switch"]')).not.toBeNull();
  });

  it('names the policy that locks a row (FL-71)', () => {
    render(SettingToggle, {
      props: { title: 'External telemetry', checked: false, disabled: true, policy: 'External telemetry prohibited' },
    });

    expect(screen.getByRole('switch', { name: 'External telemetry' })).toBeDisabled();
    expect(screen.getByText('External telemetry prohibited')).toBeInTheDocument();
  });
});
