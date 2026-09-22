import React, { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon";
import {
  loadResourceState,
  subscribeResourceState,
} from "./account-library-data.mjs";
import {
  LOCKED_SESSION_MILLISECONDS,
  lockedAccessSnapshot,
  validSamplePin,
} from "./locked-content.mjs";
import "./locked-content.css";

/** Controlled, session-only sample challenge. Real integration must await the
 * server unlock endpoint, not replace it with validSamplePin. */
export function LockedControl({
  locked = true,
  requestKey = 0,
  onUnlock,
  onLock,
  onOpenLocked,
  onOpenSettings,
}) {
  const [resources, setResources] = useState(loadResourceState);
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [pinFocused, setPinFocused] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef(null);
  const priorFocus = useRef(null);
  const granted = useRef(null);
  const lastRequest = useRef(0);
  const callbacks = useRef({ onUnlock, onLock });
  callbacks.current = { onUnlock, onLock };
  const titleId = useId();
  const hintId = useId();
  const access = lockedAccessSnapshot(resources);
  const close = () => {
    setOpen(false);
    setPin("");
    setError("");
  };
  const hide = () => {
    granted.current = null;
    close();
    callbacks.current.onLock?.();
  };

  useEffect(() => subscribeResourceState(setResources), []);
  useEffect(() => {
    if (requestKey === lastRequest.current) return;
    lastRequest.current = requestKey;
    if (locked) {
      setResources(loadResourceState());
      setPin("");
      setError("");
      setOpen(true);
    }
  }, [requestKey, locked]);
  useEffect(() => {
    if (locked) {
      granted.current = null;
      return;
    }
    if (
      !access.available ||
      !access.pinEnabled ||
      granted.current !== access.token
    )
      hide();
  }, [locked, access.token, access.available, access.pinEnabled]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) hide();
    };
    const onStorage = (event) => {
      if (event.key === null) hide();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("storage", onStorage);
    const timer = !locked
      ? setTimeout(hide, LOCKED_SESSION_MILLISECONDS)
      : null;
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("storage", onStorage);
      clearTimeout(timer);
    };
  }, [locked]);
  useEffect(() => {
    if (!open) return;
    priorFocus.current = document.activeElement;
    dialog.current?.showModal();
    return () => {
      if (priorFocus.current?.isConnected) priorFocus.current.focus();
    };
  }, [open]);

  const unlock = (event) => {
    event.preventDefault();
    // Re-read just before admitting the challenge so a pending storage event
    // cannot authorize a cleared PIN, revoked session, or deleted account.
    const latest = lockedAccessSnapshot(loadResourceState());
    if (
      !latest.available ||
      !latest.pinEnabled ||
      latest.token !== access.token
    ) {
      setResources(loadResourceState());
      setPin("");
      setError(
        "Your account changed. Check your PIN settings before unlocking.",
      );
      return;
    }
    if (!validSamplePin(pin)) {
      setError("Enter six digits.");
      return;
    }
    granted.current = latest.token;
    setPin("");
    setOpen(false);
    setError("");
    callbacks.current.onUnlock?.();
  };

  return (
    <div className={`locked-control ${locked ? "is-locked" : "is-revealed"}`}>
      <button
        className="locked-toggle"
        type="button"
        aria-label={locked ? "Unlock Locked content" : "Hide Locked content"}
        title={locked ? "Unlock Locked content" : "Hide Locked content"}
        onClick={() => {
          if (locked) {
            setResources(loadResourceState());
            setPin("");
            setError("");
            setOpen(true);
          } else hide();
        }}
      >
        <Icon
          name={locked ? "mdiLockOutline" : "mdiLockOpenVariantOutline"}
          size={18}
        />
        <span>{locked ? "Locked" : "Revealed"}</span>
      </button>
      {!locked && (
        <button
          className="locked-open"
          type="button"
          aria-label="Open Locked"
          title="Open Locked"
          onClick={onOpenLocked}
        >
          <Icon name="mdiChevronRight" size={17} />
        </button>
      )}
      {open && (
        <dialog
          ref={dialog}
          className="locked-dialog"
          aria-labelledby={titleId}
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
        >
          <form onSubmit={unlock}>
            <header>
              <span className="locked-dialog-mark">
                <Icon name="mdiShieldLockOutline" size={26} />
              </span>
              <button
                className="locked-close"
                type="button"
                aria-label="Close Locked dialog"
                onClick={close}
              >
                <Icon name="mdiClose" size={20} />
              </button>
            </header>
            <h2 id={titleId}>Unlock Locked content</h2>
            {!access.available ? (
              <p>
                This session is no longer available. Return to account settings
                to continue.
              </p>
            ) : !access.pinEnabled ? (
              <p>
                Set up a six-digit PIN before revealing your Locked content.
              </p>
            ) : (
              <>
                <p>
                  Reveal photos hidden by your rules and open your Locked
                  collection.
                </p>
                <div
                  className={`pin-cells locked-pin-cells ${error ? "error" : ""} ${pinFocused ? "focused" : ""}`}
                >
                  {Array.from({ length: 6 }, (_, index) => (
                    <span
                      key={index}
                      aria-hidden="true"
                      className={`pin-cell ${index < pin.length ? "filled" : ""} ${
                        index === Math.min(pin.length, 5) ? "active" : ""
                      }`}
                    />
                  ))}
                  <input
                    className="pin-input"
                    type="password"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    maxLength={6}
                    pattern="[0-9]*"
                    value={pin}
                    aria-label="Six-digit PIN"
                    aria-describedby={hintId}
                    aria-invalid={error ? true : undefined}
                    onFocus={() => setPinFocused(true)}
                    onBlur={() => setPinFocused(false)}
                    onChange={(event) => {
                      setPin(event.target.value.replace(/\D/g, "").slice(0, 6));
                      setError("");
                    }}
                  />
                </div>
                <p className="locked-hint" id={hintId}>
                  Sample library: enter any six digits. Your PIN is not stored.
                </p>
                <p className="locked-hint">
                  Content hides when you leave this tab or after one hour.
                </p>
              </>
            )}
            {error && (
              <p role="alert" className="locked-error">
                {error}
              </p>
            )}
            <footer>
              <button
                type="button"
                className="locked-settings"
                onClick={() => {
                  close();
                  onOpenSettings?.();
                }}
              >
                PIN settings
              </button>
              <div>
                <button type="button" onClick={close}>
                  Cancel
                </button>
                {access.available && access.pinEnabled && (
                  <button
                    type="submit"
                    className="locked-primary"
                    disabled={!validSamplePin(pin)}
                  >
                    Unlock
                  </button>
                )}
              </div>
            </footer>
          </form>
        </dialog>
      )}
    </div>
  );
}
