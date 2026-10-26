/**
 * Settings: the network's main settings, changed live through the same path the web admin saves through
 * (so the two always agree), a few actions, and what this computer remembers for the next `loam` start.
 * The web app's admin page has the rest.
 */
import {
  activeLlmProvider,
  isLocalNetworkUrl,
  type LlmModelsRequest,
  type LlmProvider,
  type LoamConfig,
  type LoamConfigUpdate,
  OPENAI_COMPATIBLE_PRESETS,
  type SecurityProfile,
} from "@loam/schema";

import { clean, type Line, padEnd, text } from "../ansi.js";
import { isChar } from "../keys.js";
import { textField } from "../modal.js";
import { qrBlock } from "../qr.js";
import { paragraph, withQrIfItFits } from "./join.js";
import type { Screen, View } from "../types.js";

type Row = {
  section: string;
  label: string;
  value: string;
  /** Why it can't be changed here, if it can't. */
  locked?: string;
  activate?(view: View): void;
};

const PROFILE_LABELS: Record<SecurityProfile, string> = {
  custom: "Choose each setting",
  open: "Open",
  standard: "Standard",
  hardened: "Hardened",
};

const LIFETIMES: { label: string; ms: number | null }[] = [
  { label: "Never", ms: null },
  { label: "After 1 hour", ms: 3_600_000 },
  { label: "After 24 hours", ms: 86_400_000 },
  { label: "After 7 days", ms: 7 * 86_400_000 },
];

function lifetimeLabel(ms: number | undefined): string {
  return LIFETIMES.find((entry) => entry.ms === (ms ?? null))?.label ?? `After ${Math.round((ms ?? 0) / 60_000)} minutes`;
}

/** Apply a change and say how it went. */
function save(view: View, update: LoamConfigUpdate, done: string): void {
  const result = view.options.host.updateConfig(update);
  view.toast(result.ok ? done : `Not saved: ${result.error}`, result.ok ? "ok" : "error");
}

function choose<T>(
  view: View,
  title: string,
  body: string,
  choices: { label: string; detail?: string; value: T }[],
  current: T,
  apply: (value: T) => void,
): void {
  view.open({
    kind: "choice",
    title,
    body: [body],
    options: choices.map(({ label, detail }) => ({ label, detail })),
    selected: Math.max(0, choices.findIndex((choice) => choice.value === current)),
    onPick: (index) => apply(choices[index]!.value),
  });
}

function onOff(value: boolean): string {
  return value ? "On" : "Off";
}

const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  off: "Off",
  ollama: "Ollama",
  openai: "Chat service",
  onDevice: "On this device",
};

const LLM_TEST_WORDS: Record<string, string> = {
  llm_unreachable: "Could not reach the service at that address.",
  llm_unauthorized: "The service refused the key.",
  llm_bad_response: "The service answered, but not in a way loam understands. Check the address.",
  llm_not_allowed: "A hardened network can only use a service on this computer or the local network.",
};

/** The host name a cloud service's messages go to, for the note; the URL as typed if it won't parse. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Switch exactly one assistant backend on (or all off), so the server's precedence agrees with the screen. */
function chooseLlmProvider(view: View, provider: LlmProvider): void {
  save(
    view,
    { llm: { ollama: { enabled: provider === "ollama" }, openai: { enabled: provider === "openai" }, onDevice: { enabled: provider === "onDevice" } } },
    provider === "off" ? "Assistant off" : "Saved",
  );
}

/** A text row for one of the assistant's connection settings. */
function llmTextRow(
  view: View,
  label: string,
  current: string,
  body: string[],
  options: { secret?: boolean; maxLength: number },
  apply: (value: string) => string | undefined,
): void {
  view.open({
    kind: "input",
    title: label,
    body,
    field: textField(options.secret ? "" : current, { secret: options.secret, maxLength: options.maxLength }),
    onSubmit: (value) => apply(value),
  });
}

/**
 * Pick the assistant's model: ask the backend for its list and offer it, with the current model chosen;
 * when the backend can't be asked, say why and take the name typed instead.
 */
function pickLlmModel(view: View, request: LlmModelsRequest, current: string, apply: (model: string) => void): void {
  view.toast("Asking for the list of models...");
  void view.options.host.llmModels(request).then(
    (result) => {
      if (result.ok && result.models.length) {
        // Names come from a service: nothing it sends may reach the terminal uncleaned.
        const offered = result.models.map(clean);
        const models = offered.includes(current) ? offered : [current, ...offered];
        choose(
          view,
          "Model",
          `${result.models.length} models offered. Choose one.`,
          models.map((model) => ({ label: model, value: model })),
          current,
          apply,
        );
        return;
      }
      const why = result.ok ? "The service listed no models." : (LLM_TEST_WORDS[result.code] ?? LLM_TEST_WORDS.llm_bad_response!);
      llmTextRow(view, "Model", current, [why, "Type the model's name as the service knows it."], { maxLength: 120 }, (value) => {
        if (!value.trim()) {
          return "The model name can't be empty.";
        }
        apply(value.trim());
        return undefined;
      });
    },
    () => view.toast("Could not ask for the list of models.", "error"),
  );
}

/** The Assistant rows: which backend answers, and that backend's connection (collapsed when off). */
function llmRows(config: LoamConfig): Row[] {
  const { llm } = config;
  const provider = activeLlmProvider(llm);
  const summary =
    provider === "off" ? "Off" : provider === "onDevice" ? LLM_PROVIDER_LABELS.onDevice : `${LLM_PROVIDER_LABELS[provider]}, ${clean(provider === "openai" ? llm.openai.model : llm.ollama.model)}`;
  const hardened = config.security.profile === "hardened";
  const rows: Row[] = [
    {
      section: "Assistant",
      label: "Assistant",
      value: summary,
      activate(view) {
        choose(
          view,
          "Assistant",
          "An optional chat assistant people can message. Choose where it runs.",
          [
            { label: "Off", value: "off" as LlmProvider },
            { label: "Ollama", detail: "on this computer or the local network", value: "ollama" as LlmProvider },
            {
              label: "Chat service",
              detail: hardened ? "OpenAI-style, on this computer or the local network" : "OpenRouter, OpenAI, LM Studio and others",
              value: "openai" as LlmProvider,
            },
          ],
          provider === "onDevice" ? "off" : provider,
          (value) => chooseLlmProvider(view, value),
        );
      },
    },
  ];

  if (provider === "ollama") {
    // An Ollama address off the local network sends the conversation there, like a cloud service.
    const ollamaCloud = !isLocalNetworkUrl(llm.ollama.baseUrl);
    rows.push(
      {
        section: "Assistant",
        label: "Ollama address",
        value: `${clean(llm.ollama.baseUrl)}${ollamaCloud ? `  (messages go to ${hostOf(llm.ollama.baseUrl)})` : ""}`,
        activate(view) {
          llmTextRow(
            view,
            "Ollama address",
            llm.ollama.baseUrl,
            [
              "Where Ollama listens. On this computer that is http://localhost:11434.",
              "An address outside the local network sends people's messages to the assistant there. A hardened network refuses one.",
            ],
            { maxLength: 200 },
            (value) => {
              if (!/^https?:\/\//.test(value.trim())) {
                return "Enter an http:// or https:// address.";
              }
              save(view, { llm: { ollama: { baseUrl: value.trim() } } }, "Saved");
              return undefined;
            },
          );
        },
      },
      {
        section: "Assistant",
        label: "Model",
        value: clean(llm.ollama.model),
        activate(view) {
          pickLlmModel(view, { provider: "ollama", baseUrl: llm.ollama.baseUrl }, llm.ollama.model, (model) => save(view, { llm: { ollama: { model } } }, "Saved"));
        },
      },
    );
  }

  if (provider === "openai") {
    const preset = OPENAI_COMPATIBLE_PRESETS.find((entry) => entry.baseUrl === llm.openai.baseUrl);
    const cloud = !isLocalNetworkUrl(llm.openai.baseUrl);
    rows.push(
      {
        section: "Assistant",
        label: "Service",
        value: `${preset?.label ?? llm.openai.baseUrl}${cloud ? `  (messages go to ${hostOf(llm.openai.baseUrl)})` : ""}`,
        activate(view) {
          choose(
            view,
            "Service",
            cloud
              ? "Messages people send to the assistant leave this network and go to the service. Everyone who messages it should know that."
              : "Pick a service, or give another address.",
            [
              ...OPENAI_COMPATIBLE_PRESETS.map((entry) => ({ label: entry.label, detail: entry.cloud ? "online" : "local", value: entry.baseUrl })),
              { label: "Another address", detail: "type it in", value: "" },
            ],
            preset?.baseUrl ?? "",
            (value) => {
              if (value) {
                save(view, { llm: { openai: { baseUrl: value } } }, "Saved");
                return;
              }
              llmTextRow(view, "Service address", llm.openai.baseUrl, ["The base of the service's OpenAI-style API, ending in /v1 for most services."], { maxLength: 200 }, (typed) => {
                if (!/^https?:\/\//.test(typed.trim())) {
                  return "Enter an http:// or https:// address.";
                }
                save(view, { llm: { openai: { baseUrl: typed.trim() } } }, "Saved");
                return undefined;
              });
            },
          );
        },
      },
      {
        section: "Assistant",
        label: "API key",
        value: llm.openai.apiKeySet ? "Set" : "Not set",
        activate(view) {
          llmTextRow(
            view,
            "API key",
            "",
            [
              "Paste the key the service gave you. It is kept on this computer, sent only to the service, and never shown again.",
              llm.openai.apiKeySet ? "Leave it empty and press Enter to remove the saved key." : "Leave it empty if the service needs no key.",
            ],
            { secret: true, maxLength: 512 },
            (value) => {
              save(view, { llm: { openai: { apiKey: value.trim() } } }, value.trim() ? "Key saved" : "Key removed");
              return undefined;
            },
          );
        },
      },
      {
        section: "Assistant",
        label: "Model",
        value: clean(llm.openai.model),
        activate(view) {
          pickLlmModel(view, { provider: "openai", baseUrl: llm.openai.baseUrl }, llm.openai.model, (model) => save(view, { llm: { openai: { model } } }, "Saved"));
        },
      },
    );
  }

  if (provider !== "off") {
    rows.push({
      section: "Assistant",
      label: "Assistant's name",
      value: llm.ollama.botDisplayName,
      activate(view) {
        llmTextRow(view, "Assistant's name", llm.ollama.botDisplayName, ["How the assistant appears in people's messages."], { maxLength: 80 }, (value) => {
          if (!value.trim()) {
            return "The name can't be empty.";
          }
          save(view, { llm: { ollama: { botDisplayName: value.trim() } } }, "Saved");
          return undefined;
        });
      },
    });
  }

  return rows;
}

function rows(view: View, config: LoamConfig): Row[] {
  const profile = config.security.profile;
  const byProfile = profile === "custom" ? undefined : `set by the ${PROFILE_LABELS[profile]} profile`;
  const { settings } = view;

  return [
    {
      section: "Network",
      label: "Name",
      value: config.node.name,
      activate(view) {
        view.open({
          kind: "input",
          title: "Network name",
          body: ["Shown to everyone who joins."],
          field: textField(config.node.name, { maxLength: 80 }),
          onSubmit(value) {
            if (!value.trim()) {
              return "The name can't be empty.";
            }
            save(view, { node: { name: value.trim() } }, "Name saved");
            return undefined;
          },
        });
      },
    },
    {
      section: "Network",
      label: "Security profile",
      value: PROFILE_LABELS[profile],
      activate(view) {
        choose(
          view,
          "Security profile",
          "A profile sets who can join, connection encryption, how long messages last and the remote Emergency Reset together.",
          [
            { label: PROFILE_LABELS.custom, detail: "set each one below", value: "custom" as SecurityProfile },
            { label: "Open", detail: "anyone joins, messages kept", value: "open" as SecurityProfile },
            { label: "Standard", detail: "as Open, for everyday use", value: "standard" as SecurityProfile },
            { label: "Hardened", detail: "approval, encrypted only, 1-hour messages", value: "hardened" as SecurityProfile },
          ],
          profile,
          (value) => save(view, { security: { profile: value } }, "Profile saved"),
        );
      },
    },
    {
      section: "Network",
      label: "Who can join",
      value: config.access.joinPolicy === "approval" ? "Approved people only" : "Anyone nearby",
      locked: byProfile,
      activate(view) {
        choose(
          view,
          "Who can join",
          "With approval, newcomers wait until an admin or greeter lets them in. People who scan the join QR on this screen get straight in.",
          [
            { label: "Anyone nearby", value: "open" as const },
            { label: "Approved people only", value: "approval" as const },
          ],
          config.access.joinPolicy,
          (value) => save(view, { access: { joinPolicy: value } }, "Saved"),
        );
      },
    },
    {
      section: "Network",
      label: "Connection encryption",
      value: config.security.transportEncryption === "required" ? "Required" : "When possible",
      locked: byProfile,
      activate(view) {
        choose(
          view,
          "Connection encryption",
          "Everyone who joins by the QR code is encrypted either way. Required also turns away devices that typed the address by hand.",
          [
            { label: "When possible", value: "optional" as const },
            { label: "Required", value: "required" as const },
          ],
          config.security.transportEncryption,
          (value) => save(view, { security: { transportEncryption: value } }, "Saved"),
        );
      },
    },
    {
      section: "Network",
      label: "Delete messages",
      value: lifetimeLabel(config.retention.messageTtlMs),
      locked: byProfile,
      activate(view) {
        const current = config.retention.messageTtlMs ?? null;
        // A lifetime set in the web app that isn't one of these stays on offer (and chosen), so pressing
        // Enter to keep it can't quietly switch deleting off.
        const choices = LIFETIMES.some((entry) => entry.ms === current)
          ? LIFETIMES
          : [{ label: lifetimeLabel(current ?? undefined), ms: current }, ...LIFETIMES];
        choose(
          view,
          "Delete messages",
          "Older messages are deleted from this computer and from everyone's screen.",
          choices.map((entry) => ({ label: entry.label, value: entry.ms })),
          current,
          (value) => save(view, { retention: { messageTtlMs: value } }, "Saved"),
        );
      },
    },
    {
      section: "Network",
      label: "Emergency Reset from the web app",
      value: onOff(config.killSwitch.enabled),
      locked: byProfile,
      activate(view) {
        save(view, { killSwitch: { enabled: !config.killSwitch.enabled } }, "Saved");
      },
    },
    {
      section: "Network",
      label: "Show who's online",
      value: onOff(config.features.enablePresence),
      activate(view) {
        save(view, { features: { enablePresence: !config.features.enablePresence } }, "Saved");
      },
    },
    ...llmRows(config),
    {
      section: "Actions",
      label: "Link another LOAM network",
      value: "Show a link code",
      activate: showLinkCode,
    },
    {
      section: "Actions",
      label: "Emergency Reset",
      value: "Wipe everything now",
      activate: confirmEmergencyReset,
    },
    {
      section: "This computer",
      label: "Port",
      value: `${settings.port ?? view.status.port}${settings.port && settings.port !== view.status.port ? " from next start" : ""}`,
      activate(view) {
        view.open({
          kind: "input",
          title: "Port",
          body: [
            "Used the next time you start loam (a --port flag still wins). Joiners will need the new QR code.",
            "Ports below 1024 usually need administrator rights; if this one can't be used, loam starts on 3000 instead.",
          ],
          field: textField(String(settings.port ?? view.status.port), { maxLength: 5 }),
          onSubmit(value) {
            const port = Number(value);
            if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
              return "Enter a number from 1 to 65535.";
            }
            if (view.saveSettings({ ...view.settings, port })) {
              view.toast(`Port ${port} from the next start`);
            }
            return undefined;
          },
        });
      },
    },
    {
      section: "This computer",
      label: "Kiosk mode",
      value: settings.kiosk ? "Lock now (k)" : "Set a password and lock (k)",
      activate: (view) => view.lockKiosk(),
    },
    {
      section: "This computer",
      label: "Start locked",
      value: settings.kiosk?.startLocked ? "On" : "Off",
      locked: settings.kiosk ? undefined : "set a kiosk password first",
      activate(view) {
        const kiosk = view.settings.kiosk;
        if (kiosk) {
          if (view.saveSettings({ ...view.settings, kiosk: { ...kiosk, startLocked: !kiosk.startLocked } })) {
            view.toast(kiosk.startLocked ? "Starts unlocked" : "Starts locked in kiosk mode");
          }
        }
      },
    },
    {
      section: "This computer",
      label: "Forget kiosk password",
      value: settings.kiosk ? "Remove it" : "",
      locked: settings.kiosk ? undefined : "no password set",
      activate(view) {
        view.open({
          kind: "confirm",
          title: "Forget the kiosk password?",
          body: ["You'll set a new one the next time you lock the screen."],
          yes: "forget it",
          onYes() {
            const { kiosk: _removed, ...rest } = view.settings;
            if (view.saveSettings(rest)) {
              view.toast("Kiosk password forgotten");
            }
          },
        });
      },
    },
  ];
}

function showLinkCode(view: View): void {
  const { host } = view.options;
  const key = host.transportPublicKey();
  const { code } = host.linkCode();
  const link = `${view.joinUrl()}#${key ? `k=${key}&` : ""}l=${code}`;
  const qr = qrBlock(link);
  view.open({
    kind: "panel",
    title: "Link another LOAM network",
    lines: (width, height) =>
      withQrIfItFits(
        paragraph(
          "On the other LOAM phone: setup, then Join another LOAM network, and scan this. The two networks then share their public channels both ways. It works once, for 10 minutes.",
          width,
          { dim: true },
        ),
        qr,
        link,
        width,
        height,
      ),
  });
}

/**
 * What the host is told after an Emergency Reset. An unfinished one is finished by a restart only when the
 * node managed to record it first (`journaled`); otherwise a restart serves whatever survived, so the host
 * has to run the reset again.
 */
function resetOutcome(result: { complete: boolean; journaled: boolean }): string {
  if (result.complete) {
    return "Emergency Reset done";
  }
  return result.journaled
    ? "The reset didn't finish. Restart loam to complete it."
    : "The reset could not be recorded and did not finish. Restart loam and run the Emergency Reset again.";
}

function confirmEmergencyReset(view: View): void {
  view.open({
    kind: "input",
    title: "Emergency Reset",
    body: [
      "Deletes every message, person, channel and file on this network now, and signs everyone out. Settings are kept. This can't be undone.",
      "Type wipe to confirm.",
    ],
    field: textField("", { maxLength: 10 }),
    async onSubmit(value) {
      if (value.trim().toLowerCase() !== "wipe") {
        return "Type wipe to confirm, or press Esc.";
      }
      const result = await view.options.host.emergencyReset();
      view.toast(resetOutcome(result), result.complete ? "ok" : "error");
      return undefined;
    },
  });
}

/** Selectable rows, for tests. */
export function settingsRows(view: View): Row[] {
  return rows(view, view.options.host.config());
}

export const settingsScreen: Screen = {
  id: "settings",
  title: "Settings",
  hints: () => "↑↓ choose · Enter change · ? help",
  render(view, width, height) {
    const list = settingsRows(view);
    const state = view.state.settings;
    state.selected = Math.max(0, Math.min(state.selected, list.length - 1));
    const labelWidth = Math.min(36, Math.max(24, Math.floor(width / 3)));

    const lines: Line[] = [];
    let section = "";
    let selectedLine = 0;
    list.forEach((row, index) => {
      if (row.section !== section) {
        section = row.section;
        if (lines.length) {
          lines.push([]);
        }
        lines.push(text(` ${section}`, { bold: true }));
      }
      const chosen = index === state.selected;
      if (chosen) {
        selectedLine = lines.length;
      }
      lines.push([
        { text: chosen ? " › " : "   ", style: { fg: "cyan" } },
        { text: padEnd(row.label, labelWidth), style: chosen ? { inverse: true } : undefined },
        { text: "  " },
        { text: row.value, style: row.locked ? { dim: true } : { fg: "cyan" } },
        { text: row.locked ? `  (${row.locked})` : "", style: { dim: true } },
      ]);
    });
    lines.push([], text(" The web app's admin page has every other setting, and can test the assistant's connection.", { dim: true }));

    // Keep the chosen row in view on a short window.
    const start = Math.max(0, Math.min(selectedLine - Math.floor(height / 2), lines.length - height));
    return lines.slice(start, start + height);
  },
  key(view, key) {
    const state = view.state.settings;
    if (key.name === "up") {
      state.selected = Math.max(0, state.selected - 1);
      return true;
    }
    if (key.name === "down") {
      state.selected += 1;
      return true;
    }
    if (key.name === "enter" || isChar(key, " ")) {
      const row = settingsRows(view)[state.selected];
      if (row?.locked) {
        view.toast(`Can't change this: ${row.locked}`, "error");
      } else {
        row?.activate?.(view);
      }
      return true;
    }
    return false;
  },
};
