import type { LlmModelsRequest, LlmModelsResponse, LoamConfig } from "@loam/schema";
import type { VNode } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { LlmPanel } from "./LlmPanel";

type LlmConfig = LoamConfig["llm"];

const mounted: HTMLDivElement[] = [];

const base: LlmConfig = {
  ollama: { enabled: false, baseUrl: "http://localhost:11434", model: "llama3", botId: "llm.bot", botDisplayName: "Assistant" },
  openai: { enabled: false, baseUrl: "https://openrouter.ai/api/v1", model: "google/gemma", apiKeySet: false },
  onDevice: { enabled: false },
};

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(element, container);
  mounted.push(container);
  return container;
}

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
});

const noop = () => {};
const never = async (): Promise<LlmModelsResponse> => ({ ok: false, code: "llm_unreachable" });

function textInputs(host: HTMLElement): HTMLInputElement[] {
  return Array.from(host.querySelectorAll('input:not([type="checkbox"])'));
}

function labelled(host: HTMLElement, label: string): HTMLInputElement {
  const field = Array.from(host.querySelectorAll("label.field")).find((node) => node.querySelector(".field-label")?.textContent === label);
  const input = field?.querySelector("input");
  if (!input) {
    throw new Error(`no input labelled ${label}`);
  }
  return input;
}

function flush(): Promise<void> {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

describe("LlmPanel", () => {
  it("shows no connection fields while the assistant is off, and the picker switches exactly one backend on", () => {
    const ollama: Partial<LlmConfig["ollama"]>[] = [];
    const openai: Partial<LlmConfig["openai"]>[] = [];
    const onDevice: Partial<LlmConfig["onDevice"]>[] = [];
    const host = mount(
      <LlmPanel llm={base} onListModels={never} onOllamaChange={(u) => ollama.push(u)} onOnDeviceChange={(u) => onDevice.push(u)} onOpenAiChange={(u) => openai.push(u)} saving={false} />,
    );
    expect(textInputs(host)).toHaveLength(0);
    const picker = host.querySelector("select") as HTMLSelectElement;
    expect(picker.value).toBe("off");

    act(() => {
      picker.value = "openai";
      picker.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(ollama).toEqual([{ enabled: false }]);
    expect(openai).toEqual([{ enabled: true }]);
    expect(onDevice).toEqual([{ enabled: false }]);
  });

  it("seeds the Ollama fields and funnels a model edit through onOllamaChange", () => {
    const updates: Partial<LlmConfig["ollama"]>[] = [];
    const host = mount(
      <LlmPanel
        llm={{ ...base, ollama: { ...base.ollama, enabled: true } }}
        onListModels={never}
        onOllamaChange={(update) => updates.push(update)}
        onOnDeviceChange={noop}
        onOpenAiChange={noop}
        saving={false}
      />,
    );
    expect(labelled(host, "Ollama address").value).toBe("http://localhost:11434");
    const model = labelled(host, "Model");
    expect(model.value).toBe("llama3");

    act(() => {
      model.value = "phi3";
      model.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(updates).toEqual([{ model: "phi3" }]);
  });

  it("for a chat service: a preset fills the address, the key field stays empty when a key is saved, and Clear key sends an empty string", () => {
    const updates: Partial<LlmConfig["openai"]>[] = [];
    const host = mount(
      <LlmPanel
        llm={{ ...base, openai: { ...base.openai, enabled: true, apiKeySet: true } }}
        onListModels={never}
        onOllamaChange={noop}
        onOnDeviceChange={noop}
        onOpenAiChange={(update) => updates.push(update)}
        saving={false}
      />,
    );
    const selects = Array.from(host.querySelectorAll("select")) as HTMLSelectElement[];
    expect(selects[1].value).toBe("openrouter");
    act(() => {
      selects[1].value = "lmstudio";
      selects[1].dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(updates).toEqual([{ baseUrl: "http://localhost:1234/v1" }]);

    const key = labelled(host, "API key");
    expect(key.type).toBe("password");
    expect(key.value).toBe("");
    expect(key.placeholder).toContain("A key is saved");
    // The note names the service the messages go to.
    expect(host.textContent).toContain("openrouter.ai");

    const clear = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Clear key");
    act(() => clear?.click());
    expect(updates.at(-1)).toEqual({ apiKey: "" });
  });

  it("Test connection asks the node with the typed connection, offers the models it finds, and words a refusal", async () => {
    const asked: LlmModelsRequest[] = [];
    let answer: LlmModelsResponse = { ok: true, models: ["a-model", "b-model"] };
    const host = mount(
      <LlmPanel
        llm={{ ...base, openai: { ...base.openai, enabled: true, apiKey: "sk-new" } }}
        onListModels={async (request) => {
          asked.push(request);
          return answer;
        }}
        onOllamaChange={noop}
        onOnDeviceChange={noop}
        onOpenAiChange={noop}
        saving={false}
      />,
    );
    const test = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Test connection") as HTMLButtonElement;
    act(() => test.click());
    await flush();
    expect(asked).toEqual([{ provider: "openai", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-new" }]);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("2 models found");
    expect(Array.from(host.querySelectorAll("datalist option")).map((option) => (option as HTMLOptionElement).value)).toEqual(["a-model", "b-model"]);

    answer = { ok: false, code: "llm_unauthorized" };
    act(() => test.click());
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("refused the key");
  });

  it("shows the on-device model field only for the on-device backend", () => {
    const off = mount(<LlmPanel llm={base} onListModels={never} onOllamaChange={noop} onOnDeviceChange={noop} onOpenAiChange={noop} saving={false} />);
    expect(off.textContent).not.toContain("On-device model name");
    const on = mount(
      <LlmPanel llm={{ ...base, onDevice: { enabled: true, model: "gemma" } }} onListModels={never} onOllamaChange={noop} onOnDeviceChange={noop} onOpenAiChange={noop} saving={false} />,
    );
    expect(labelled(on, "On-device model name").value).toBe("gemma");
    expect(labelled(on, "Assistant's name").value).toBe("Assistant");
  });
});
