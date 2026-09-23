import React, { useEffect, useId, useRef } from "react";
import { Icon } from "./Icon";

export function Button({
  children,
  icon,
  primary,
  active,
  className = "",
  ...props
}) {
  return (
    <button
      type="button"
      className={`button ${primary ? "primary" : ""} ${active ? "active" : ""} ${className}`}
      {...props}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}
export function Dialog({ title, close, children, wide, actions }) {
  const ref = useRef(null);
  const mounted = useRef(false);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    mounted.current = true;
    dialog?.showModal();
    dialog?.querySelector("[data-initial-focus]")?.focus();
    return () => {
      mounted.current = false;
      if (dialog?.open) dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`dialog ${wide ? "wide" : ""} ${actions ? "with-actions" : ""}`}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClose={() => {
        if (mounted.current && !ref.current?.open) close();
      }}
    >
      <div className="dialog-title">
        <h2 id={titleId}>{title}</h2>
        <Button aria-label="Close dialog" icon="mdiClose" onClick={close} />
      </div>
      {actions ? <div className="dialog-body">{children}</div> : children}
      {actions && <div className="dialog-actions">{actions}</div>}
    </dialog>
  );
}
