import {
  activeLlmProvider,
  isLocalNetworkUrl,
  type LlmModelsRequest,
  type LlmModelsResponse,
  type LlmProvider,
  type LoamConfig,
  OPENAI_COMPATIBLE_PRESETS,
} from "@loam/schema";
import { useState } from "preact/hooks";

import { t } from "../i18n";
import type { CatalogKey } from "../i18n/en";
import { CardHeader } from "./ScreenParts";

type LlmConfig = LoamConfig["llm"];
type OllamaConfig = LlmConfig["ollama"];
type OpenAiConfig = LlmConfig["openai"];
type OnDeviceConfig = LlmConfig["onDevice"];

/** What the Test connection button last found, per backend. */
type TestState = { kind: "idle" } | { kind: "busy" } | { kind: "ok"; models: string[] } | { kind: "error"; code: string };

const PROVIDERS: LlmProvider[] = ["off", "ollama", "openai", "onDevice"];

const PROVIDER_LABEL: Record<LlmProvider, CatalogKey> = {
  off: "admin.llmProviderOff",
  ollama: "admin.llmProviderOllama",
  openai: "admin.llmProviderOpenAi",
  onDevice: "admin.llmProviderOnDevice",
};

const TEST_ERROR: Record<string, CatalogKey> = {
  llm_unreachable: "admin.llmTestUnreachable",
  llm_unauthorized: "admin.llmTestUnauthorized",
  llm_bad_response: "admin.llmTestBadResponse",
  llm_not_allowed: "admin.llmTestNotAllowed",
};

/** The preset whose base URL is saved, or "custom" when the URL is the admin's own. */
function presetFor(baseUrl: string): string {
  return OPENAI_COMPATIBLE_PRESETS.find((preset) => preset.baseUrl === baseUrl)?.id ?? "custom";
}

/** The host name a cloud service's messages go to, for the privacy note; the URL as typed if it won't parse. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Admin LLM settings panel: which backend answers the assistant (none, Ollama, an OpenAI-compatible
 * chat service, or the Android host's own model), that backend's connection with a Test button that
 * lists its models, and the bot's identity. Presentational: the `llm` config and `saving` flag come in via
 * props, edits funnel through the three `on…Change` callbacks with a partial update (mirroring AdminView's
 * setters), and `onListModels` asks the node (`POST /api/admin/llm/models`) so the panel holds only what
 * the Test button found. The API key is write-only: the config carries `apiKeySet`, never the key, so the
 * key field is empty until the admin types a new one, and "Clear key" sends an empty string.
 */
export function LlmPanel({
  llm,
  saving,
  onOllamaChange,
  onOpenAiChange,
  onOnDeviceChange,
  onListModels,
}: {
  llm: LlmConfig;
  saving: boolean;
  onOllamaChange: (update: Partial<OllamaConfig>) => void;
  onOpenAiChange: (update: Partial<OpenAiConfig>) => void;
  onOnDeviceChange: (update: Partial<OnDeviceConfig>) => void;
  onListModels: (request: LlmModelsRequest) => Promise<LlmModelsResponse>;
}) {
  const { ollama, openai, onDevice } = llm;
  const provider = activeLlmProvider(llm);
  const [tests, setTests] = useState<Record<"ollama" | "openai", TestState>>({ ollama: { kind: "idle" }, openai: { kind: "idle" } });
  const cloud = !isLocalNetworkUrl(openai.baseUrl);
  // Ollama answers wherever its address points, so an Ollama address off the local network is a cloud
  // assistant too, and the server refuses it on a hardened network just like a service (llmProviderRefusal).
  const ollamaCloud = !isLocalNetworkUrl(ollama.baseUrl);

  /** Exactly one backend is on at a time; the server's precedence (on-device, service, Ollama) then agrees. */
  function choose(next: LlmProvider): void {
    onOllamaChange({ enabled: next === "ollama" });
    onOpenAiChange({ enabled: next === "openai" });
    onOnDeviceChange({ enabled: next === "onDevice" });
  }

  async function test(backend: "ollama" | "openai"): Promise<void> {
    setTests((previous) => ({ ...previous, [backend]: { kind: "busy" } }));
    const request: LlmModelsRequest =
      backend === "ollama" ? { provider: "ollama", baseUrl: ollama.baseUrl } : { provider: "openai", baseUrl: openai.baseUrl, apiKey: openai.apiKey };
    let result: TestState;
    try {
      const response = await onListModels(request);
      result = response.ok ? { kind: "ok", models: response.models } : { kind: "error", code: response.code };
    } catch {
      result = { kind: "error", code: "llm_unreachable" };
    }
    setTests((previous) => ({ ...previous, [backend]: result }));
  }

  function testStatus(backend: "ollama" | "openai") {
    const state = tests[backend];
    if (state.kind === "idle") {
      return null;
    }
    const text =
      state.kind === "busy"
        ? t("admin.llmTestBusy")
        : state.kind === "ok"
          ? state.models.length
            ? t("admin.llmTestFound", { count: state.models.length })
            : t("admin.llmTestNone")
          : t(TEST_ERROR[state.code] ?? "admin.llmTestBadResponse");
    return (
      <span className={state.kind === "error" ? "form-error" : "field-hint"} role={state.kind === "error" ? "alert" : "status"}>
        {text}
      </span>
    );
  }

  function modelField(backend: "ollama" | "openai") {
    const state = tests[backend];
    const models = state.kind === "ok" ? state.models : [];
    const listId = `llm-models-${backend}`;
    const value = backend === "ollama" ? ollama.model : openai.model;
    const onChange = (model: string) => (backend === "ollama" ? onOllamaChange({ model }) : onOpenAiChange({ model }));
    return (
      <label className="field">
        <span className="field-label">{t("admin.llmModel")}</span>
        <input
          className="input"
          disabled={saving}
          list={models.length ? listId : undefined}
          maxLength={120}
          onInput={(event) => onChange(event.currentTarget.value)}
          value={value}
        />
        {models.length ? (
          <datalist id={listId}>
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        ) : null}
        <span className="field-hint">{models.length ? t("admin.llmModelPick") : t("admin.llmModelHint")}</span>
      </label>
    );
  }

  return (
    <div className="card">
      <CardHeader level={3} title={t("admin.llmHeading")} />
      <p className="muted">{t("admin.llmIntro")}</p>
      <label className="field">
        <span className="field-label">{t("admin.llmProvider")}</span>
        <select className="select" disabled={saving} onInput={(event) => choose(event.currentTarget.value as LlmProvider)} value={provider}>
          {PROVIDERS.map((option) => (
            <option key={option} value={option}>
              {t(PROVIDER_LABEL[option])}
            </option>
          ))}
        </select>
      </label>

      {provider === "ollama" ? (
        <div className="card-section">
          <label className="field">
            <span className="field-label">{t("admin.llmBaseUrl")}</span>
            <input className="input" disabled={saving} onInput={(event) => onOllamaChange({ baseUrl: event.currentTarget.value })} value={ollama.baseUrl} />
            <span className="field-hint">{t("admin.llmOllamaHint")}</span>
          </label>
          <div className="field">
            <button className="btn btn-secondary btn-sm" disabled={saving || tests.ollama.kind === "busy"} onClick={() => void test("ollama")} type="button">
              {t("admin.llmTest")}
            </button>
            {testStatus("ollama")}
          </div>
          {modelField("ollama")}
          <p className={ollamaCloud ? "form-error" : "field-hint"} role="note">
            {ollamaCloud ? t("admin.llmCloudNote", { host: hostOf(ollama.baseUrl) }) : t("admin.llmLocalNote")}
          </p>
        </div>
      ) : null}

      {provider === "openai" ? (
        <div className="card-section">
          <label className="field">
            <span className="field-label">{t("admin.llmService")}</span>
            <select
              className="select"
              disabled={saving}
              onInput={(event) => {
                const preset = OPENAI_COMPATIBLE_PRESETS.find((entry) => entry.id === event.currentTarget.value);
                if (preset) {
                  onOpenAiChange({ baseUrl: preset.baseUrl });
                }
              }}
              value={presetFor(openai.baseUrl)}
            >
              {OPENAI_COMPATIBLE_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
              <option value="custom">{t("admin.llmServiceCustom")}</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t("admin.llmServiceUrl")}</span>
            <input className="input" disabled={saving} onInput={(event) => onOpenAiChange({ baseUrl: event.currentTarget.value })} value={openai.baseUrl} />
            <span className="field-hint">{t("admin.llmServiceUrlHint")}</span>
          </label>
          <label className="field">
            <span className="field-label">{t("admin.llmApiKey")}</span>
            <input
              autoComplete="off"
              className="input"
              disabled={saving}
              maxLength={512}
              onInput={(event) => onOpenAiChange({ apiKey: event.currentTarget.value || undefined })}
              placeholder={openai.apiKeySet && openai.apiKey === undefined ? t("admin.llmApiKeySet") : t("admin.llmApiKeyNone")}
              type="password"
              value={openai.apiKey ?? ""}
            />
            <span className="field-hint">{t("admin.llmApiKeyHint")}</span>
          </label>
          {openai.apiKeySet && openai.apiKey !== "" ? (
            <div className="field">
              <button className="btn btn-secondary btn-sm" disabled={saving} onClick={() => onOpenAiChange({ apiKey: "" })} type="button">
                {t("admin.llmApiKeyClear")}
              </button>
            </div>
          ) : null}
          {openai.apiKey === "" && openai.apiKeySet ? <span className="field-hint">{t("admin.llmApiKeyClearing")}</span> : null}
          <div className="field">
            <button className="btn btn-secondary btn-sm" disabled={saving || tests.openai.kind === "busy"} onClick={() => void test("openai")} type="button">
              {t("admin.llmTest")}
            </button>
            {testStatus("openai")}
          </div>
          {modelField("openai")}
          <p className={cloud ? "form-error" : "field-hint"} role="note">
            {cloud ? t("admin.llmCloudNote", { host: hostOf(openai.baseUrl) }) : t("admin.llmLocalNote")}
          </p>
        </div>
      ) : null}

      {provider === "onDevice" ? (
        <div className="card-section">
          <p className="field-hint">{t("admin.llmOnDeviceNote")}</p>
          <label className="field">
            <span className="field-label">{t("admin.llmOnDeviceModel")}</span>
            <input
              className="input"
              disabled={saving}
              maxLength={120}
              onInput={(event) => onOnDeviceChange({ model: event.currentTarget.value || undefined })}
              value={onDevice.model ?? ""}
            />
          </label>
        </div>
      ) : null}

      {provider !== "off" ? (
        <div className="card-section">
          <label className="field">
            <span className="field-label">{t("admin.llmBotName")}</span>
            <input
              className="input"
              disabled={saving}
              maxLength={80}
              onInput={(event) => onOllamaChange({ botDisplayName: event.currentTarget.value })}
              value={ollama.botDisplayName}
            />
          </label>
          <label className="field">
            <span className="field-label">{t("admin.llmSystemPrompt")}</span>
            <textarea
              className="textarea"
              disabled={saving}
              maxLength={4000}
              onInput={(event) => onOllamaChange({ systemPrompt: event.currentTarget.value || undefined })}
              rows={3}
              value={ollama.systemPrompt ?? ""}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}
