import { useEffect, useRef, useState } from "preact/hooks";

import { t } from "../lib/strings";

/** How long the button must be held (the Android control's feel, a little quicker on a desk). */
export const HOLD_MS = 1_500;

/**
 * A button that acts only after being held down for `holdMs` (apps/app/src/components/hold-to-confirm.tsx):
 * a bar sweeps along its bottom edge while it is held, and letting go early cancels. Hard to trigger by
 * accident, quick to use on purpose.
 *
 * Keyboard: holding Space or Enter works the same way. A screen reader activates a button with a click and
 * can't hold it, so a click that didn't come from a pointer (`detail === 0`) opens a plain Confirm step
 * beside it instead: still two deliberate actions, never one.
 */
export function HoldToConfirm({
  disabled = false,
  holdMs = HOLD_MS,
  label,
  onConfirm,
  tone = "danger",
}: {
  disabled?: boolean;
  holdMs?: number;
  label: string;
  onConfirm: () => void;
  /** `danger` for erasing; `neutral` for actions that only need a deliberate hand. */
  tone?: "danger" | "neutral";
}) {
  const [holding, setHolding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // Read inside the timer, so a re-render with a new callback while held still calls the latest one.
  const confirm = useRef(onConfirm);
  confirm.current = onConfirm;

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (disabled) {
      cancel();
      setConfirming(false);
    }
  }, [disabled]);

  function start(): void {
    if (disabled || timer.current !== undefined) {
      return;
    }
    setHolding(true);
    setConfirming(false);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setHolding(false);
      confirm.current();
    }, holdMs);
  }

  function cancel(): void {
    clearTimeout(timer.current);
    timer.current = undefined;
    setHolding(false);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === " " || event.key === "Enter") {
      // No click from the key: the hold decides.
      event.preventDefault();
      if (!event.repeat) {
        start();
      }
    } else if (event.key === "Escape") {
      cancel();
    }
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      cancel();
    }
  }

  function onClick(event: MouseEvent): void {
    // A pointer press is handled by the hold; a click with no pointer behind it is assistive technology.
    if (event.detail === 0 && !disabled) {
      setConfirming(true);
    }
  }

  return (
    <div className="hold">
      <button
        className={`btn btn-block hold-button hold-${tone}${holding ? " is-holding" : ""}`}
        disabled={disabled}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPointerCancel={cancel}
        onPointerDown={(event) => {
          if (event.button === 0) {
            start();
          }
        }}
        onPointerLeave={cancel}
        onPointerUp={cancel}
        style={{ "--hold-ms": `${holdMs}ms` }}
        type="button"
      >
        <span className="hold-fill" aria-hidden="true" />
        <span className="hold-label">{holding ? t("hold.holding") : label}</span>
      </button>
      {confirming ? (
        <div className="hold-fallback" role="group" aria-label={label}>
          <button
            className={`btn btn-sm ${tone === "danger" ? "btn-danger" : "btn-primary"}`}
            onClick={() => {
              setConfirming(false);
              onConfirm();
            }}
            type="button"
          >
            {t("hold.confirm")}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setConfirming(false)} type="button">
            {t("common.cancel")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
