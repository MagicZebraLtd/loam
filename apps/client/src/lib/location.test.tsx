import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocationProvider, useLocation, type Location } from "./location";

// The route lives in the address's fragment, which a browser never sends: a reload or a restored tab asks the
// node for `/` only, so no conversation id crosses the wire in clear.

const mounted: HTMLDivElement[] = [];
/** The location the probe saw on its latest render. */
let seen: Location | undefined;

/** Records what `useLocation` returns, so a test can read it and call `route`. */
function Probe() {
  seen = useLocation();
  return <p className="probe">{seen.url}</p>;
}

function mount(reload?: () => void): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  mounted.push(container);
  act(() => {
    render(
      <LocationProvider reload={reload}>
        <Probe />
      </LocationProvider>,
      container,
    );
  });
  return container;
}

/** Let the browser's queued history traversal run and Preact re-render. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }
}

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
  seen = undefined;
  window.history.replaceState(null, "", "/");
});

describe("LocationProvider (fragment routes)", () => {
  it("reads the route from a #/ fragment", () => {
    window.history.replaceState(null, "", "/#/dm/user.peer");
    mount();

    expect(seen?.url).toBe("/dm/user.peer");
    expect(seen?.path).toBe("/dm/user.peer");
    expect(window.location.pathname).toBe("/");
  });

  it("splits a route's query out of the fragment", () => {
    window.history.replaceState(null, "", "/#/search?q=secret%20plans");
    mount();

    expect(seen?.path).toBe("/search");
    expect(seen?.query).toEqual({ q: "secret plans" });
  });

  it("takes an address from before fragment routes as the route and moves it into the fragment, keeping history state", () => {
    window.history.replaceState({ kept: true }, "", "/channel/general/thread/msg.1?x=1");
    mount();

    expect(seen?.url).toBe("/channel/general/thread/msg.1?x=1");
    expect(seen?.path).toBe("/channel/general/thread/msg.1");
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#/channel/general/thread/msg.1?x=1");
    expect(window.history.state).toEqual({ kept: true });
  });

  it("never takes a start-up fragment such as #k= for a route", () => {
    window.history.replaceState(null, "", "/#k=0123456789abcdefghijklmnopqrstuvwxyzABCDEFG");
    mount();

    expect(seen?.url).toBe("/");
    expect(seen?.path).toBe("/");
  });

  it("route() pushes a new entry, and route(url, true) replaces the current one", async () => {
    window.history.replaceState(null, "", "/#/channels");
    const host = mount();
    const before = window.history.length;

    act(() => seen!.route("/dm/user.peer"));
    expect(window.location.pathname).toBe("/");
    expect(window.location.hash).toBe("#/dm/user.peer");
    expect(window.history.length).toBe(before + 1);
    expect(host.querySelector(".probe")?.textContent).toBe("/dm/user.peer");

    act(() => seen!.route("/settings", true));
    expect(window.location.hash).toBe("#/settings");
    expect(window.history.length).toBe(before + 1);
    expect(seen?.path).toBe("/settings");
  });

  it("adds no history entry for a route to where the address already is", () => {
    window.history.replaceState(null, "", "/#/search?q=secret%20plans");
    mount();
    const before = window.history.length;

    act(() => seen!.route("/search?q=secret%20plans"));
    act(() => seen!.route("/search?q=secret%20plans"));
    expect(window.history.length).toBe(before);
    expect(seen?.query).toEqual({ q: "secret plans" });

    act(() => seen!.route("/channels"));
    expect(window.history.length).toBe(before + 1);
  });

  it("follows back and forward", async () => {
    window.history.replaceState(null, "", "/#/channels");
    mount();
    act(() => seen!.route("/dm/user.peer"));
    act(() => seen!.route("/channel/general"));

    window.history.back();
    await settle();
    expect(seen?.path).toBe("/dm/user.peer");

    window.history.back();
    await settle();
    expect(seen?.path).toBe("/channels");

    window.history.forward();
    await settle();
    expect(seen?.path).toBe("/dm/user.peer");
  });

  it("follows a fragment edited by hand", async () => {
    window.history.replaceState(null, "", "/#/channels");
    mount();

    window.location.hash = "#/people";
    await settle();
    expect(seen?.path).toBe("/people");
  });

  // A join link opened in a tab that already shows LOAM changes only the fragment, so the browser loads
  // nothing and the start-up code that reads `#k=` never runs. Without a reload the key was thrown away.
  it("loads the page again when a join link arrives in a tab that is already open", async () => {
    for (const fragment of ["#k=hostkey", "#k=hostkey&a=admincode", "#i=invite", "#l=linkcode&k=hostkey"]) {
      window.history.replaceState(null, "", "/#/channels");
      const reload = vi.fn();
      const container = mount(reload);

      window.location.hash = fragment;
      await settle();

      expect(reload, fragment).toHaveBeenCalled();
      // Left as it arrived, for the start-up code to read after the reload.
      expect(window.location.hash, fragment).toBe(fragment);
      render(null, container);
    }
  });

  it("does not reload for a route, for another fragment, or for a join link the page loaded with", async () => {
    window.history.replaceState(null, "", "/#k=hostkey");
    const reload = vi.fn();
    mount(reload);
    await settle();

    window.location.hash = "#/search?k=v";
    await settle();
    window.location.hash = "#top";
    await settle();

    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps the same location object across renders while the route stays the same", async () => {
    window.history.replaceState(null, "", "/#/channels");
    mount();
    const first = seen;

    // Both events arrive for one fragment change; neither may change what the app holds.
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await settle();
    expect(seen).toBe(first);
  });
});
