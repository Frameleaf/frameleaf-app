<script lang="ts">
  /** FL-655: "Signed in as Taylor", with the account's initial in place of a picture. */
  let { name, detail }: { name?: string; detail: string } = $props();
  const initial = $derived((name?.trim()[0] ?? "?").toUpperCase());
</script>

<div class="account">
  <span class="account-mark" aria-hidden="true">{initial}</span>
  <span class="account-text">
    <strong>{name ? `Signed in as ${name}` : "Signed in"}</strong>
    <small>{detail}</small>
  </span>
</div>
