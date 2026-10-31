<script lang="ts">
  // A modal holding private content in an iframe, mounted through the shared modal manager, for the
  // session-lock specs (the Locked lock must clear it). It stands in for the retired email template preview.
  import { Modal, ModalBody } from '@frameleaf/ui';

  interface Props {
    html: string;
    onClose: () => void;
  }

  let { html, onClose }: Props = $props();
</script>

<Modal title="Private preview" {onClose} size="giant">
  <ModalBody>
    <iframe title="Private preview" srcdoc={html}></iframe>
  </ModalBody>
</Modal>
