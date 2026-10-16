import { afterEach, describe, expect, it } from "vitest";

import { DESKTOP_ERROR_CODES, type DesktopState } from "../../shared/ipc";
import { ERROR_COPY } from "../lib/errors";
import { createFakeBridge, sampleState } from "../lib/fake-bridge";
import { t } from "../lib/strings";
import { buttonWith, click, mount, settle, unmountAll } from "../test-support/mount";
import { FailedScreen } from "./FailedScreen";

afterEach(unmountAll);

describe("FailedScreen", () => {
  it.each(DESKTOP_ERROR_CODES)("explains %s in plain words with a way forward", (code) => {
    const state = sampleState({ phase: "failed", error: { code, detail: "raw detail" } }) as Extract<DesktopState, { phase: "failed" }>;
    const root = mount(<FailedScreen bridge={createFakeBridge({ state })} state={state} />);
    expect(root.querySelector("h1")?.textContent).toBe(t(ERROR_COPY[code].title));
    expect(root.textContent).toContain(t(ERROR_COPY[code].body));
    expect(buttonWith(root, "Try again")).toBeTruthy();
    expect(Boolean(buttonWith(root, "Hold to erase and start over"))).toBe(ERROR_COPY[code].newNetwork);
    expect(root.querySelector("details")?.textContent).toContain("raw detail");
  });

  it("retries by starting the network", async () => {
    const state = sampleState({ phase: "failed", error: { code: "port_in_use" } }) as Extract<DesktopState, { phase: "failed" }>;
    const bridge = createFakeBridge({ state });
    const root = mount(<FailedScreen bridge={bridge} state={state} />);
    expect(root.querySelector("details")).toBeNull();
    click(buttonWith(root, "Try again"));
    await settle();
    expect(bridge.calls).toContain("start");
  });

  it("opens the download page for a broken install", () => {
    const state = sampleState({ phase: "failed", error: { code: "client_missing" } }) as Extract<DesktopState, { phase: "failed" }>;
    const bridge = createFakeBridge({ state });
    const root = mount(<FailedScreen bridge={bridge} state={state} />);
    click(buttonWith(root, "Open the download page"));
    expect(bridge.opened).toEqual(["https://github.com/MagicZebraLtd/loam/releases/latest"]);
  });
});
