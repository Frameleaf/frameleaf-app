import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import TestWrapper from '$lib/components/TestWrapper.svelte';
import Combobox from './Combobox.svelte';

const options = ['Alpha', 'Beta', 'Alpine'].map((label) => ({ label, value: label }));
let observer: ReturnType<typeof getIntersectionObserverMock>;
beforeEach(() => {
  observer = getIntersectionObserverMock();
  vi.stubGlobal('IntersectionObserver', observer);
  vi.stubGlobal('visualViewport', { height: 800, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps case-insensitive filtering, exact creation matching, selection and clearing', async () => {
  const onSelect = vi.fn();
  render(TestWrapper, {
    component: Combobox,
    componentProps: { label: 'Choice', options, allowCreate: true, defaultFirstOption: true, onSelect },
  });
  const input = screen.getByRole('combobox');
  await fireEvent.focus(input);
  await fireEvent.input(input, { target: { value: 'AL' } });
  expect(screen.getAllByRole('option').map((option) => option.textContent?.trim())).toEqual(['AL', 'Alpha', 'Alpine']);
  await fireEvent.input(input, { target: { value: 'Alpha' } });
  expect(screen.getAllByRole('option')).toHaveLength(1);
  await fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSelect).toHaveBeenLastCalledWith(options[0]);
  await fireEvent.click(screen.getByRole('button', { name: 'clear_value' }));
  expect(onSelect).toHaveBeenLastCalledWith(undefined);
});

it('keeps keyboard selection within a replacement options list', async () => {
  const onSelect = vi.fn();
  const props = { label: 'Choice', options, onSelect };
  const view = render(TestWrapper, { component: Combobox, componentProps: props });
  const input = screen.getByRole('combobox');
  await fireEvent.focus(input);
  await fireEvent.keyDown(input, { key: 'ArrowUp' });
  await waitFor(() => expect(screen.getByRole('option', { name: 'Alpine' })).toHaveAttribute('aria-selected', 'true'));
  await view.rerender({ componentProps: { ...props, options: [options[0]] } });
  await waitFor(() => expect(screen.getByRole('option', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true'));
  await fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(options[0]);
});

it('leaves an empty option list unselected', async () => {
  const onSelect = vi.fn();
  render(TestWrapper, { component: Combobox, componentProps: { label: 'Choice', options: [], onSelect } });
  const input = screen.getByRole('combobox');
  await fireEvent.focus(input);
  await fireEvent.keyDown(input, { key: 'ArrowDown' });
  await fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSelect).not.toHaveBeenCalled();
});

it('ignores an empty observer update and disconnects on teardown', () => {
  const view = render(TestWrapper, { component: Combobox, componentProps: { label: 'Choice', options } });
  const [callback] = observer.mock.calls[0] as unknown as [IntersectionObserverCallback];
  expect(() => callback([], {} as IntersectionObserver)).not.toThrow();
  view.unmount();
  expect(observer.mock.results[0].value.disconnect).toHaveBeenCalledOnce();
});
