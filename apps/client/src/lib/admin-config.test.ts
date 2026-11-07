import type { LoamConfig } from "@loam/schema";
import { describe, expect, it } from "vitest";

import { configDelta, isEmptyConfigUpdate, rebaseConfig } from "./admin-config";

// The admin screen's lost-update fix (review 2026-11-07 F-041): only the admin's own changes are sent, and a
// newer config from elsewhere is taken in under them.

const base: LoamConfig = {
  node: { name: "Riverside", locale: "en" },
  identity: { allowUserDisplayNameEdit: true, allowUserAvatarEdit: true, allowUserAvatarUpload: true, allowAdminUserEdit: true },
  features: {
    enablePublicChannels: true,
    enablePrivateChannels: true,
    enableUserChannels: true,
    enableReplies: true,
    enableDMs: true,
    enableReactions: true,
    enableMarkdown: true,
    enableAttachments: true,
    enableLocationSharing: false,
    enablePresence: true,
  },
  llm: {
    ollama: { enabled: false, baseUrl: "http://localhost:11434", model: "llama3", botId: "llm.bot", botDisplayName: "Assistant" },
    openai: { enabled: false, baseUrl: "https://openrouter.ai/api/v1", model: "google/gemma", apiKeySet: true },
    onDevice: { enabled: false },
  },
  admin: { bootstrap: "firstUser" },
  killSwitch: { enabled: false, requireConfirmation: true },
  retention: { messageTtlMs: 7_200_000 },
  security: { profile: "custom", transportEncryption: "optional", dbEncryption: "off" },
  access: { joinPolicy: "open" },
  sync: { enabled: true, peers: [{ url: "http://192.168.4.30:3000" }], intervalMs: 30_000, token: "a-shared-sync-token-0123" },
  mesh: { enabled: false, relay: false, ttlMs: 86_400_000, hopLimit: 8, maxCarried: 1000, maxContacts: 500 },
} as LoamConfig;

/** A copy of `config` with some sections changed. */
function edit(config: LoamConfig, change: (draft: LoamConfig) => void): LoamConfig {
  const copy = structuredClone(config);
  change(copy);
  return copy;
}

describe("configDelta", () => {
  it("is empty when nothing changed", () => {
    expect(isEmptyConfigUpdate(configDelta(structuredClone(base), base))).toBe(true);
  });

  it("sends only the fields the admin changed", () => {
    const draft = edit(base, (config) => {
      config.node.name = "Hilltop";
      config.features.enablePresence = false;
      config.llm.openai.model = "openai/gpt";
    });
    expect(configDelta(draft, base)).toEqual({
      node: { name: "Hilltop" },
      features: { enablePresence: false },
      llm: { openai: { model: "openai/gpt" } },
    });
  });

  it("clears retention and the sync token explicitly, and sends a changed peer list whole", () => {
    const draft = edit(base, (config) => {
      config.retention.messageTtlMs = undefined;
      config.sync.token = undefined;
      config.sync.peers = [...config.sync.peers, { url: "http://192.168.4.31:3000" }];
    });
    expect(configDelta(draft, base)).toEqual({
      retention: { messageTtlMs: null },
      sync: { token: "", peers: [{ url: "http://192.168.4.30:3000" }, { url: "http://192.168.4.31:3000" }] },
    });
  });

  it("sends a typed chat-service key but never the read-only apiKeySet", () => {
    const draft = edit(base, (config) => {
      config.llm.openai.apiKey = "sk-typed";
      config.llm.openai.apiKeySet = false;
    });
    expect(configDelta(draft, base)).toEqual({ llm: { openai: { apiKey: "sk-typed" } } });
  });
});

describe("rebaseConfig", () => {
  it("keeps the admin's unsaved edits and takes everything else from the newer copy", () => {
    const draft = edit(base, (config) => {
      config.node.name = "Hilltop";
    });
    // Meanwhile the host's terminal UI switched to Hardened, which forces its bundle.
    const fresh = edit(base, (config) => {
      config.security = { ...config.security, profile: "hardened", transportEncryption: "required" };
      config.access.joinPolicy = "approval";
      config.retention.messageTtlMs = 3_600_000;
      config.killSwitch.enabled = true;
      config.features.enablePresence = false;
    });
    const rebased = rebaseConfig(draft, base, fresh);
    expect(rebased).toEqual(edit(fresh, (config) => (config.node.name = "Hilltop")));
    // And the save that follows carries the rename alone, so Hardened stays.
    expect(configDelta(rebased, fresh)).toEqual({ node: { name: "Hilltop" } });
  });

  it("keeps a peer that linked itself meanwhile, and the admin's own additions and removals", () => {
    const draft = edit(base, (config) => {
      config.sync.peers = [{ url: "http://192.168.4.40:3000", label: "Added here" }];
    });
    const fresh = edit(base, (config) => {
      config.sync.peers = [...config.sync.peers, { url: "http://192.168.4.50:3000", label: "Linked by code" }];
    });
    expect(rebaseConfig(draft, base, fresh).sync.peers).toEqual([
      { url: "http://192.168.4.50:3000", label: "Linked by code" },
      { url: "http://192.168.4.40:3000", label: "Added here" },
    ]);
  });

  it("is the newer copy itself when the admin changed nothing", () => {
    const fresh = edit(base, (config) => (config.sync.enabled = false));
    expect(rebaseConfig(structuredClone(base), base, fresh)).toEqual(fresh);
  });
});
