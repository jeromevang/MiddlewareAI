import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Search, Settings, Play, Square, RefreshCw, Zap, Database, BarChart3 } from "lucide-react";
import { checkLMStudioHealth, startLMStudioServer, stopLMStudioServer } from "../../lib/api";

interface Command {
  id: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  action: () => void;
  category: string;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  // Get system state for dynamic commands
  // const status = useDashboardStore((s) => s.status); // Currently not used

  const commands: Command[] = [
    // Navigation
    {
      id: "nav-dashboard",
      title: "Go to Dashboard",
      description: "Return to main dashboard",
      icon: <Zap className="h-4 w-4" />,
      action: () => navigate("/"),
      category: "Navigation"
    },
    {
      id: "nav-config",
      title: "Open Configuration",
      description: "Access model and system settings",
      icon: <Settings className="h-4 w-4" />,
      action: () => navigate("/config"),
      category: "Navigation"
    },
    {
      id: "nav-summary",
      title: "View Summary Workspace",
      description: "Monitor conversation summaries",
      icon: <BarChart3 className="h-4 w-4" />,
      action: () => navigate("/summary"),
      category: "Navigation"
    },

    // LM Studio Actions
    {
      id: "lmstudio-start",
      title: "Start LM Studio Server",
      description: "Launch LM Studio server if not running",
      icon: <Play className="h-4 w-4" />,
      action: async () => {
        try {
          await startLMStudioServer();
          // Could add toast notification here
        } catch (error) {
          console.error("Failed to start LM Studio:", error);
        }
      },
      category: "LM Studio"
    },
    {
      id: "lmstudio-stop",
      title: "Stop LM Studio Server",
      description: "Shut down LM Studio server",
      icon: <Square className="h-4 w-4" />,
      action: async () => {
        try {
          await stopLMStudioServer();
        } catch (error) {
          console.error("Failed to stop LM Studio:", error);
        }
      },
      category: "LM Studio"
    },
    {
      id: "lmstudio-health",
      title: "Check LM Studio Health",
      description: "Refresh system status and health checks",
      icon: <RefreshCw className="h-4 w-4" />,
      action: async () => {
        try {
          await checkLMStudioHealth();
        } catch (error) {
          console.error("Health check failed:", error);
        }
      },
      category: "LM Studio"
    },

    // System Actions
    {
      id: "system-refresh",
      title: "Refresh Dashboard",
      description: "Reload the entire dashboard",
      icon: <RefreshCw className="h-4 w-4" />,
      action: () => window.location.reload(),
      category: "System"
    },
    {
      id: "system-metrics",
      title: "View System Metrics",
      description: "Access detailed performance metrics",
      icon: <Database className="h-4 w-4" />,
      action: () => navigate("/summary"),
      category: "System"
    }
  ];

  // Filter commands based on search
  const filteredCommands = commands.filter(cmd =>
    cmd.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    cmd.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
    cmd.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Group commands by category
  const groupedCommands = filteredCommands.reduce((acc, cmd) => {
    if (!acc[cmd.category]) acc[cmd.category] = [];
    acc[cmd.category].push(cmd);
    return acc;
  }, {} as Record<string, Command[]>);

  // Handle keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev =>
          prev < filteredCommands.length - 1 ? prev + 1 : prev
        );
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => prev > 0 ? prev - 1 : prev);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filteredCommands[selectedIndex]) {
          filteredCommands[selectedIndex].action();
          onClose();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex, filteredCommands, onClose]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Reset state when opened
  useEffect(() => {
    if (isOpen) {
      setSearchQuery("");
      setSelectedIndex(0);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Command Palette */}
      <div
        className="relative w-full max-w-2xl bg-night-900/95 backdrop-blur-2xl border border-white/20 rounded-2xl shadow-2xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        aria-describedby="command-palette-description"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-white/10">
          <h2 id="command-palette-title" className="text-lg font-semibold text-white sr-only">Command Palette</h2>
        </div>

        {/* Search Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10">
          <Search className="h-5 w-5 text-white/60" aria-hidden="true" />
          <div id="command-palette-description" className="sr-only">
            Search for commands or navigate with arrow keys. Press Enter to execute, Escape to close.
          </div>
          <label htmlFor="command-search" className="sr-only">Search commands</label>
          <input
            id="command-search"
            ref={inputRef}
            type="text"
            placeholder="Type a command or search..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSelectedIndex(0); // Reset selection when searching
            }}
            className="flex-1 bg-transparent text-white placeholder-white/60 outline-none text-lg"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck="false"
          />
          <div className="text-xs text-white/40 bg-white/10 px-2 py-1 rounded" aria-hidden="true">
            ESC to close
          </div>
        </div>

        {/* Commands List */}
        <div className="max-h-96 overflow-y-auto">
          {Object.entries(groupedCommands).map(([category, categoryCommands]) => (
            <div key={category}>
              <div className="px-4 py-2 text-xs font-semibold text-white/60 uppercase tracking-wider bg-white/5">
                {category}
              </div>
              {categoryCommands.map((command) => {
                const globalIndex = filteredCommands.findIndex(cmd => cmd.id === command.id);
                const isSelected = globalIndex === selectedIndex;

                return (
                  <div
                    key={command.id}
                    className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition ${
                      isSelected
                        ? 'bg-accent-primary/20 text-white'
                        : 'text-white/80 hover:bg-white/10 hover:text-white'
                    }`}
                    onClick={() => {
                      command.action();
                      onClose();
                    }}
                    role="option"
                    aria-selected={isSelected}
                    aria-label={`${command.title}: ${command.description}`}
                  >
                    <div className={`p-1 rounded ${isSelected ? 'bg-accent-primary/30' : 'bg-white/10'}`}>
                      {command.icon}
                    </div>
                    <div className="flex-1">
                      <div className="font-medium">{command.title}</div>
                      <div className="text-sm text-white/60">{command.description}</div>
                    </div>
                    {isSelected && (
                      <div className="text-accent-primary text-sm">↵</div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {filteredCommands.length === 0 && (
            <div className="px-4 py-8 text-center text-white/60">
              No commands found for "{searchQuery}"
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-white/10 bg-white/5">
          <div className="flex justify-between text-xs text-white/50">
            <div>
              <kbd className="px-1.5 py-0.5 bg-white/10 rounded text-xs">↑↓</kbd> Navigate •
              <kbd className="px-1.5 py-0.5 bg-white/10 rounded text-xs ml-1">↵</kbd> Select •
              <kbd className="px-1.5 py-0.5 bg-white/10 rounded text-xs ml-1">ESC</kbd> Close
            </div>
            <div>{filteredCommands.length} commands</div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}