import React, { useState } from "react";
import { Button } from "./Controls";
import { Icon } from "./Icon";
import "./sharing.css";

export const PARTNER_LOCKED_NOTICE_KEY = "frameleaf:partner-locked-notice:v1";

const readDismissed = () => {
  try {
    return localStorage.getItem(PARTNER_LOCKED_NOTICE_KEY) === "dismissed";
  } catch {
    return false;
  }
};

/**
 * Partner sharing v2 (spec §4.9): Locked items a partner shares arrive as your own locked copies, which
 * only your PIN opens. Without a PIN they stay hidden, and this notice offers to set one, once.
 */
export function PartnerLockedNotice({ partnerName, hasPin, onSetPin }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  if (hasPin || dismissed) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(PARTNER_LOCKED_NOTICE_KEY, "dismissed");
    } catch {
      // the notice still hides for this session
    }
    setDismissed(true);
  };
  return (
    <section className="pl-notice" role="status" aria-label="Locked items from a partner">
      <Icon name="mdiLockOutline" size={18} />
      <p>
        <strong>{partnerName} shared Locked items with you.</strong>
        <span>They stay hidden until you set a PIN for your Locked folder.</span>
      </p>
      <Button primary onClick={() => onSetPin?.()}>
        Set a PIN
      </Button>
      <Button onClick={dismiss}>Not now</Button>
    </section>
  );
}
