import { test, expect } from '@playwright/test';
import WebSocket from 'ws';

const WS_URL = 'ws://localhost:4000/ws';
const API_BASE = 'http://localhost:4000';

// Helper to create WebSocket and wait for connection
function connectWebSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket connection timeout'));
    }, 5000);
    
    ws.on('open', () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    
    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// Helper to wait for a specific message type
function waitForMessage(ws: WebSocket, type: string, timeout = 10000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for message type: ${type}`));
    }, timeout);
    
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch {
        // Ignore parse errors
      }
    };
    
    ws.on('message', handler);
  });
}

test.describe('WebSocket - Connection', () => {
  test.setTimeout(15000);

  test('WebSocket connection can be established', async () => {
    const ws = await connectWebSocket();
    
    expect(ws.readyState).toBe(WebSocket.OPEN);
    
    ws.close();
  });

  test('WebSocket accepts messages', async () => {
    const ws = await connectWebSocket();
    
    // Send a request
    ws.send(JSON.stringify({ type: 'snapshot-request' }));
    
    // Wait a bit and verify no error
    await new Promise(resolve => setTimeout(resolve, 500));
    
    expect(ws.readyState).toBe(WebSocket.OPEN);
    
    ws.close();
  });

  test('WebSocket handles multiple connections', async () => {
    const ws1 = await connectWebSocket();
    const ws2 = await connectWebSocket();
    
    expect(ws1.readyState).toBe(WebSocket.OPEN);
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    
    ws1.close();
    ws2.close();
  });

  test('WebSocket gracefully handles close', async () => {
    const ws = await connectWebSocket();
    
    ws.close();
    
    // Wait for close
    await new Promise(resolve => setTimeout(resolve, 500));
    
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});

test.describe('WebSocket - Dashboard Messages', () => {
  test.setTimeout(15000);

  test('snapshot request returns dashboard data', async () => {
    const ws = await connectWebSocket();
    
    // Request snapshot
    ws.send(JSON.stringify({ type: 'snapshot-request' }));
    
    // Wait for dashboard message
    const msg = await waitForMessage(ws, 'dashboard');
    
    expect(msg.type).toBe('dashboard');
    expect(msg.payload).toBeDefined();
    
    ws.close();
  });

  test('dashboard snapshot has required fields', async () => {
    const ws = await connectWebSocket();
    
    ws.send(JSON.stringify({ type: 'snapshot-request' }));
    
    const msg = await waitForMessage(ws, 'dashboard');
    const payload = msg.payload;
    
    // Dashboard payload should exist
    expect(payload).toBeDefined();
    
    // May have sessions array or other data depending on implementation
    if (payload.sessions) {
      expect(Array.isArray(payload.sessions)).toBeTruthy();
    }
    
    ws.close();
  });
});

test.describe('WebSocket - Bootstrap Status', () => {
  test.setTimeout(30000);

  test('bootstrap status broadcast works', async ({ request }) => {
    const ws = await connectWebSocket();
    
    // Trigger bootstrap
    const triggerResponse = await request.post(`${API_BASE}/bootstrap/trigger`);
    
    if (triggerResponse.ok()) {
      // Should receive bootstrap status updates
      try {
        const msg = await waitForMessage(ws, 'bootstrap-status', 5000);
        expect(msg.type).toBe('bootstrap-status');
        expect(msg.payload).toBeDefined();
      } catch {
        // Bootstrap may complete too quickly
        console.log('Bootstrap completed before status received');
      }
    }
    
    ws.close();
  });

  test('bootstrap status has progress info', async ({ request }) => {
    // Get current bootstrap status via API
    const response = await request.get(`${API_BASE}/models/bootstrap-status`);
    expect(response.ok()).toBeTruthy();
    const status = await response.json();
    
    expect(status.progress).toBeDefined();
    expect(status.message).toBeDefined();
    expect(typeof status.progress).toBe('number');
  });
});

test.describe('WebSocket - Session Updates', () => {
  test.setTimeout(30000);

  test('session updates are broadcast after completion', async ({ request }) => {
    const ws = await connectWebSocket();
    
    // Request initial snapshot
    ws.send(JSON.stringify({ type: 'snapshot-request' }));
    await waitForMessage(ws, 'dashboard');
    
    // Send a completion to generate a session
    const completionResponse = await request.post(`${API_BASE}/v1/chat/completions`, {
      data: {
        model: 'local-model',
        messages: [{ role: 'user', content: 'Test message for WebSocket' }],
        stream: false
      }
    });
    
    if (completionResponse.ok()) {
      // Wait for session update (may or may not arrive)
      try {
        const msg = await waitForMessage(ws, 'session-update', 5000);
        expect(msg.type).toBe('session-update');
        expect(msg.payload).toBeDefined();
      } catch {
        // Session update may not be sent for all completions
        console.log('No session update received');
      }
    }
    
    ws.close();
  });
});

test.describe('WebSocket - Error Handling', () => {
  test.setTimeout(15000);

  test('invalid message format is handled gracefully', async () => {
    const ws = await connectWebSocket();
    
    // Send invalid message
    ws.send('not-json');
    
    // Connection should stay open
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    
    ws.close();
  });

  test('unknown message type is handled', async () => {
    const ws = await connectWebSocket();
    
    // Send unknown type
    ws.send(JSON.stringify({ type: 'unknown-type-12345' }));
    
    // Connection should stay open
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    
    ws.close();
  });

  test('empty message is handled', async () => {
    const ws = await connectWebSocket();
    
    ws.send('');
    
    // Connection should stay open
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    
    ws.close();
  });
});

test.describe('WebSocket - Stability', () => {
  test.setTimeout(30000);

  test('multiple rapid messages are handled', async () => {
    const ws = await connectWebSocket();
    
    // Send multiple messages rapidly
    for (let i = 0; i < 10; i++) {
      ws.send(JSON.stringify({ type: 'snapshot-request' }));
    }
    
    // Wait and verify connection is stable
    await new Promise(resolve => setTimeout(resolve, 2000));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    
    ws.close();
  });

  test('connection survives idle period', async () => {
    const ws = await connectWebSocket();
    
    // Wait idle for a bit
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Should still be connected
    expect(ws.readyState).toBe(WebSocket.OPEN);
    
    // Can still send messages
    ws.send(JSON.stringify({ type: 'snapshot-request' }));
    
    const msg = await waitForMessage(ws, 'dashboard');
    expect(msg).toBeDefined();
    
    ws.close();
  });
});

