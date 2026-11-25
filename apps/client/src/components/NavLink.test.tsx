import type { VNode } from "preact";
import { render } from "preact";
import { LocationProvider } from "../lib/location";
import { afterEach, describe, expect, it } from "vitest";

import { NavLink } from "./NavLink";

// Rendered-component tests: mount real Preact components into jsdom and assert on the resulting DOM.
// NavLink reads lib/location's context, so mounts are wrapped in a LocationProvider.

const mounted: HTMLDivElement[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(<LocationProvider>{element}</LocationProvider>, container);
  mounted.push(container);
  return container;
}

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
});

describe("NavLink", () => {
  it("renders an anchor with its href and children", () => {
    const host = mount(
      <NavLink active={false} href="/settings">
        Settings
      </NavLink>,
    );

    const anchor = host.querySelector("a") as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe("#/settings");
    expect(anchor.textContent).toBe("Settings");
  });

  it("points its href at the fragment, and a click routes in the page with the path left at /", () => {
    window.history.replaceState(null, "", "/#/channels");
    try {
      const host = mount(
        <NavLink active={false} href="/dm/user.peer">
          Peer
        </NavLink>,
      );

      const anchor = host.querySelector("a") as HTMLAnchorElement;
      expect(anchor.getAttribute("href")?.startsWith("#/")).toBe(true);
      anchor.click();
      expect(window.location.pathname).toBe("/");
      expect(window.location.hash).toBe("#/dm/user.peer");
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("leaves a modifier or non-primary click to the browser, so it can open a new tab or window", () => {
    window.history.replaceState(null, "", "/#/channels");
    try {
      const host = mount(
        <NavLink active={false} href="/dm/user.peer">
          Peer
        </NavLink>,
      );
      const anchor = host.querySelector("a") as HTMLAnchorElement;
      for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
        anchor.dispatchEvent(event);
        expect(event.defaultPrevented, JSON.stringify(init)).toBe(false);
      }
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("marks itself as the current page and gets the active class when active", () => {
    const host = mount(
      <NavLink active href="/channel/general">
        General
      </NavLink>,
    );

    const anchor = host.querySelector("a") as HTMLAnchorElement;
    expect(anchor.getAttribute("aria-current")).toBe("page");
    expect(anchor.className).toContain("active");
  });

  it("omits aria-current when inactive and honours a className override", () => {
    const host = mount(
      <NavLink active={false} className="mobile-back" href="/channels">
        Back
      </NavLink>,
    );

    const anchor = host.querySelector("a") as HTMLAnchorElement;
    expect(anchor.getAttribute("aria-current")).toBeNull();
    expect(anchor.className).toBe("mobile-back");
  });
});
