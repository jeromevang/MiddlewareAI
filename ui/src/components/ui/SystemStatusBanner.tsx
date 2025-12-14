import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useDashboardStore } from "../../state/dashboard-store";
import { checkLMStudioHealth } from "../../lib/api";

interface StatusItem {
  name: string;
  status: 'online' | 'starting' | 'error' | 'offline' | 'disabled';
  metric?: string;
  details?: string;
}

export function SystemStatusBanner() {
  const status = useDashboardStore((s) => s.status);
  const [lmStudioStatus, setLMStudioStatus] = useState<StatusItem>({
    name: 'LM Studio',
    status: 'offline',
    metric: 'Checking...'
  });
  const [showDetails, setShowDetails] = useState(false);

  // Check LM Studio status on mount and periodically
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const health = await checkLMStudioHealth();
        setLMStudioStatus({
          name: 'LM Studio',
          status: health.ready ? 'online' : health.error ? 'error' : 'offline',
          metric: health.ready ? `${health.models_loaded} models` : 'Offline',
          details: health.error || undefined
        });
      } catch (error) {
        setLMStudioStatus({
          name: 'LM Studio',
          status: 'error',
          metric: 'Connection failed',
          details: 'Unable to connect to LM Studio server'
        });
      }
    };

    checkStatus();
    const interval = setInterval(checkStatus, 30000); // Check every 30 seconds
    return () => clearInterval(interval);
  }, []);

  const statusItems: StatusItem[] = [
    lmStudioStatus,
    {
      name: 'RAG Engine',
      status: status?.engines?.rag?.enabled ? 'online' : 'disabled',
      metric: status?.storage?.faiss_entries ? `${status.storage.faiss_entries.toLocaleString()} chunks` : 'No data'
    },
    {
      name: 'Rolling Summary',
      status: status?.engines?.summary?.enabled ? 'online' : 'disabled',
      metric: status?.processing?.summary_keep_recent_turns ? `${status.processing.summary_keep_recent_turns} turns` : 'Disabled'
    },
    {
      name: 'API Server',
      status: 'online',
      metric: `${status?.metrics?.totalRequests || 0} requests`
    }
  ];

  const getStatusColor = (status: StatusItem['status']) => {
    switch (status) {
      case 'online': return 'text-green-400 bg-green-400/10 border-green-400/20';
      case 'starting': return 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20';
      case 'error': return 'text-red-400 bg-red-400/10 border-red-400/20';
      case 'offline': return 'text-gray-400 bg-gray-400/10 border-gray-400/20';
      case 'disabled': return 'text-gray-500 bg-gray-500/10 border-gray-500/20';
      default: return 'text-gray-400 bg-gray-400/10 border-gray-400/20';
    }
  };

  const getStatusIcon = (status: StatusItem['status']) => {
    switch (status) {
      case 'online': return '🟢';
      case 'starting': return '🟡';
      case 'error': return '🔴';
      case 'offline': return '⚪';
      case 'disabled': return '⚫';
      default: return '⚪';
    }
  };

  return (
    <div className="w-full max-w-6xl mx-auto mb-6">
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-3">
          <button
            id="system-status-header"
            onClick={() => setShowDetails(!showDetails)}
            aria-expanded={showDetails}
            aria-controls="system-status-details"
            aria-label={`${showDetails ? 'Collapse' : 'Expand'} system status details`}
            className="flex items-center gap-2 text-sm font-semibold text-white hover:text-white/80 transition cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent-secondary focus:ring-offset-2 focus:ring-offset-night-950 rounded"
          >
            <span className="text-lg" aria-hidden="true">🚀</span>
            System Status
            {showDetails ?
              <ChevronUp className="h-4 w-4" aria-hidden="true" /> :
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            }
          </button>
          <div className="text-xs text-white/60">
            Auto-refreshing • Last updated: {new Date().toLocaleTimeString()}
          </div>
        </div>

        {showDetails && (
          <div id="system-status-details" role="region" aria-labelledby="system-status-header">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              {statusItems.map((item) => (
                <div
                  key={item.name}
                  className={`p-3 sm:p-4 rounded-lg border transition-all touch-manipulation ${getStatusColor(item.status)}`}
                  title={item.details}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm">{getStatusIcon(item.status)}</span>
                    <span className="text-xs font-medium text-white/80 truncate">{item.name}</span>
                  </div>
                  <div className="text-sm font-semibold text-white truncate">{item.metric}</div>
                  {item.details && (
                    <div className="text-xs text-white/60 mt-1 truncate" title={item.details}>
                      {item.details}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Quick Actions Row */}
            <div className="pt-3 border-t border-white/10">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Quick actions">
                <button
                  className="text-xs px-3 py-1 bg-white/10 hover:bg-white/20 rounded text-white/80 transition focus:outline-none focus:ring-2 focus:ring-accent-secondary focus:ring-offset-2 focus:ring-offset-night-950"
                  aria-label="Refresh all system status"
                >
                  🔄 Refresh All
                </button>
                <button
                  className="text-xs px-3 py-1 bg-white/10 hover:bg-white/20 rounded text-white/80 transition focus:outline-none focus:ring-2 focus:ring-accent-secondary focus:ring-offset-2 focus:ring-offset-night-950"
                  aria-label="View system metrics"
                >
                  📊 View Metrics
                </button>
                <button
                  className="text-xs px-3 py-1 bg-white/10 hover:bg-white/20 rounded text-white/80 transition focus:outline-none focus:ring-2 focus:ring-accent-secondary focus:ring-offset-2 focus:ring-offset-night-950"
                  aria-label="Open quick configuration"
                >
                  ⚙️ Quick Config
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}