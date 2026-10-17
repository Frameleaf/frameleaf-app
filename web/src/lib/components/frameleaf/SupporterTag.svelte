<script lang="ts">
  import { t } from 'svelte-i18n';

  /**
   * The small "Supporter" tag beside a person who supports Frameleaf (owner decision, supporter
   * acknowledgement option b): in shared-album and shared-space member lists. The server says who:
   * everyone while it holds a Server licence, otherwise whoever holds their own Individual licence.
   * Styled as the prototype's header badge (collections.css `.ch-badge`).
   */
</script>

<span class="supporter-tag">{$t('supporter')}</span>

<style>
  .supporter-tag {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    min-height: 20px;
    padding: 0 var(--fl-space-2);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
  }
</style>
