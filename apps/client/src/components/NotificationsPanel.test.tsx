import type { VNode } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ALERT_STORAGE_KEY } from "../lib/alerts";
import { NotificationsPanel } from "./NotificationsPanel";

const mounted: HTMLDivElement[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(element, container);
  mounted.push(container);
  return container;
}

function radios(host: HTMLElement): HTMLInputElement[] {
  return [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
}

function switches(host: HTMLElement): HTMLInputElement[] {
  return [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
}

function saved(): unknown {
  return JSON.parse(localStorage.getItem(ALERT_STORAGE_KEY) ?? "null");
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
  delete (window as { ReactNativeWebView?: unknown }).ReactNativeWebView;
});

describe("NotificationsPanel", () => {
  it("starts on direct messages with sound and vibration on", () => {
    const host = mount(<NotificationsPanel />);
    expect(radios(host).map((radio) => radio.value)).toEqual(["dms", "all", "off"]);
    expect(radios(host).find((radio) => radio.checked)?.value).toBe("dms");
    expect(switches(host).map((toggle) => toggle.checked)).toEqual([true, true]);
  });

  it("saves a new level and switches, and turning alerts off disables the rest", () => {
    const host = mount(<NotificationsPanel />);

    act(() => {
      radios(host)[1].checked = true;
      radios(host)[1].dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(saved()).toEqual({ level: "all", sound: true, vibrate: true });

    act(() => {
      switches(host)[0].checked = false;
      switches(host)[0].dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(saved()).toEqual({ level: "all", sound: false, vibrate: true });

    act(() => {
      radios(host)[2].checked = true;
      radios(host)[2].dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(switches(host).every((toggle) => toggle.disabled)).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  });

  it("explains the Android notification in the host app", () => {
    const browser = mount(<NotificationsPanel />);
    expect(browser.textContent).toContain("only works while LOAM is open");

    (window as { ReactNativeWebView?: unknown }).ReactNativeWebView = { postMessage: () => undefined };
    const app = mount(<NotificationsPanel />);
    expect(app.textContent).toContain("Android notification");
  });
});
