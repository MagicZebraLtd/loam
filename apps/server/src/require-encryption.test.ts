import { afterEach, describe, expect, it } from "vitest";

import type { LoamApp } from "./app.js";
import { llmProviderRefusal, unencryptedBackendRefused, UNENCRYPTED_ASSISTANT_REFUSED } from "./llm.js";
import { defaultLoamConfig } from "./config.js";
import { makeApp, teardownApps } from "./test-support/app-harness.js";

// `AppOptions.requireTransportEncryption`: the Android launcher forces every network it hosts to require
// transport encryption, whatever the profile says, so all it sends off the phone is encrypted (docs/08, docs/30
// Data safety). The forcing is a read-time projection: the stored config keeps the operator's choice. On such a
// network an assistant on another machine must be reached over HTTPS.

afterEach(teardownApps);

/** What the public, cookie-free bootstrap advertises as the network's transport mode. */
async function advertisedMode(app: LoamApp): Promise<string> {
  const response = await app.server.inject({ method: "GET", url: "/api/bootstrap" });
  return (response.json() as { networkConfig: { transportEncryption: string } }).networkConfig.transportEncryption;
}

describe("a launcher that requires transport encryption", () => {
  it("makes every profile require encryption without changing the stored setting", async () => {
    const forced = await makeApp({ security: { profile: "standard" } }, { requireTransportEncryption: true });
    expect(await advertisedMode(forced)).toBe("required");
    expect(forced.host.status()).toMatchObject({ transportEncryption: "required" });
    expect(forced.host.config().security.transportEncryption).toBe("optional");

    // An unencrypted client can't read content: it is told to scan the code.
    const plaintext = await forced.server.inject({ method: "GET", url: "/api/channels" });
    expect(plaintext.statusCode).toBe(401);

    // Switching the profile doesn't lower it.
    expect(forced.host.updateConfig({ security: { profile: "open" } }).ok).toBe(true);
    expect(await advertisedMode(forced)).toBe("required");

    // The same config without the launcher's flag stays optional.
    const plain = await makeApp({ security: { profile: "standard" } });
    expect(await advertisedMode(plain)).toBe("optional");
  });

  it("refuses an assistant over plain HTTP on another machine, and allows HTTPS or this machine", async () => {
    const app = await makeApp(undefined, { requireTransportEncryption: true });

    const lan = app.host.updateConfig({ llm: { ollama: { enabled: true, baseUrl: "http://192.168.1.20:11434", model: "m" } } });
    expect(lan).toEqual({ ok: false, error: UNENCRYPTED_ASSISTANT_REFUSED });
    expect(app.host.config().llm.ollama.enabled).toBe(false);

    const service = app.host.updateConfig({ llm: { openai: { enabled: true, baseUrl: "http://lmstudio.local:1234/v1", model: "m" } } });
    expect(service).toEqual({ ok: false, error: UNENCRYPTED_ASSISTANT_REFUSED });

    expect(app.host.updateConfig({ llm: { ollama: { enabled: true, baseUrl: "http://127.0.0.1:11434", model: "m" } } }).ok).toBe(true);
    expect(app.host.updateConfig({ llm: { ollama: { enabled: true, baseUrl: "https://ollama.example.com", model: "m" } } }).ok).toBe(true);

    // The Test button won't send the key over plain HTTP either.
    expect(await app.host.llmModels({ provider: "openai", baseUrl: "http://192.168.1.20:1234/v1" })).toEqual({
      ok: false,
      code: "llm_unencrypted",
    });
  });

  it("boots a hand-edited plain-HTTP assistant with the assistant off", async () => {
    const config = { llm: { ollama: { enabled: true, baseUrl: "http://192.168.1.20:11434", model: "m" } } };
    const forced = await makeApp(config, { requireTransportEncryption: true });
    const bootstrap = (await forced.server.inject({ method: "GET", url: "/api/bootstrap" })).json() as {
      networkConfig: { enableLLMChat: boolean };
    };
    expect(bootstrap.networkConfig.enableLLMChat).toBe(false);
    expect(forced.host.config().llm.ollama.enabled).toBe(true);
  });
});

describe("unencryptedBackendRefused", () => {
  const forced = { requireTransportEncryption: true };

  it("refuses plain HTTP off this machine only when the launcher requires encryption", () => {
    expect(unencryptedBackendRefused("http://192.168.1.20:11434", forced)).toBe(true);
    expect(unencryptedBackendRefused("http://ollama.example.com", forced)).toBe(true);
    expect(unencryptedBackendRefused("http://[fe80::1]:11434", forced)).toBe(true);
    expect(unencryptedBackendRefused("http://localhost:11434", forced)).toBe(false);
    expect(unencryptedBackendRefused("http://127.0.0.1:11434", forced)).toBe(false);
    expect(unencryptedBackendRefused("http://[::1]:11434", forced)).toBe(false);
    expect(unencryptedBackendRefused("https://192.168.1.20:11434", forced)).toBe(false);
    expect(unencryptedBackendRefused("http://192.168.1.20:11434", {})).toBe(false);
  });

  it("leaves the hardened rule first, and says nothing when no network assistant is on", () => {
    const config = defaultLoamConfig();
    expect(llmProviderRefusal(config, forced)).toBeUndefined();
    config.llm.ollama = { ...config.llm.ollama, enabled: true, baseUrl: "http://192.168.1.20:11434" };
    expect(llmProviderRefusal(config, forced)).toBe(UNENCRYPTED_ASSISTANT_REFUSED);
    expect(llmProviderRefusal(config)).toBeUndefined();
  });
});
