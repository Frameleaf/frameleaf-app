import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { DateTime } from 'luxon';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import StorageTemplateSettings from './StorageTemplateSettings.svelte';

const config = vi.hoisted(() => ({
  storageTemplate: { enabled: true, hashVerificationEnabled: false, template: '{{yyyy}}/{{filename}}' },
}));
vi.mock('$lib/managers/system-config-manager.svelte', () => ({
  systemConfigManager: { value: config, cloneValue: () => structuredClone(config) },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', () => ({ getSystemConfigDraft: () => undefined }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user: { id: 'fixture', storageLabel: 'photos' } },
}));
vi.mock('$lib/frameleaf/help-links.svelte', () => ({ helpLinks: { docs: () => undefined } }));

beforeEach(() => {
  vi.clearAllMocks();
  sdkMock.getStorageTemplateOptions.mockResolvedValue({
    yearOptions: ['yyyy'],
    monthOptions: ['MM'],
    weekOptions: [],
    dayOptions: [],
    hourOptions: [],
    minuteOptions: [],
    secondOptions: [],
    presetOptions: ['{{yyyy}}/{{filename}}', '{{MM}}/{{filename}}'],
  });
});
afterEach(() => vi.restoreAllMocks());

const mount = async () => {
  render(StorageTemplateSettings, { minified: true });
  await screen.findByText(/\/2022\/IMAGE_56437\.jpg/);
};

it('shares options between the preview, presets and supported-date panel', async () => {
  await mount();
  await screen.findByText('{{yyyy}} - 2022');
  expect(sdkMock.getStorageTemplateOptions).toHaveBeenCalledOnce();
});

it('reuses sample date substitutions when the template changes and keeps album dates', async () => {
  const format = vi.spyOn(DateTime.prototype, 'toFormat');
  await mount();
  format.mockClear();
  await fireEvent.input(screen.getByRole('textbox', { name: /^template$/i }), {
    target: { value: '{{album-startDate-yyyy}}/{{album-endDate-MM}}/{{filename}}' },
  });
  await screen.findByText(/\/2021\/05\/IMAGE_56437\.jpg/);
  expect(format).not.toHaveBeenCalled();
});

it('keeps invalid custom templates editable while displaying the existing error preview', async () => {
  await mount();
  const input = screen.getByRole('textbox', { name: /^template$/i });
  await fireEvent.input(input, { target: { value: '{{#if}}' } });
  await screen.findByText(/\/error\.jpg/);
  await waitFor(() => expect(input).toHaveValue('{{#if}}'));
});
