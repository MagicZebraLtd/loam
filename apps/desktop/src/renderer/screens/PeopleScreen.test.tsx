import { afterEach, describe, expect, it } from "vitest";

import { createFakeBridge, sampleNode, sampleState } from "../lib/fake-bridge";
import { buttonWith, click, mount, settle, unmountAll } from "../test-support/mount";
import { PeopleScreen } from "./PeopleScreen";

afterEach(unmountAll);

describe("PeopleScreen", () => {
  it("lists people with their state, and Make admin only where it applies", async () => {
    const state = sampleState({ phase: "running", node: sampleNode() });
    const root = mount(<PeopleScreen bridge={createFakeBridge({ state })} state={state} />);
    await settle();
    const rows = Array.from(root.querySelectorAll(".person"));
    expect(rows).toHaveLength(4);
    const [admin, sam, waiting, banned] = rows;
    expect(admin!.textContent).toContain("Admin");
    expect(buttonWith(admin!, "Make admin")).toBeUndefined();
    expect(buttonWith(sam!, "Make admin")).toBeTruthy();
    expect(sam!.textContent).toContain("Same name as someone else");
    expect(waiting!.textContent).toContain("Waiting");
    expect(banned!.textContent).toContain("Banned");
    expect(buttonWith(banned!, "Make admin")).toBeUndefined();
  });

  it("confirms first, then makes the person an admin", async () => {
    const state = sampleState({ phase: "running", node: sampleNode() });
    const bridge = createFakeBridge({ state });
    const root = mount(<PeopleScreen bridge={bridge} state={state} />);
    await settle();
    const waiting = root.querySelectorAll(".person")[2]!;
    click(buttonWith(waiting, "Make admin"));
    expect(waiting.textContent).toContain("Make sam an admin?");
    expect(waiting.textContent).toContain("waiting for approval");
    expect(waiting.textContent).toContain("Someone else uses this name too");
    expect(bridge.calls).not.toContain("host.makeAdmin");
    click(waiting.querySelector(".confirm .btn-danger"));
    await settle();
    expect(bridge.calls).toContain("host.makeAdmin");
    expect(waiting.textContent).toContain("sam is now an admin.");
    expect(waiting.textContent).toContain("Admin");
  });

  it("shows a refusal on the row", async () => {
    const state = sampleState({ phase: "running", node: sampleNode() });
    const bridge = createFakeBridge({ state });
    bridge.host.makeAdmin = async () => ({ ok: false, error: "A reset is running" });
    const root = mount(<PeopleScreen bridge={bridge} state={state} />);
    await settle();
    const sam = root.querySelectorAll(".person")[1]!;
    click(buttonWith(sam, "Make admin"));
    click(sam.querySelector(".confirm .btn-danger"));
    await settle();
    expect(sam.querySelector('[role="alert"]')?.textContent).toBe("A reset is running");
  });

  it("says to start the network when it isn't running", () => {
    const state = sampleState({ phase: "stopped" });
    const root = mount(<PeopleScreen bridge={createFakeBridge({ state })} state={state} />);
    expect(root.textContent).toContain("Start the network to see who has joined.");
  });
});
