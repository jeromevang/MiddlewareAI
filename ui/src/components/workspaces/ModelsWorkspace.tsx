import { useNavigate } from "react-router-dom";
import { ArrowLeft, HardDrive } from "lucide-react";
import { Button } from "../ui/Button";
import { ModelManagementPanel } from "../panels/ModelManagementPanel";

export default function ModelsWorkspace() {
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
        <div className="flex items-center gap-3">
          <div className="p-2 bg-cyan-500/20 rounded-lg">
            <HardDrive className="h-6 w-6 text-cyan-400" />
          </div>
          <div>
            <p className="stat-label">Model Management</p>
            <h1 className="text-3xl font-semibold text-white">Downloaded Models</h1>
          </div>
        </div>
        <p className="text-white/70">
          View and manage all downloaded models. Lock models to prevent them from being removed during bootstrap re-analysis.
        </p>
      </header>

      <ModelManagementPanel />
    </div>
  );
}

