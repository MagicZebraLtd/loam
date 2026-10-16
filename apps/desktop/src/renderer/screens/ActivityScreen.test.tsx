import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { createFakeBridge, sampleLog } from "../lib/fake-bridge";
import { buttonWith, click, mount, settle, unmountAll } from "../test-support/mount";
import { ActivityScreen } from "./ActivityScreen";

afterEach(unmountAll);

describe("ActivityScreen", () => {
  it("shows the log so far and every new entry", async () => {
    const bridge = createFakeBridge({ log: sampleLog() });
    const root = mount(<ActivityScreen bridge={bridge} />);
    await settle();
    const lines = () => Array.from(root.querySelectorAll(".log-line")).map((line) => line.querySelector(".log-text")?.textContent);
    expect(lines()).toContain("GET /api/bootstrap → 200 3.2 ms");
    expect(lines()).toContain("A sync peer didn't answer");
    act(() => {
      bridge.emitLog({ kind: "message", time: Date.now(), level: "error", text: "Something broke" });
    });
    expect(lines().at(-1)).toBe("Something broke");
    expect(root.querySelector(".log-line:last-child")?.classList.contains("log-error")).toBe(true);
  });

  it("drops everything when the main process forgets the log", async () => {
    const bridge = createFakeBridge({ log: sampleLog() });
    const root = mount(<ActivityScreen bridge={bridge} />);
    await settle();
    expect(root.querySelectorAll(".log-line").length).toBeGreaterThan(0);
    act(() => {
      bridge.clearLog();
    });
    expect(root.querySelectorAll(".log-line")).toHaveLength(0);
    act(() => {
      bridge.emitLog({ kind: "message", time: Date.now(), level: "warn", text: "After the reset" });
    });
    expect(Array.from(root.querySelectorAll(".log-text")).map((line) => line.textContent)).toEqual(["After the reset"]);
  });

  it("filters to problems only", async () => {
    const bridge = createFakeBridge({ log: sampleLog() });
    const root = mount(<ActivityScreen bridge={bridge} />);
    await settle();
    click(root.querySelector('input[type="checkbox"]'));
    const texts = Array.from(root.querySelectorAll(".log-text")).map((line) => line.textContent);
    expect(texts).toEqual(["GET /api/missing → 404 1.1 ms", "A sync peer didn't answer"]);
  });

  it("copies what is shown", async () => {
    const bridge = createFakeBridge({ log: sampleLog() });
    const root = mount(<ActivityScreen bridge={bridge} />);
    await settle();
    click(buttonWith(root, "Copy"));
    await settle();
    expect(bridge.copied?.split("\n")).toHaveLength(5);
    expect(bridge.copied).toContain("POST /api/transport/tunnel → 200 14 ms");
    expect(root.textContent).toContain("Copied 5 lines");
  });

  it("says when there is nothing yet", async () => {
    const root = mount(<ActivityScreen bridge={createFakeBridge()} />);
    await settle();
    expect(root.textContent).toContain("Nothing yet.");
  });
});
