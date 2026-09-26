import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import AlbumInlineEdit from './AlbumInlineEdit.svelte';

describe('AlbumInlineEdit', () => {
  const open = async (label = 'Edit title') => {
    await fireEvent.click(screen.getByRole('button', { name: label }));
    return screen.getByLabelText<HTMLInputElement>(label);
  };

  it('offers no editing control when the viewer may not edit', () => {
    render(AlbumInlineEdit, { value: 'Iceland', label: 'Edit title', editable: false, onSave: vi.fn() });

    expect(screen.queryByRole('button', { name: 'Edit title' })).toBeNull();
    expect(screen.getByText('Iceland')).toBeTruthy();
  });

  it('saves the trimmed value on Enter', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(AlbumInlineEdit, { value: 'Iceland', label: 'Edit title', onSave });

    const field = await open();
    await fireEvent.input(field, { target: { value: '  Iceland 2026  ' } });
    await fireEvent.keyDown(field, { key: 'Enter' });

    expect(onSave).toHaveBeenCalledExactlyOnceWith('Iceland 2026');
  });

  it('does not write when the value is unchanged', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(AlbumInlineEdit, { value: 'Iceland', label: 'Edit title', onSave });

    const field = await open();
    await fireEvent.keyDown(field, { key: 'Enter' });

    expect(onSave).not.toHaveBeenCalled();
  });

  it('abandons the edit on Escape and restores the stored value', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(AlbumInlineEdit, { value: 'Iceland', label: 'Edit title', onSave });

    const field = await open();
    await fireEvent.input(field, { target: { value: 'Something else' } });
    await fireEvent.keyDown(field, { key: 'Escape' });
    await fireEvent.blur(field);

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Edit title' }).textContent).toContain('Iceland');
  });

  it('refuses to empty a single-line value', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(AlbumInlineEdit, { value: 'Iceland', label: 'Edit title', onSave });

    const field = await open();
    await fireEvent.input(field, { target: { value: ' '.repeat(3) } });
    await fireEvent.blur(field);

    expect(onSave).not.toHaveBeenCalled();
  });

  it('lets a multiline value be cleared', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(AlbumInlineEdit, {
      value: 'A trip',
      label: 'Edit description',
      multiline: true,
      as: 'p' as const,
      onSave,
    });

    const field = await open('Edit description');
    await fireEvent.input(field, { target: { value: '' } });
    await fireEvent.blur(field);

    expect(onSave).toHaveBeenCalledExactlyOnceWith('');
  });

  it('keeps the field open with the typed text when the write is refused', async () => {
    const onSave = vi.fn().mockResolvedValue(false);
    render(AlbumInlineEdit, { value: 'Iceland', label: 'Edit title', onSave });

    const field = await open();
    await fireEvent.input(field, { target: { value: 'Iceland 2026' } });
    await fireEvent.keyDown(field, { key: 'Enter' });

    expect(onSave).toHaveBeenCalledOnce();
    expect(screen.getByLabelText<HTMLInputElement>('Edit title').value).toBe('Iceland 2026');
  });
});
