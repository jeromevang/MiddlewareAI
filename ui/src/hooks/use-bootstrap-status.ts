/**
 * Bootstrap Status Hook
 * 
 * Connects to WebSocket and polls for bootstrap status during app startup.
 * Handles the blocking loading screen state.
 */

import { useEffect, useState, useCallback } from 'react';
import type { BootstrapStatus, BootstrapPhase } from '../components/BootstrapLoadingScreen';

interface UseBootstrapStatusOptions {
  enabled?: boolean;
  onComplete?: () => void;
  onError?: (error: string) => void;
}

const INITIAL_STATUS: BootstrapStatus = {
  phase: 'connecting',
  progress: 0,
  message: 'Initializing...',
};

export function useBootstrapStatus(options: UseBootstrapStatusOptions = {}) {
  const { enabled = true, onComplete, onError } = options;
  
  const [status, setStatus] = useState<BootstrapStatus>(INITIAL_STATUS);
  const [isComplete, setIsComplete] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);

  // Poll for bootstrap status (fallback when WebSocket message not received)
  const pollBootstrapStatus = useCallback(async () => {
    try {
      const res = await fetch('/models/bootstrap-status');
      if (!res.ok) throw new Error('Failed to fetch bootstrap status');
      
      const data = await res.json();
      
      // Map API response to our status format
      const mappedStatus: BootstrapStatus = {
        phase: mapPhase(data.message || '', data.running, data.progress),
        progress: data.progress || 0,
        message: data.message || '',
        modelsAnalyzed: data.modelsAnalyzed,
        totalModels: data.totalModels,
        currentModel: data.currentModel,
        error: data.error,
      };
      
      setStatus(mappedStatus);
      
      if (data.progress >= 100 || mappedStatus.phase === 'complete') {
        setIsComplete(true);
        onComplete?.();
      }
      
      if (data.error) {
        onError?.(data.error);
      }
      
      return mappedStatus;
    } catch (error) {
      console.error('[Bootstrap] Failed to poll status:', error);
      return null;
    }
  }, [onComplete, onError]);

  // Check LM Studio connection
  const checkLMStudioConnection = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/lmstudio/health');
      if (!res.ok) return false;
      const data = await res.json();
      return data.connected === true || data.status === 'healthy';
    } catch {
      return false;
    }
  }, []);

  // Main effect - handles startup flow
  useEffect(() => {
    if (!enabled) return;

    let mounted = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;

    const runStartupFlow = async () => {
      // Phase 1: Check LM Studio connection
      setStatus({
        phase: 'connecting',
        progress: 5,
        message: 'Checking LM Studio connection...',
      });

      let lmConnected = await checkLMStudioConnection();
      
      // Retry loop for LM Studio connection
      while (!lmConnected && mounted) {
        retryCount++;
        setStatus({
          phase: 'waiting-lmstudio',
          progress: 5,
          message: 'Please start LM Studio to continue...',
          retryCount,
        });
        
        // Wait 3 seconds before retry
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        if (!mounted) return;
        lmConnected = await checkLMStudioConnection();
      }

      if (!mounted) return;

      // Phase 2: LM Studio connected, start polling bootstrap status
      setStatus({
        phase: 'discovering',
        progress: 10,
        message: 'LM Studio connected. Discovering models...',
      });

      // Poll for bootstrap status every second until complete
      const pollLoop = async () => {
        if (!mounted) return;
        
        const result = await pollBootstrapStatus();
        
        if (result && result.phase !== 'complete' && result.phase !== 'error') {
          pollTimer = setTimeout(pollLoop, 1000);
        }
      };

      await pollLoop();
    };

    runStartupFlow();

    return () => {
      mounted = false;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [enabled, pollBootstrapStatus, checkLMStudioConnection]);

  // WebSocket listener for real-time updates
  useEffect(() => {
    if (!enabled) return;

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);

    ws.onopen = () => {
      setWsConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'bootstrap-status' && data.status) {
          const wsStatus: BootstrapStatus = {
            phase: data.status.phase || mapPhase(data.status.message || '', data.status.running, data.status.progress),
            progress: data.status.progress || 0,
            message: data.status.message || '',
            currentModel: data.status.currentModel,
            modelsAnalyzed: data.status.modelsAnalyzed,
            totalModels: data.status.totalModels,
            error: data.status.error,
          };
          
          setStatus(wsStatus);
          
          if (wsStatus.phase === 'complete') {
            setIsComplete(true);
            onComplete?.();
          }
          
          if (wsStatus.phase === 'error' && wsStatus.error) {
            onError?.(wsStatus.error);
          }
        }
      } catch (err) {
        console.error('[Bootstrap WS] Failed to parse message:', err);
      }
    };

    ws.onclose = () => {
      setWsConnected(false);
    };

    return () => {
      ws.close();
    };
  }, [enabled, onComplete, onError]);

  const retry = useCallback(async () => {
    setStatus(INITIAL_STATUS);
    setIsComplete(false);
    
    // Trigger bootstrap restart
    try {
      await fetch('/models/bootstrap', { method: 'POST' });
    } catch (error) {
      console.error('[Bootstrap] Failed to restart:', error);
    }
  }, []);

  const skip = useCallback(() => {
    setIsComplete(true);
    onComplete?.();
  }, [onComplete]);

  return {
    status,
    isComplete,
    wsConnected,
    retry,
    skip,
  };
}

// Helper to map message strings to phases
function mapPhase(message: string, running?: boolean, progress?: number): BootstrapPhase {
  const msg = message.toLowerCase();
  
  if (progress !== undefined && progress >= 100) return 'complete';
  if (!running && progress === 0) return 'connecting';
  
  if (msg.includes('connect')) return 'connecting';
  if (msg.includes('waiting') || msg.includes('lm studio')) return 'waiting-lmstudio';
  if (msg.includes('discover') || msg.includes('scanning')) return 'discovering';
  if (msg.includes('analyz')) return 'analyzing';
  if (msg.includes('preset') || msg.includes('building')) return 'building';
  if (msg.includes('load')) return 'loading';
  if (msg.includes('complete') || msg.includes('ready')) return 'complete';
  if (msg.includes('error') || msg.includes('fail')) return 'error';
  
  // Default based on progress
  if (progress !== undefined) {
    if (progress < 20) return 'discovering';
    if (progress < 50) return 'analyzing';
    if (progress < 80) return 'building';
    if (progress < 100) return 'loading';
    return 'complete';
  }
  
  return 'connecting';
}

export default useBootstrapStatus;

