import { screen } from '@testing-library/svelte';
import { renderWithTooltips } from '$tests/helpers';
import EmailTemplatePreviewModal from './EmailTemplatePreviewModal.svelte';

it('renders the email HTML in an isolated sandbox', () => {
  const html = '<h1>Email preview</h1><script>parent.document.body.textContent = "changed"</script>';
  renderWithTooltips(EmailTemplatePreviewModal, { html, onClose: vi.fn() });
  const frame = screen.getByTitle('admin.template_email_preview');
  expect(frame).toHaveAttribute('srcdoc', html);
  expect(frame).toHaveAttribute('sandbox', '');
});
