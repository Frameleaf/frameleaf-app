import type { ServerBinding } from './api';
import { listMediaReceipts, mediaReceiptPending } from './media-queue';
import { listCaptures } from './queue';

const TITLE = 'Save to Frameleaf';
const BLUE = '#2563eb';
const AMBER = '#d97706';

/** FL-1729: the toolbar badge. Nothing shows while nothing waits; an item that needs you wins. */
export function badgeFor(waiting: number, attention: number) {
  if (attention > 0)
    return {
      text: '!',
      color: AMBER,
      title: `${TITLE} · ${attention} ${attention === 1 ? 'needs' : 'need'} you`,
    };
  if (waiting > 0)
    return {
      text: waiting > 99 ? '99+' : String(waiting),
      color: BLUE,
      title: `${TITLE} · ${waiting} waiting for your server`,
    };
  return { text: '', color: BLUE, title: TITLE };
}

/** Counts what this server and account still has waiting, from the save and media queues. */
export async function showBadge(binding: ServerBinding | null) {
  let waiting = 0;
  let attention = 0;
  if (binding) {
    for (const task of await listCaptures(binding)) {
      if (['queued', 'uploading', 'committing'].includes(task.state)) waiting++;
      else if (['needs-attention', 'failed'].includes(task.state)) attention++;
    }
    for (const receipt of await listMediaReceipts(binding).catch(() => [])) {
      if (mediaReceiptPending(receipt)) waiting++;
      else if (receipt.state === 'paused') attention++;
    }
  }
  const badge = badgeFor(waiting, attention);
  await Promise.all([
    chrome.action.setBadgeText({ text: badge.text }),
    chrome.action.setBadgeBackgroundColor({ color: badge.color }),
    chrome.action.setTitle({ title: badge.title }),
  ]);
}
