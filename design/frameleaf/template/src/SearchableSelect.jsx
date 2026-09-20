import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

const searchText = (value) =>
  String(value).normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();

export function SearchableSelect({
  label,
  value,
  options,
  onChange,
  placeholder = "Any",
  disabled = false,
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const wrapper = useRef(null);
  const control = useRef(null);
  const trigger = useRef(null);
  const input = useRef(null);
  const popup = useRef(null);
  const restoreFocus = useRef(false);
  const tabTimer = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(null);
  const [position, setPosition] = useState(null);
  const [portalTarget, setPortalTarget] = useState(null);

  const choices = [
    ...new Map(options.map((option) => [option.value, option])).values(),
  ];
  if (!choices.some((option) => option.value === ""))
    choices.unshift({ value: "", label: placeholder });
  if (value && !choices.some((option) => option.value === value))
    choices.push({ value, label: value, count: 0 });
  const selected = choices.find((option) => option.value === value);
  const term = searchText(query.trim());
  const matches = choices.filter(
    (option) => option.value === "" || searchText(option.label).includes(term),
  );
  const enabled = matches.filter((option) => !option.disabled);
  const activeOption = enabled.find((option) => option.value === active);
  const optionId = (option) =>
    `${id}-option-${choices.findIndex((choice) => choice.value === option.value)}`;
  const noMatches = !!term && !matches.some((option) => option.value !== "");

  const close = (focus = false) => {
    clearTimeout(tabTimer.current);
    restoreFocus.current = focus;
    setOpen(false);
  };
  const show = (last = false) => {
    if (disabled) return;
    clearTimeout(tabTimer.current);
    setQuery("");
    const available = choices.filter((option) => !option.disabled);
    setActive(
      !selected?.disabled && selected
        ? selected.value
        : ((last ? available.at(-1)?.value : available[0]?.value) ?? null),
    );
    setPosition(null);
    setPortalTarget(
      wrapper.current?.closest(".frameleaf") || wrapper.current?.parentElement,
    );
    setOpen(true);
  };
  const choose = (option) => {
    if (disabled || option.disabled) return;
    onChange(option.value);
    close(true);
  };

  useLayoutEffect(() => {
    if (open) input.current?.focus({ preventScroll: true });
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus({ preventScroll: true });
    }
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const placePopup = () => {
      if (!control.current) return;
      const rect = control.current.getBoundingClientRect();
      let top = 8;
      let bottom = window.innerHeight - 8;
      for (
        let ancestor = wrapper.current?.parentElement;
        ancestor && ancestor !== document.body;
        ancestor = ancestor.parentElement
      ) {
        if (
          /(auto|scroll|hidden|clip)/.test(getComputedStyle(ancestor).overflowY)
        ) {
          const bounds = ancestor.getBoundingClientRect();
          top = Math.max(top, bounds.top + 4);
          bottom = Math.min(bottom, bounds.bottom - 4);
          break;
        }
      }
      if (rect.bottom <= top || rect.top >= bottom) {
        close();
        return;
      }
      const below = Math.max(0, bottom - rect.bottom - 4);
      const above = Math.max(0, rect.top - top - 4);
      const down =
        below >= Math.min(240, matches.length * 36 + 12) || below >= above;
      const width = Math.min(rect.width, window.innerWidth - 16);
      setPosition({
        position: "fixed",
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        width,
        ...(down
          ? { top: rect.bottom + 4 }
          : { bottom: window.innerHeight - rect.top + 4 }),
        maxHeight: Math.min(300, down ? below : above),
        overflowY: "auto",
      });
    };
    placePopup();
    window.addEventListener("resize", placePopup);
    window.addEventListener("scroll", placePopup, true);
    window.visualViewport?.addEventListener("resize", placePopup);
    return () => {
      window.removeEventListener("resize", placePopup);
      window.removeEventListener("scroll", placePopup, true);
      window.visualViewport?.removeEventListener("resize", placePopup);
    };
  }, [open, matches.length]);

  useEffect(() => {
    if (!open) return;
    const outside = (event) => {
      if (
        !wrapper.current?.contains(event.target) &&
        !popup.current?.contains(event.target)
      )
        close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (disabled) close();
  }, [disabled]);
  useEffect(() => () => clearTimeout(tabTimer.current), []);
  useEffect(() => {
    if (open && activeOption)
      document
        .getElementById(optionId(activeOption))
        ?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, query]);

  const onKeyDown = (event) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = enabled.findIndex((option) => option.value === active);
      const next =
        event.key === "ArrowDown"
          ? (index + 1) % enabled.length
          : index < 0
            ? enabled.length - 1
            : (index - 1 + enabled.length) % enabled.length;
      setActive(enabled[next]?.value ?? null);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeOption) choose(activeOption);
    } else if (event.key === "Tab") {
      // Leave focus movement to the browser; close after its default Tab action.
      tabTimer.current = setTimeout(() => close(), 0);
    }
  };

  const list = (
    <div
      className="searchable-select-popup"
      ref={popup}
      style={position || { position: "fixed", visibility: "hidden" }}
    >
      <ul id={listId} role="listbox" aria-labelledby={labelId}>
        {matches.map((option) => (
          <li
            key={option.value}
            id={optionId(option)}
            role="option"
            aria-selected={option.value === value}
            aria-disabled={option.disabled || undefined}
            className={`searchable-select-option${activeOption?.value === option.value ? " is-active" : ""}${option.value === value ? " is-selected" : ""}`}
            onMouseDown={(event) => event.preventDefault()}
            onPointerMove={() => {
              if (!option.disabled) setActive(option.value);
            }}
            onClick={() => choose(option)}
          >
            <span>{option.label}</span>
            {option.count !== undefined && <small>{option.count}</small>}
          </li>
        ))}
      </ul>
      {noMatches && (
        <p className="searchable-select-empty" role="status">
          No matching options
        </p>
      )}
    </div>
  );

  return (
    <div className="searchable-select" ref={wrapper}>
      <label
        className="searchable-select-label"
        id={labelId}
        htmlFor={open ? inputId : `${id}-trigger`}
      >
        {label}
      </label>
      <div ref={control}>
        {open ? (
          <div className="searchable-select-control">
            <input
              ref={input}
              id={inputId}
              role="combobox"
              aria-labelledby={labelId}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={
                activeOption ? optionId(activeOption) : undefined
              }
              autoComplete="off"
              placeholder={`Search ${label.toLocaleLowerCase()}…`}
              value={query}
              onKeyDown={onKeyDown}
              onChange={(event) => {
                const next = event.target.value;
                setQuery(next);
                const nextTerm = searchText(next.trim());
                const nextActive = choices.find(
                  (option) =>
                    !option.disabled &&
                    (!nextTerm || option.value !== "") &&
                    searchText(option.label).includes(nextTerm),
                );
                setActive(nextActive?.value ?? null);
              }}
              onBlur={(event) => {
                if (
                  !wrapper.current?.contains(event.relatedTarget) &&
                  !popup.current?.contains(event.relatedTarget)
                )
                  close();
              }}
            />
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Close ${label.toLocaleLowerCase()} options`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => close(true)}
            >
              <Icon name="mdiChevronDown" size={16} />
            </button>
          </div>
        ) : (
          <button
            ref={trigger}
            id={`${id}-trigger`}
            type="button"
            role="combobox"
            className="searchable-select-control"
            aria-labelledby={labelId}
            aria-expanded="false"
            aria-haspopup="listbox"
            disabled={disabled}
            onClick={() => show()}
            onKeyDown={(event) => {
              if (["ArrowDown", "ArrowUp"].includes(event.key)) {
                event.preventDefault();
                show(event.key === "ArrowUp");
              }
            }}
          >
            <span>{selected?.label || placeholder}</span>
            <Icon name="mdiChevronDown" size={16} />
          </button>
        )}
      </div>
      {open && (portalTarget ? createPortal(list, portalTarget) : list)}
    </div>
  );
}
