/**
 * Bootstrap Status Hook
 * 
 * Connects to WebSocket and polls for bootstrap status during app startup.
 * Handles the blocking loading screen state.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
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
  const hasStartedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);
  
  // Keep refs up to date without triggering re-renders
  useEffect(() => {
    onCompleteRef.current = onComplete;
    onErrorRef.current = onError;
  }, [onComplete, onError]);

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
        onCompleteRef.current?.();
      }
      
      if (data.error) {
        onErrorRef.current?.(data.error);
      }
      
      return mappedStatus;
    } catch (error) {
      console.error('[Bootstrap] Failed to poll status:', error);
      return null;
    }
  }, []);

  // Check LM Studio connection
  const checkLMStudioConnection = useCallback(async (): Promise<boolean> => {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/1125f441-1d5b-4fd7-b3b9-6ab8dc90022a',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'use-bootstrap-status.ts:68',message:'checkLMStudioConnection START',data:{},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    try {
      const res = await fetch('/lmstudio/health');
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/1125f441-1d5b-4fd7-b3b9-6ab8dc90022a',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'use-bootstrap-status.ts:72',message:'checkLMStudioConnection RESPONSE',data:{ok:res.ok,status:res.status},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      if (!res.ok) return false;
      const data = await res.json();
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/1125f441-1d5b-4fd7-b3b9-6ab8dc90022a',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'use-bootstrap-status.ts:76',message:'checkLMStudioConnection DATA',data:{ready:data.ready,status:data.status,connected:data.connected,keys:Object.keys(data)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      const result = data.ready === true || data.status === 'ok' || data.connected === true;
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/1125f441-1d5b-4fd7-b3b9-6ab8dc90022a',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'use-bootstrap-status.ts:79',message:'checkLMStudioConnection RESULT',data:{result},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      // API returns: { status: "ok", ready: true, ... }
      return result;
    } catch (error) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/1125f441-1d5b-4fd7-b3b9-6ab8dc90022a',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'use-bootstrap-status.ts:84',message:'checkLMStudioConnection ERROR',data:{error:String(error)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      return false;
    }
  }, []);

  // Main effect - handles startup flow
  useEffect(() => {
    if (!enabled) return;
    
    // Prevent multiple executions - this is the key fix for infinite re-renders
    if (hasStartedRef.current) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/1125f441-1d5b-4fd7-b3b9-6ab8dc90022a',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'use-bootstrap-status.ts:100',message:'runStartupFlow SKIPPED (already started)',data:{},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'FIX'})}).catch(()=>{});
      // #endregion
      return;
    }
    hasStartedRef.current = true;

    let mounted = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;

    const runStartupFlow = async () => {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/1125f441-1d5b-4fd7-b3b9-6ab8dc90022a',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'use-bootstrap-status.ts:88',message:'runStartupFlow START',data:{},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C'})}).catch(()=>{});
      // #endregion
      // Phase 1: Check LM Studio connection
      setStatus({
        phase: 'connecting',
        progress: 5,
        message: 'Checking LM Studio connection...',
      });

      let lmConnected = await checkLMStudioConnection();
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/1125f441-1d5b-4fd7-b3b9-6ab8dc90022a',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'use-bootstrap-status.ts:99',message:'First LM Studio check done',data:{lmConnected,retryCount},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C'})}).catch(()=>{});
      // #endregion
      
      // Retry loop for LM Studio connection
      while (!lmConnected && mounted) {
        retryCount++;
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/1125f441-1d5b-4fd7-b3b9-6ab8dc90022a',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'use-bootstrap-status.ts:106',message:'Retry loop iteration',data:{retryCount,lmConnected},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
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

      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/1125f441-1d5b-4fd7-b3b9-6ab8dc90022a',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'use-bootstrap-status.ts:125',message:'LM Studio connected, proceeding to discover',data:{},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C'})}).catch(()=>{});
      // #endregion
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
      // Reset the ref on cleanup so StrictMode remount can run
      hasStartedRef.current = false;
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/1125f441-1d5b-4fd7-b3b9-6ab8dc90022a',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'use-bootstrap-status.ts:cleanup',message:'Effect cleanup - resetting hasStartedRef',data:{},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'FIX2'})}).catch(()=>{});
      // #endregion
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]); // Only depend on enabled - callbacks use refs to prevent re-execution

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
            onCompleteRef.current?.();
          }
          
          if (wsStatus.phase === 'error' && wsStatus.error) {
            onErrorRef.current?.(wsStatus.error);
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
  }, [enabled]); // Only depend on enabled - callbacks use refs

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

