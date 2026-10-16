import type { VNode } from "preact";
import { useEffect, useState } from "preact/hooks";

import type { DesktopBridge, DesktopState } from "../shared/ipc";
import { type Tab, TabBar } from "./components/TabBar";
import { ActivityScreen } from "./screens/ActivityScreen";
import { BusyScreen } from "./screens/BusyScreen";
import { FailedScreen } from "./screens/FailedScreen";
import { PeopleScreen } from "./screens/PeopleScreen";
import { RunningScreen } from "./screens/RunningScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { SetupScreen } from "./screens/SetupScreen";
import { StoppedScreen } from "./screens/StoppedScreen";
import { UnlockScreen } from "./screens/UnlockScreen";

/**
 * Whether the tab bar shows: once a network exists and the node is somewhere the four screens make sense
 * (running, starting, stopped or failed). Setup, the passphrase prompt and a reset in progress each take
 * the whole window.
 */
export function showsTabs(state: DesktopState): boolean {
  return Boolean(state.network) && (state.phase === "running" || state.phase === "starting" || state.phase === "stopped" || state.phase === "failed");
}

/** The Network tab's screen for this phase (also the whole window when there are no tabs). */
export function phaseScreen(state: DesktopState, bridge: DesktopBridge): VNode {
  switch (state.phase) {
    case "setup":
      return <SetupScreen bridge={bridge} state={state} />;
    case "locked":
      return <UnlockScreen bridge={bridge} state={state} />;
    case "starting":
      return <BusyScreen body="busy.startingBody" title="busy.starting" />;
    case "running":
      return <RunningScreen bridge={bridge} state={state} />;
    case "stopped":
      return <StoppedScreen bridge={bridge} state={state} />;
    case "failed":
      return <FailedScreen bridge={bridge} state={state} />;
    case "resetting":
      return <BusyScreen body="busy.resettingBody" title="busy.resetting" />;
  }
}

/**
 * The host shell: follows the main process's state (`getState()`, then every `onState` push) and shows the
 * screen for its phase, with the TUI-style tabs (Network, People, Activity, Settings) once a network exists.
 */
export function App({ bridge }: { bridge: DesktopBridge }) {
  const [state, setState] = useState<DesktopState>();
  const [tab, setTab] = useState<Tab>("network");

  useEffect(() => {
    let cancelled = false;
    // Subscribe first, so a push sent while getState() is answering isn't missed; whichever is newer wins.
    let pushed = false;
    const unsubscribe = bridge.onState((next) => {
      pushed = true;
      setState(next);
    });
    void bridge.getState().then((initial) => {
      if (!cancelled && !pushed) {
        setState(initial);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);

  const tabs = state ? showsTabs(state) : false;
  // Without tabs there is only the phase's screen; coming back to them starts on Network.
  useEffect(() => {
    if (!tabs) {
      setTab("network");
    }
  }, [tabs]);

  if (!state) {
    return (
      <div className="shell">
        <BusyScreen title="busy.loading" />
      </div>
    );
  }

  let body: VNode;
  if (!tabs || tab === "network") {
    body = phaseScreen(state, bridge);
  } else if (tab === "people") {
    body = <PeopleScreen bridge={bridge} state={state} />;
  } else if (tab === "activity") {
    body = <ActivityScreen bridge={bridge} />;
  } else {
    body = <SettingsScreen bridge={bridge} state={state} />;
  }

  return (
    <div className="shell">
      {tabs ? (
        <TabBar
          current={tab}
          nodeName={state.network?.nodeName}
          onSelect={setTab}
          pending={state.phase === "running" ? state.node.people.pending : 0}
        />
      ) : null}
      {body}
    </div>
  );
}
