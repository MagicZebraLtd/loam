/**
 * Mounting helpers for the renderer's jsdom tests (no testing library: Preact's own `render` and `act`, as
 * apps/client's component tests do). Not part of the app; nothing outside the tests imports it.
 */
import { render, type VNode } from "preact";
import { act } from "preact/test-utils";

const mounted: HTMLElement[] = [];

/** Render `element` into a fresh container attached to the document. */
export function mount(element: VNode): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    render(element, container);
  });
  mounted.push(container);
  return container;
}

/** Unmount everything {@link mount} rendered (call from `afterEach`). */
export function unmountAll(): void {
  for (const container of mounted) {
    act(() => {
      render(null, container);
    });
    container.remove();
  }
  mounted.length = 0;
}

/** Let pending promises and zero-delay timers run, then flush Preact's updates. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Type into an input or select the way a person would (sets the value, fires input and change). */
export function typeInto(field: Element | null, value: string): void {
  if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) {
    throw new Error("not a form field");
  }
  act(() => {
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** Click an element inside `act`. */
export function click(element: Element | null | undefined): void {
  if (!(element instanceof HTMLElement)) {
    throw new Error("nothing to click");
  }
  act(() => {
    element.click();
  });
}

/** The first button whose text contains `text`. */
export function buttonWith(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.includes(text));
}
