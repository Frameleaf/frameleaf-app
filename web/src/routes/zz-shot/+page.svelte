<script lang="ts">
  // THROWAWAY (FL-1814 screenshot). Never commit.
  import DateField, { type DateFieldValue } from '$lib/components/frameleaf/DateField.svelte';
  let taken = $state<DateFieldValue>({ sure: 'day', year: 2026, month: 8, day: 15, time: '07:14' });
  let born = $state<DateFieldValue>({ sure: 'about', year: 1987, month: 3, day: 1 });
</script>

<div class="frameleaf" style="min-height: 100vh; padding: 32px; display: grid; gap: 40px; max-width: 520px">
  <DateField label="When was this taken?" withTime value={taken} onChange={(value) => (taken = value)} />
  <DateField label="Date of birth" value={born} onChange={(value) => (born = value)} />
</div>
