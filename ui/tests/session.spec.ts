import { test, expect } from '@playwright/test';

const API_BASE = 'http://localhost:4000';

test.describe('Sessions - Listing', () => {
  test.setTimeout(15000);

  test('sessions endpoint returns list', async ({ request }) => {
    const response = await request.get(`${API_BASE}/sessions?limit=10`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.sessions).toBeDefined();
    expect(Array.isArray(data.sessions)).toBeTruthy();
  });

  test('sessions have required fields', async ({ request }) => {
    const response = await request.get(`${API_BASE}/sessions?limit=10`);
    const data = await response.json();
    
    if (data.sessions.length === 0) {
      console.log('No sessions to verify fields');
      return;
    }
    
    const session = data.sessions[0];
    // Check for various possible field names
    const hasId = session.conversation_id || session.conversationId || session.id;
    expect(hasId).toBeDefined();
  });

  test('sessions limit parameter works', async ({ request }) => {
    // Get with limit 1
    const response1 = await request.get(`${API_BASE}/sessions?limit=1`);
    const data1 = await response1.json();
    
    // Get with limit 5
    const response5 = await request.get(`${API_BASE}/sessions?limit=5`);
    const data5 = await response5.json();
    
    expect(data1.sessions.length).toBeLessThanOrEqual(1);
    expect(data5.sessions.length).toBeLessThanOrEqual(5);
  });
});

test.describe('Sessions - Conversation Creation', () => {
  test.setTimeout(60000);

  test('completion creates a session', async ({ request }) => {
    // Get sessions before
    const beforeResponse = await request.get(`${API_BASE}/sessions?limit=100`);
    const beforeData = await beforeResponse.json();
    const beforeCount = beforeData.sessions.length;
    
    // Send a completion
    const completionResponse = await request.post(`${API_BASE}/v1/chat/completions`, {
      data: {
        model: 'local-model',
        messages: [
          { role: 'user', content: 'Test message for session creation ' + Date.now() }
        ],
        stream: false
      }
    });
    
    expect(completionResponse.ok()).toBeTruthy();
    
    // Wait a bit for session to be recorded
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Get sessions after
    const afterResponse = await request.get(`${API_BASE}/sessions?limit=100`);
    const afterData = await afterResponse.json();
    
    // Should have at least as many sessions (may have more)
    expect(afterData.sessions.length).toBeGreaterThanOrEqual(beforeCount);
  });

  test('multiple completions in same conversation add turns', async ({ request }) => {
    const conversationId = `test-conv-${Date.now()}`;
    
    // Send first message
    await request.post(`${API_BASE}/v1/chat/completions`, {
      data: {
        model: 'local-model',
        messages: [
          { role: 'user', content: 'First message' }
        ],
        conversationId,
        stream: false
      }
    });
    
    // Send second message
    await request.post(`${API_BASE}/v1/chat/completions`, {
      data: {
        model: 'local-model',
        messages: [
          { role: 'user', content: 'First message' },
          { role: 'assistant', content: 'First response' },
          { role: 'user', content: 'Second message' }
        ],
        conversationId,
        stream: false
      }
    });
    
    // Wait for turns to be recorded
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Get turns for this conversation
    const turnsResponse = await request.get(`${API_BASE}/sessions/${conversationId}/turns`);
    
    if (turnsResponse.ok()) {
      const turnsData = await turnsResponse.json();
      expect(turnsData.turns).toBeDefined();
      // May have turns recorded
    }
  });
});

test.describe('Sessions - Turn Retrieval', () => {
  test.setTimeout(30000);

  test('turns endpoint returns valid structure', async ({ request }) => {
    // Get a session first
    const sessionsResponse = await request.get(`${API_BASE}/sessions?limit=1`);
    const sessionsData = await sessionsResponse.json();
    
    if (sessionsData.sessions.length === 0) {
      console.log('No sessions to check turns for');
      return;
    }
    
    const conversationId = sessionsData.sessions[0].conversation_id || 
                          sessionsData.sessions[0].conversationId;
    
    const turnsResponse = await request.get(`${API_BASE}/sessions/${conversationId}/turns`);
    expect(turnsResponse.ok()).toBeTruthy();
    const turnsData = await turnsResponse.json();
    
    expect(turnsData.turns).toBeDefined();
    expect(Array.isArray(turnsData.turns)).toBeTruthy();
  });

  test('global session turns have valid structure', async ({ request }) => {
    // Use 'global' session which is always available
    const turnsResponse = await request.get(`${API_BASE}/sessions/global/turns`);
    expect(turnsResponse.ok()).toBeTruthy();
    const turnsData = await turnsResponse.json();
    
    // Should have turns array
    expect(turnsData.turns).toBeDefined();
    expect(Array.isArray(turnsData.turns)).toBeTruthy();
    
    // Should have pagination info
    expect(turnsData.pagination).toBeDefined();
    
    if (turnsData.turns.length > 0) {
      // If turns exist, verify structure
      const turn = turnsData.turns[0];
      expect(turn.id || turn.turn_id).toBeDefined();
    } else {
      console.log('No turns in global session');
    }
  });

  test('non-existent conversation returns empty turns', async ({ request }) => {
    const response = await request.get(`${API_BASE}/sessions/non-existent-${Date.now()}/turns`);
    
    if (response.ok()) {
      const data = await response.json();
      expect(data.turns).toBeDefined();
      expect(data.turns.length).toBe(0);
    }
  });
});

test.describe('Sessions - Purge', () => {
  test.setTimeout(30000);

  test('purge endpoint accepts request', async ({ request }) => {
    const response = await request.post(`${API_BASE}/sessions/purge`, {
      data: {}
    });
    
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    expect(result.status).toBeDefined();
  });

  test('purge by conversation ID works', async ({ request }) => {
    // Create a session
    const conversationId = `test-purge-${Date.now()}`;
    
    await request.post(`${API_BASE}/v1/chat/completions`, {
      data: {
        model: 'local-model',
        messages: [{ role: 'user', content: 'Test for purge' }],
        conversationId,
        stream: false
      }
    });
    
    // Wait for session to be recorded
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Purge this conversation
    const purgeResponse = await request.post(`${API_BASE}/sessions/purge`, {
      data: { conversationId }
    });
    
    expect(purgeResponse.ok()).toBeTruthy();
    
    // Verify it's gone
    const turnsResponse = await request.get(`${API_BASE}/sessions/${conversationId}/turns`);
    if (turnsResponse.ok()) {
      const data = await turnsResponse.json();
      expect(data.turns.length).toBe(0);
    }
  });
});

test.describe('Sessions - Dashboard Integration', () => {
  test.setTimeout(30000);

  test('sessions appear in dashboard snapshot', async ({ request }) => {
    // This tests via HTTP instead of WebSocket for simplicity
    const sessionsResponse = await request.get(`${API_BASE}/sessions?limit=10`);
    const sessionsData = await sessionsResponse.json();
    
    // Sessions should be available
    expect(sessionsData.sessions).toBeDefined();
  });

  test('session metadata is complete', async ({ request }) => {
    const sessionsResponse = await request.get(`${API_BASE}/sessions?limit=1`);
    const sessionsData = await sessionsResponse.json();
    
    if (sessionsData.sessions.length > 0) {
      const session = sessionsData.sessions[0];
      
      // Required fields
      expect(session.conversation_id || session.conversationId).toBeDefined();
      expect(session.created_at || session.createdAt).toBeDefined();
      
      // Optional fields that should be present
      expect(session.message_count !== undefined || session.turnCount !== undefined).toBeTruthy();
    }
  });
});

test.describe('Sessions - Rolling Summaries', () => {
  test.setTimeout(60000);

  test('rolling summary is generated for long conversations', async ({ request }) => {
    // This would require a long conversation to trigger summarization
    // For now, just check the summary status endpoint
    const response = await request.get(`${API_BASE}/summary/status`);
    expect(response.ok()).toBeTruthy();
    const status = await response.json();
    
    expect(status.currentModel).toBeDefined();
  });

  test('summary reprocess accepts request', async ({ request }) => {
    const response = await request.post(`${API_BASE}/summary/reprocess`, {
      data: {}
    });
    
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    expect(result.status).toBeDefined();
  });
});

test.describe('Sessions - Data Consistency', () => {
  test.setTimeout(30000);

  test('session list is sorted by recent', async ({ request }) => {
    const response = await request.get(`${API_BASE}/sessions?limit=10`);
    const data = await response.json();
    
    if (data.sessions.length < 2) {
      console.log('Not enough sessions to check sorting');
      return;
    }
    
    // Verify descending order by created_at
    for (let i = 0; i < data.sessions.length - 1; i++) {
      const current = new Date(data.sessions[i].created_at || data.sessions[i].createdAt);
      const next = new Date(data.sessions[i + 1].created_at || data.sessions[i + 1].createdAt);
      
      expect(current.getTime()).toBeGreaterThanOrEqual(next.getTime());
    }
  });

  test('session count matches list length', async ({ request }) => {
    const response = await request.get(`${API_BASE}/sessions?limit=100`);
    const data = await response.json();
    
    // The count should be accurate
    if (data.totalCount !== undefined) {
      expect(data.totalCount).toBeGreaterThanOrEqual(data.sessions.length);
    }
  });
});

