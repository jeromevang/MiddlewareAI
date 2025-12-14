import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "../ui/Button";
import ModelConfigPanel from "../panels/ModelConfigPanel";

export default function ConfigWorkspace() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6">
      <header className="space-y-2">
        <Button
          variant="ghost"
          icon={<ArrowLeft className="h-4 w-4" />}
          onClick={() => navigate("/")}
          className="mb-4"
        >
          Back to Dashboard
        </Button>
        <p className="stat-label">Configuration</p>
        <h1 className="text-3xl font-semibold text-white">Model & System Settings</h1>
        <p className="text-white/70">
          Configure your AI models, quality presets, and cloud integrations for optimal performance.
        </p>
      </header>

      <ModelConfigPanel />
    </div>
  );
}