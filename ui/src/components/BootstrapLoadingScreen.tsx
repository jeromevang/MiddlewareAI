/**
 * Bootstrap Loading Screen
 * 
 * Full-screen blocking loading screen shown during app startup
 * while the bootstrap process runs (model discovery, analysis, preset building)
 */

import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, CheckCircle, AlertCircle, Server } from 'lucide-react';

export type BootstrapPhase = 
  | 'connecting' 
  | 'waiting-lmstudio'
  | 'discovering' 
  | 'analyzing' 
  | 'building' 
  | 'loading' 
  | 'complete'
  | 'error';

export interface BootstrapStatus {
  phase: BootstrapPhase;
  progress: number;
  message: string;
  currentModel?: string;
  modelsAnalyzed?: number;
  totalModels?: number;
  error?: string;
  retryCount?: number;
}

const phaseConfig: Record<BootstrapPhase, { label: string; icon: 'loader' | 'check' | 'error' | 'server' }> = {
  'connecting': { label: 'Connecting to LM Studio...', icon: 'loader' },
  'waiting-lmstudio': { label: 'Waiting for LM Studio...', icon: 'server' },
  'discovering': { label: 'Discovering models...', icon: 'loader' },
  'analyzing': { label: 'Analyzing capabilities...', icon: 'loader' },
  'building': { label: 'Building presets...', icon: 'loader' },
  'loading': { label: 'Loading models...', icon: 'loader' },
  'complete': { label: 'Ready!', icon: 'check' },
  'error': { label: 'Error', icon: 'error' },
};

interface BootstrapLoadingScreenProps {
  status: BootstrapStatus;
  onRetry?: () => void;
  onSkip?: () => void;
  canSkip?: boolean;
}

export function BootstrapLoadingScreen({ 
  status, 
  onRetry,
  onSkip,
  canSkip = false 
}: BootstrapLoadingScreenProps) {
  const config = phaseConfig[status.phase];
  const isWaiting = status.phase === 'waiting-lmstudio';
  const isError = status.phase === 'error';
  const isComplete = status.phase === 'complete';

  return (
    <div className="fixed inset-0 bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950 flex items-center justify-center z-50">
      {/* Background pattern */}
      <div className="absolute inset-0 opacity-5">
        <div className="absolute inset-0" style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, white 1px, transparent 0)`,
          backgroundSize: '40px 40px'
        }} />
      </div>

      <div className="relative max-w-lg w-full mx-6 text-center">
        {/* Logo/Brand */}
        <motion.div
          initial={{ opacity: 0, y: -30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          className="mb-10"
        >
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-cyan-500 to-blue-600 mb-6 shadow-lg shadow-cyan-500/20">
            <svg className="w-10 h-10 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">
            LM Studio Middleware
          </h1>
          <p className="text-white/50 text-sm">
            Preparing your AI environment
          </p>
        </motion.div>

        {/* Progress Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="space-y-6"
        >
          {/* Progress Bar */}
          {!isError && (
            <div className="px-4">
              <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 rounded-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${status.progress}%` }}
                  transition={{ duration: 0.4, ease: 'easeOut' }}
                />
              </div>
              <div className="mt-2 flex justify-between text-xs text-white/40">
                <span>{status.progress}%</span>
                {status.modelsAnalyzed !== undefined && status.totalModels !== undefined && (
                  <span>{status.modelsAnalyzed} / {status.totalModels} models</span>
                )}
              </div>
            </div>
          )}

          {/* Phase Status */}
          <AnimatePresence mode="wait">
            <motion.div
              key={status.phase}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3 }}
              className="space-y-3"
            >
              {/* Phase Icon & Label */}
              <div className="flex items-center justify-center gap-3">
                {config.icon === 'loader' && (
                  <Loader2 className="w-5 h-5 text-cyan-400 animate-spin" />
                )}
                {config.icon === 'server' && (
                  <Server className="w-5 h-5 text-amber-400 animate-pulse" />
                )}
                {config.icon === 'check' && (
                  <CheckCircle className="w-5 h-5 text-green-400" />
                )}
                {config.icon === 'error' && (
                  <AlertCircle className="w-5 h-5 text-red-400" />
                )}
                <span className={`text-lg font-medium ${
                  isComplete ? 'text-green-400' : 
                  isError ? 'text-red-400' : 
                  isWaiting ? 'text-amber-400' :
                  'text-white'
                }`}>
                  {config.label}
                </span>
              </div>

              {/* Status Message */}
              <p className="text-sm text-white/60">
                {status.message}
              </p>

              {/* Current Model */}
              {status.currentModel && (
                <div className="mt-4 px-4 py-2 bg-white/5 rounded-lg border border-white/10">
                  <p className="text-xs text-white/40 mb-1">Processing</p>
                  <p className="text-sm text-cyan-400 font-mono truncate">
                    {status.currentModel}
                  </p>
                </div>
              )}

              {/* Waiting for LM Studio */}
              {isWaiting && (
                <div className="mt-6 p-4 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                  <p className="text-sm text-amber-200 mb-2">
                    Please start LM Studio to continue
                  </p>
                  {status.retryCount !== undefined && (
                    <p className="text-xs text-amber-200/60">
                      Retry attempt: {status.retryCount}
                    </p>
                  )}
                </div>
              )}

              {/* Error State */}
              {isError && status.error && (
                <div className="mt-4 p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
                  <p className="text-sm text-red-200">
                    {status.error}
                  </p>
                  {onRetry && (
                    <button
                      onClick={onRetry}
                      className="mt-3 px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-200 rounded-lg text-sm transition-colors"
                    >
                      Try Again
                    </button>
                  )}
                </div>
              )}
            </motion.div>
          </AnimatePresence>

          {/* Skip Button (if enabled in settings) */}
          {canSkip && !isComplete && !isError && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 5 }}
              className="pt-6"
            >
              <button
                onClick={onSkip}
                className="text-sm text-white/40 hover:text-white/60 transition-colors"
              >
                Skip startup check
              </button>
            </motion.div>
          )}
        </motion.div>

        {/* Animated Dots (while loading) */}
        {!isComplete && !isError && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
            className="flex justify-center gap-1.5 mt-10"
          >
            {[0, 1, 2].map((i) => (
              <motion.div
                key={i}
                className="w-1.5 h-1.5 bg-cyan-500/60 rounded-full"
                animate={{ 
                  opacity: [0.3, 1, 0.3],
                  scale: [0.8, 1, 0.8]
                }}
                transition={{ 
                  duration: 1.2, 
                  repeat: Infinity, 
                  delay: i * 0.15,
                  ease: 'easeInOut'
                }}
              />
            ))}
          </motion.div>
        )}
      </div>
    </div>
  );
}

export default BootstrapLoadingScreen;

