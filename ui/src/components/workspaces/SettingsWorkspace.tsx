import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import HeaderBar from "../layout/HeaderBar";

// Types
interface SystemSettings {
  minMainContextTokens: number;
  summarizerContextTokens: number;
  maxContextCap: number;
  vramHeadroomGB: number;
  dynamicContextScaling: boolean;
  filterBelowMinContext: boolean;
  autoBootstrapOnStartup: boolean;
  autoLoadModels: boolean;
  autoLoadDelayMs: number;
}

interface ToolCallingSettings {
  enabled: boolean;
  mode: 'auto' | 'full' | 'core-only' | 'disabled';
  coreToolsAlways: boolean;
  writeToolsEnabled: boolean;
}

interface SettingsResponse {
  status: string;
  settings: SystemSettings;
  note?: string;
}

interface ToolConfigResponse {
  status: string;
  config: ToolCallingSettings;
  modes: string[];
  modeDescriptions: Record<string, string>;
}

// API functions
async function getSystemSettings(): Promise<SettingsResponse> {
  const res = await fetch("/api/system-settings");
  if (!res.ok) throw new Error("Failed to fetch settings");
  return res.json();
}

async function updateSystemSettings(settings: Partial<SystemSettings>): Promise<SettingsResponse> {
  const res = await fetch("/api/system-settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to update settings");
  }
  return res.json();
}

// Tool calling API functions
async function getToolConfig(): Promise<ToolConfigResponse> {
  const res = await fetch("/api/tools/config");
  if (!res.ok) throw new Error("Failed to fetch tool config");
  return res.json();
}

async function updateToolConfig(config: Partial<ToolCallingSettings>): Promise<{ status: string; config: ToolCallingSettings }> {
  const res = await fetch("/api/tools/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Failed to update tool config");
  }
  return res.json();
}

// Context presets for quick selection
const CONTEXT_PRESETS = [
  { label: "8K", value: 8192, desc: "Minimum viable" },
  { label: "16K", value: 16384, desc: "Recommended minimum" },
  { label: "24K", value: 24576, desc: "Good balance" },
  { label: "32K", value: 32768, desc: "Comfortable" },
  { label: "64K", value: 65536, desc: "Large context" },
  { label: "128K", value: 131072, desc: "Maximum" },
];

// Input component for numbers
function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix = "",
  description,
}: {
  label: string;
  value: number;
  onChange: (val: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  description?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-white/80">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          min={min}
          max={max}
          step={step}
          className="w-32 px-3 py-2 bg-gray-800 border border-white/20 rounded-lg text-white 
                     focus:outline-none focus:border-accent-primary/50"
        />
        {suffix && <span className="text-white/50 text-sm">{suffix}</span>}
      </div>
      {description && <p className="text-xs text-white/40">{description}</p>}
    </div>
  );
}

// Toggle switch component
function ToggleInput({
  label,
  checked,
  onChange,
  description,
}: {
  label: string;
  checked: boolean;
  onChange: (val: boolean) => void;
  description?: string;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <div>
        <span className="text-sm font-medium text-white/80">{label}</span>
        {description && <p className="text-xs text-white/40">{description}</p>}
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={clsx(
          "relative w-12 h-6 rounded-full transition-colors",
          checked ? "bg-accent-primary" : "bg-gray-600"
        )}
      >
        <span
          className={clsx(
            "absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform",
            checked && "translate-x-6"
          )}
        />
      </button>
    </div>
  );
}

// Tool mode options with descriptions
const TOOL_MODES = [
  { value: 'auto', label: 'Auto', desc: 'RAG + Read + Web tools', color: 'accent' },
  { value: 'full', label: 'Full', desc: 'All tools (includes write/execute)', color: 'orange' },
  { value: 'core-only', label: 'RAG + Read', desc: 'rag_search, file_read, file_list only', color: 'green' },
  { value: 'disabled', label: 'Disabled', desc: 'No tools injected', color: 'red' },
] as const;

export function SettingsWorkspace() {
  const queryClient = useQueryClient();
  const [localSettings, setLocalSettings] = useState<SystemSettings | null>(null);
  const [localToolSettings, setLocalToolSettings] = useState<ToolCallingSettings | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Fetch current settings
  const { data, isLoading, error } = useQuery({
    queryKey: ["system-settings"],
    queryFn: getSystemSettings,
  });

  // Fetch tool config
  const { data: toolData, isLoading: toolLoading } = useQuery({
    queryKey: ["tool-config"],
    queryFn: getToolConfig,
  });

  // Initialize local state when data loads
  useEffect(() => {
    if (data?.settings && !localSettings) {
      setLocalSettings(data.settings);
    }
  }, [data, localSettings]);

  // Initialize tool settings when data loads
  useEffect(() => {
    if (toolData?.config && !localToolSettings) {
      setLocalToolSettings(toolData.config);
    }
  }, [toolData, localToolSettings]);

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: updateSystemSettings,
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["system-settings"] });
      setHasChanges(false);
      setSaveMessage({ type: "success", text: res.note || "Settings saved successfully" });
      setTimeout(() => setSaveMessage(null), 5000);
    },
    onError: (err: Error) => {
      setSaveMessage({ type: "error", text: err.message });
      setTimeout(() => setSaveMessage(null), 5000);
    },
  });

  // Tool config save mutation
  const saveToolMutation = useMutation({
    mutationFn: updateToolConfig,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tool-config"] });
      setSaveMessage({ type: "success", text: "Tool settings saved" });
      setTimeout(() => setSaveMessage(null), 3000);
    },
    onError: (err: Error) => {
      setSaveMessage({ type: "error", text: err.message });
      setTimeout(() => setSaveMessage(null), 5000);
    },
  });

  // Update local setting
  const updateSetting = <K extends keyof SystemSettings>(key: K, value: SystemSettings[K]) => {
    if (!localSettings) return;
    setLocalSettings({ ...localSettings, [key]: value });
    setHasChanges(true);
  };

  // Update tool setting (auto-saves immediately)
  const updateToolSetting = <K extends keyof ToolCallingSettings>(key: K, value: ToolCallingSettings[K]) => {
    if (!localToolSettings) return;
    const updated = { ...localToolSettings, [key]: value };
    setLocalToolSettings(updated);
    // Auto-save tool settings immediately for better UX
    saveToolMutation.mutate({ [key]: value });
  };

  // Reset to defaults
  const resetToDefaults = () => {
    setLocalSettings({
      minMainContextTokens: 16384,
      summarizerContextTokens: 4096,
      maxContextCap: 131072,
      vramHeadroomGB: 1.5,
      dynamicContextScaling: true,
      filterBelowMinContext: true,
      autoBootstrapOnStartup: true,
      autoLoadModels: true,
      autoLoadDelayMs: 2000,
    });
    setHasChanges(true);
  };

  if (isLoading || toolLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900">
        <HeaderBar telemetry={null} />
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin h-8 w-8 border-2 border-accent-primary border-t-transparent rounded-full" />
        </div>
      </div>
    );
  }

  if (error || !localSettings) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900">
        <HeaderBar telemetry={null} />
        <div className="p-8 text-center text-red-400">
          Failed to load settings: {error?.message || "Unknown error"}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900">
      <HeaderBar telemetry={null} />
      
      <main className="max-w-4xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-3">
              <span className="text-3xl">⚙️</span>
              System Settings
            </h1>
            <p className="text-white/50 mt-1">Configure context limits, VRAM management, and model filtering</p>
          </div>
          
          <div className="flex items-center gap-3">
            <button
              onClick={resetToDefaults}
              className="px-4 py-2 text-sm text-white/70 hover:text-white border border-white/20 
                         hover:border-white/40 rounded-lg transition-colors"
            >
              Reset Defaults
            </button>
            <button
              onClick={() => saveMutation.mutate(localSettings)}
              disabled={!hasChanges || saveMutation.isPending}
              className={clsx(
                "px-6 py-2 rounded-lg font-medium transition-all",
                hasChanges
                  ? "bg-accent-primary text-white hover:bg-accent-primary/80"
                  : "bg-gray-700 text-white/40 cursor-not-allowed"
              )}
            >
              {saveMutation.isPending ? "Saving..." : "Save Settings"}
            </button>
          </div>
        </div>

        {/* Save message */}
        {saveMessage && (
          <div
            className={clsx(
              "p-4 rounded-lg",
              saveMessage.type === "success"
                ? "bg-green-900/30 border border-green-500/30 text-green-400"
                : "bg-red-900/30 border border-red-500/30 text-red-400"
            )}
          >
            {saveMessage.text}
          </div>
        )}

        {/* Context Configuration */}
        <section className="bg-white/5 rounded-xl border border-white/10 p-6 space-y-6">
          <div className="flex items-center gap-3">
            <span className="text-2xl">📊</span>
            <div>
              <h2 className="text-lg font-semibold text-white">Context Configuration</h2>
              <p className="text-sm text-white/50">Set minimum and maximum context window sizes</p>
            </div>
          </div>

          {/* Quick presets for min context */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/80">
              Minimum Main Model Context
            </label>
            <div className="flex flex-wrap gap-2">
              {CONTEXT_PRESETS.slice(0, 4).map((preset) => (
                <button
                  key={preset.value}
                  onClick={() => updateSetting("minMainContextTokens", preset.value)}
                  className={clsx(
                    "px-4 py-2 rounded-lg text-sm font-medium transition-all",
                    localSettings.minMainContextTokens === preset.value
                      ? "bg-accent-primary text-white"
                      : "bg-gray-700 text-white/70 hover:bg-gray-600"
                  )}
                >
                  <span className="block">{preset.label}</span>
                  <span className="block text-xs opacity-60">{preset.desc}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-white/40">
              Models with less than this context length will be excluded from the main model role
            </p>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <NumberInput
              label="Summarizer Context"
              value={localSettings.summarizerContextTokens}
              onChange={(v) => updateSetting("summarizerContextTokens", v)}
              min={1024}
              max={16384}
              step={1024}
              suffix="tokens"
              description="Fixed context size for summarization models"
            />

            <NumberInput
              label="Maximum Context Cap"
              value={localSettings.maxContextCap}
              onChange={(v) => updateSetting("maxContextCap", v)}
              min={16384}
              max={262144}
              step={8192}
              suffix="tokens"
              description="Upper limit even with dynamic scaling"
            />
          </div>
        </section>

        {/* Startup Behavior */}
        <section className="bg-white/5 rounded-xl border border-white/10 p-6 space-y-6">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🚀</span>
            <div>
              <h2 className="text-lg font-semibold text-white">Startup Behavior</h2>
              <p className="text-sm text-white/50">Configure how the app initializes at startup</p>
            </div>
          </div>

          <div className="space-y-4">
            <ToggleInput
              label="Auto-Bootstrap on Startup"
              checked={localSettings.autoBootstrapOnStartup}
              onChange={(v) => updateSetting("autoBootstrapOnStartup", v)}
              description="Automatically analyze models and build presets when the app starts (shows loading screen)"
            />

            <ToggleInput
              label="Auto-Load Models"
              checked={localSettings.autoLoadModels}
              onChange={(v) => updateSetting("autoLoadModels", v)}
              description="Automatically load the active preset's models after bootstrap completes"
            />

            <NumberInput
              label="Auto-Load Delay"
              value={localSettings.autoLoadDelayMs}
              onChange={(v) => updateSetting("autoLoadDelayMs", v)}
              min={500}
              max={10000}
              step={500}
              suffix="ms"
              description="Delay before auto-loading models (allows LM Studio to stabilize)"
            />
          </div>
        </section>

        {/* Tool Calling Settings */}
        {localToolSettings && (
          <section className="bg-white/5 rounded-xl border border-white/10 p-6 space-y-6">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🔧</span>
              <div>
                <h2 className="text-lg font-semibold text-white">Tool Calling</h2>
                <p className="text-sm text-white/50">Control which tools are available to the LLM</p>
              </div>
            </div>

            {/* Master Enable Toggle */}
            <ToggleInput
              label="Enable Tool Calling"
              checked={localToolSettings.enabled}
              onChange={(v) => updateToolSetting("enabled", v)}
              description="Master switch - disable to turn off all tool injection"
            />

            {/* Tool Mode Selector */}
            {localToolSettings.enabled && (
              <>
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-white/80">Tool Mode</label>
                  <div className="grid grid-cols-2 gap-2">
                    {TOOL_MODES.map((mode) => {
                      const isSelected = localToolSettings.mode === mode.value;
                      const colorClasses = {
                        green: isSelected ? "bg-green-500/20 border-green-500/50 text-green-300" : "",
                        orange: isSelected ? "bg-orange-500/20 border-orange-500/50 text-orange-300" : "",
                        red: isSelected ? "bg-red-500/20 border-red-500/50 text-red-300" : "",
                        accent: isSelected ? "bg-cyan-500/20 border-cyan-500/50 text-cyan-300" : "",
                      };
                      return (
                        <button
                          key={mode.value}
                          onClick={() => updateToolSetting("mode", mode.value)}
                          className={clsx(
                            "px-4 py-3 rounded-lg text-left transition-all border",
                            colorClasses[mode.color],
                            !isSelected && "bg-gray-700/50 border-white/10 text-white/70 hover:bg-gray-600/50"
                          )}
                        >
                          <span className="block font-medium">{mode.label}</span>
                          <span className="block text-xs opacity-70">{mode.desc}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-white/40 mt-2">
                    💡 <strong>RAG + Read</strong> is the safest option - gives LLM access to search your codebase and read files without any write permissions.
                  </p>
                </div>

                {/* Additional options */}
                <div className="border-t border-white/10 pt-4 space-y-2">
                  <ToggleInput
                    label="Always Parse Core Tools from Text"
                    checked={localToolSettings.coreToolsAlways}
                    onChange={(v) => updateToolSetting("coreToolsAlways", v)}
                    description="Parse rag_search, file_read, file_list from text output even if model doesn't support structured tool calls"
                  />

                  <ToggleInput
                    label="Enable Write Tools"
                    checked={localToolSettings.writeToolsEnabled}
                    onChange={(v) => updateToolSetting("writeToolsEnabled", v)}
                    description="⚠️ Dangerous: Enable file_write, file_patch, run_command, browser_automation"
                  />
                </div>

                {/* Tool Categories Legend */}
                <div className="bg-gray-800/50 rounded-lg p-4 space-y-2">
                  <div className="text-sm font-medium text-white/70 mb-2">Tool Categories:</div>
                  <div className="flex flex-wrap gap-3 text-xs">
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-full bg-green-500"></span>
                      <span className="text-white/60">Core (always safe)</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-full bg-blue-500"></span>
                      <span className="text-white/60">Standard (read-only)</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-full bg-orange-500"></span>
                      <span className="text-white/60">Write (dangerous)</span>
                    </span>
                  </div>
                </div>
              </>
            )}

            {saveToolMutation.isPending && (
              <div className="text-xs text-white/40">Saving...</div>
            )}
          </section>
        )}

        {/* Resource Management */}
        <section className="bg-white/5 rounded-xl border border-white/10 p-6 space-y-6">
          <div className="flex items-center gap-3">
            <span className="text-2xl">💾</span>
            <div>
              <h2 className="text-lg font-semibold text-white">Resource Management</h2>
              <p className="text-sm text-white/50">VRAM allocation and dynamic scaling</p>
            </div>
          </div>

          <NumberInput
            label="VRAM Headroom"
            value={localSettings.vramHeadroomGB}
            onChange={(v) => updateSetting("vramHeadroomGB", v)}
            min={0.5}
            max={8}
            step={0.5}
            suffix="GB"
            description="Reserved VRAM for OS and other applications"
          />

          <div className="border-t border-white/10 pt-4 space-y-2">
            <ToggleInput
              label="Dynamic Context Scaling"
              checked={localSettings.dynamicContextScaling}
              onChange={(v) => updateSetting("dynamicContextScaling", v)}
              description="Automatically increase context based on available VRAM"
            />

            <ToggleInput
              label="Filter Models Below Minimum"
              checked={localSettings.filterBelowMinContext}
              onChange={(v) => updateSetting("filterBelowMinContext", v)}
              description="Exclude models that don't meet minimum context from main role"
            />
          </div>
        </section>

        {/* Info Card */}
        <section className="bg-blue-900/20 rounded-xl border border-blue-500/30 p-6">
          <div className="flex gap-4">
            <span className="text-2xl">💡</span>
            <div className="space-y-2 text-sm text-blue-200/80">
              <p>
                <strong>Recommended settings for coding:</strong>
              </p>
              <ul className="list-disc list-inside space-y-1 text-blue-200/60">
                <li><strong>16K minimum</strong> - Ensures enough context for file contents + RAG</li>
                <li><strong>Dynamic scaling ON</strong> - Uses more context when VRAM allows</li>
                <li><strong>1.5GB headroom</strong> - Leaves room for OS and LM Studio overhead</li>
                <li><strong>4K summarizer</strong> - Sufficient for compression tasks</li>
              </ul>
              <p className="pt-2 text-blue-200/50">
                After changing settings, reload your preset to apply new context lengths.
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

