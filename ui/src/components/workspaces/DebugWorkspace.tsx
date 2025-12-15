import { Link } from "react-router-dom";
import { DebugPanel } from "../panels/DebugPanel";

export default function DebugWorkspace() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      {/* Breadcrumb */}
      <nav className="mb-6">
        <ol className="flex items-center space-x-2 text-sm">
          <li>
            <Link to="/" className="text-white/50 hover:text-white transition-colors">
              Dashboard
            </Link>
          </li>
          <li className="text-white/30">/</li>
          <li className="text-white">RAG Diagnostics</li>
        </ol>
      </nav>

      {/* Debug Panel */}
      <div className="bg-surface-panel rounded-xl border border-white/10">
        <DebugPanel />
      </div>
    </div>
  );
}

