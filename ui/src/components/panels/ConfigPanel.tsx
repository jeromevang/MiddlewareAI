import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { saveConfig } from "../../lib/api";
import { useDashboardStore } from "../../state/dashboard-store";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";

type ModelKey = "embedding" | "summarization" | "main";

interface ModelDraft {
  engine?: string;
  modelName: string;
  identifier: string;
  contextLength: string;
}

interface ModelConfig {
  engine?: string;
  model_name?: string;
  identifier?: string;
  context_length?: number;
}

interface RuntimeConfig {
  mode?: string;
  mode_switch?: Record<string, unknown>;
  cloud_main?: {
    base_url?: string;
    model?: string;
    api_key?: string;
  };
}

type ConfigSnapshot = Record<string, unknown> & {
  runtime?: RuntimeConfig;
  models?: {
    embedding?: ModelConfig;
    summarization?: ModelConfig;
    main?: ModelConfig;
  };
};

const EMPTY_MODELS: Record<ModelKey, ModelDraft> = {
  embedding: { engine: "local", modelName: "", identifier: "", contextLength: "" },
  summarization: { modelName: "", identifier: "", contextLength: "" },
  main: { modelName: "", identifier: "", contextLength: "" },
};

function pickNumber(value: string, fallback?: number) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return typeof fallback === "number" ? fallback : undefined;
}

function asString(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value);
}

interface ConfigPanelProps {
  className?: string;
}

export default function ConfigPanel({ className }: ConfigPanelProps) {
  const status = useDashboardStore((s) => s.status);
  const config = (status?.config as ConfigSnapshot) ?? null;
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null);
  const [runtimeMode, setRuntimeMode] = useState("local");
  const [cloudBaseUrl, setCloudBaseUrl] = useState("");
  const [cloudModel, setCloudModel] = useState("");
  const [cloudApiKey, setCloudApiKey] = useState("");
  const [models, setModels] = useState<Record<ModelKey, ModelDraft>>(EMPTY_MODELS);
  const [message, setMessage] = useState("Waiting for config snapshot…");

  useEffect(() => {
    if (!config) return;
    setSnapshot(config);
    setRuntimeMode(asString(config.runtime?.mode || "local"));
    setCloudBaseUrl(asString(config.runtime?.cloud_main?.base_url));
    setCloudModel(asString(config.runtime?.cloud_main?.model));
    setCloudApiKey("");
    setModels({
      embedding: {
        engine: asString(config.models?.embedding?.engine || "local"),
        modelName: asString(config.models?.embedding?.model_name),
        identifier: asString(config.models?.embedding?.identifier),
        contextLength: asString(config.models?.embedding?.context_length ?? ""),
      },
      summarization: {
        modelName: asString(config.models?.summarization?.model_name),
        identifier: asString(config.models?.summarization?.identifier),
        contextLength: asString(config.models?.summarization?.context_length ?? ""),
      },
      main: {
        modelName: asString(config.models?.main?.model_name),
        identifier: asString(config.models?.main?.identifier),
        contextLength: asString(config.models?.main?.context_length ?? ""),
      },
    });
    setMessage("Config loaded from /status. Save to persist changes.");
  }, [config]);

  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => saveConfig(payload),
    onSuccess: () => {
      setMessage("Saved. Restart the middleware server to apply changes.");
      setCloudApiKey("");
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : "Save failed.";
      setMessage(detail);
    },
  });

  const runtimeSummary = useMemo(() => {
    if (!status) return "Mode unknown";
    const modeLabel = status.runtime.mode ? status.runtime.mode.toUpperCase() : "LOCAL";
    return `${modeLabel} · RAG ${status.runtime.rag_enabled ? "on" : "off"}`;
  }, [status]);

  const handleModelChange = (key: ModelKey, field: keyof ModelDraft, value: string) => {
    setModels((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        [field]: value,
      },
    }));
  };

  const getBaseModel = (key: ModelKey): ModelConfig => {
    const modelsRef = snapshot?.models || {};
    if (key === "embedding") return modelsRef.embedding || {};
    if (key === "summarization") return modelsRef.summarization || {};
    return modelsRef.main || {};
  };

  const buildModelPayload = (key: ModelKey) => {
    const base = getBaseModel(key);
    const draft = models[key];
    const payload: Record<string, unknown> = {
      model_name: draft.modelName.trim(),
      identifier: draft.identifier.trim(),
    };
    const baseContext = typeof base.context_length === "number" ? (base.context_length as number) : undefined;
    const context = pickNumber(draft.contextLength, baseContext);
    if (typeof context === "number") {
      payload.context_length = context;
    }
    if (key === "embedding") {
      payload.engine = draft.engine?.trim() || (base.engine as string) || "local";
    }
    return payload;
  };

  const handleSave = () => {
    if (!snapshot) {
      setMessage("Config not available yet. Wait for the next /status snapshot.");
      return;
    }
    setMessage("Saving changes…");
    const runtimePatch: Record<string, unknown> = {
      mode: runtimeMode || snapshot.runtime?.mode || "local",
    };
    if (snapshot.runtime?.mode_switch) {
      runtimePatch.mode_switch = snapshot.runtime.mode_switch;
    }
    const cloudPatch: Record<string, unknown> = {
      base_url: cloudBaseUrl.trim(),
      model: cloudModel.trim(),
    };
    const apiKey = cloudApiKey.trim();
    if (apiKey) {
      cloudPatch.api_key = apiKey;
    }
    if (Object.keys(cloudPatch).length) {
      runtimePatch.cloud_main = cloudPatch;
    }

    const modelsPayload = {
      embedding: buildModelPayload("embedding"),
      summarization: buildModelPayload("summarization"),
      main: buildModelPayload("main"),
    };

    mutation.mutate({ runtime: runtimePatch, models: modelsPayload });
  };

  const isCloud = runtimeMode === "cloud";

  return (
    <Card title="Runtime & Models" subtitle={runtimeSummary} className={className}>
      <div className="grid gap-4 lg:grid-cols-4">
        <div className="flex flex-col gap-2">
          <label className="stat-label">Runtime mode</label>
          <select
            value={runtimeMode}
            onChange={(e) => setRuntimeMode(e.target.value)}
            className="rounded-xl border border-night-800 bg-night-900 px-3 py-2 text-sm text-slate-100"
          >
            <option value="local">Local</option>
            <option value="cloud">Cloud</option>
          </select>
        </div>
        <div className="flex flex-col gap-2">
          <label className="stat-label">Cloud model</label>
          <input
            value={cloudModel}
            onChange={(e) => setCloudModel(e.target.value)}
            className="rounded-xl border border-night-800 bg-night-900 px-3 py-2 text-sm text-slate-100"
            placeholder="gpt-4o-mini"
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="stat-label">Cloud base URL</label>
          <input
            value={cloudBaseUrl}
            onChange={(e) => setCloudBaseUrl(e.target.value)}
            className="rounded-xl border border-night-800 bg-night-900 px-3 py-2 text-sm text-slate-100"
            placeholder="https://api.openai.com/v1"
          />
        </div>
        {isCloud && (
          <div className="flex flex-col gap-2">
            <label className="stat-label">Cloud API key</label>
            <input
              type="password"
              value={cloudApiKey}
              onChange={(e) => setCloudApiKey(e.target.value)}
              className="rounded-xl border border-night-800 bg-night-900 px-3 py-2 text-sm text-slate-100"
              placeholder="Leave blank to keep saved key"
            />
          </div>
        )}
      </div>

      <div className="grid gap-4 pt-4 lg:grid-cols-3">
        {(["embedding", "summarization", "main"] as ModelKey[]).map((modelKey) => {
          const draft = models[modelKey];
          const title = modelKey === "main" ? "Main" : modelKey.charAt(0).toUpperCase() + modelKey.slice(1);
          return (
            <div key={modelKey} className="rounded-2xl border border-night-900 bg-night-950/60 p-4 space-y-3">
              <div>
                <p className="text-sm font-semibold text-white">{title}</p>
                <p className="text-xs text-slate-500">{modelKey === "embedding" ? "Embeddings" : modelKey === "summarization" ? "Summarizer" : "Primary LLM"}</p>
              </div>
              {modelKey === "embedding" && (
                <div className="flex flex-col gap-1">
                  <label className="stat-label">Engine</label>
                  <select
                    value={draft.engine}
                    onChange={(e) => handleModelChange(modelKey, "engine", e.target.value)}
                    className="rounded-xl border border-night-800 bg-night-900 px-3 py-2 text-sm text-slate-100"
                  >
                    <option value="local">Local (CPU)</option>
                    <option value="lmstudio">LM Studio</option>
                    <option value="cloud">Cloud</option>
                  </select>
                </div>
              )}
              <div className="flex flex-col gap-1">
                <label className="stat-label">Model name</label>
                <input
                  value={draft.modelName}
                  onChange={(e) => handleModelChange(modelKey, "modelName", e.target.value)}
                  className="rounded-xl border border-night-800 bg-night-900 px-3 py-2 text-sm text-slate-100"
                  placeholder="Repository or GGUF"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="stat-label">Identifier</label>
                <input
                  value={draft.identifier}
                  onChange={(e) => handleModelChange(modelKey, "identifier", e.target.value)}
                  className="rounded-xl border border-night-800 bg-night-900 px-3 py-2 text-sm text-slate-100"
                  placeholder="Short handle"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="stat-label">Context length</label>
                <input
                  value={draft.contextLength}
                  onChange={(e) => handleModelChange(modelKey, "contextLength", e.target.value)}
                  className="rounded-xl border border-night-800 bg-night-900 px-3 py-2 text-sm text-slate-100"
                  type="number"
                  min={1}
                  placeholder="Tokens"
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-night-900 pt-4">
        <Button onClick={handleSave} loading={mutation.isPending} disabled={!snapshot}>
          Save runtime + models
        </Button>
        <p className="text-sm text-slate-400">{message}</p>
      </div>
    </Card>
  );
}
