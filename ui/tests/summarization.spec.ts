import { test, expect } from '@playwright/test';

const API_BASE = 'http://localhost:4000';

// Sample code for testing summarization
const SAMPLE_CODE = `
/**
 * UserAuthService handles user authentication and session management.
 * Supports multiple authentication methods including OAuth, JWT, and basic auth.
 */
class UserAuthService {
  constructor(config) {
    this.jwtSecret = config.jwtSecret;
    this.tokenExpiry = config.tokenExpiry || '24h';
    this.sessionStore = new Map();
  }

  async authenticateUser(username, password) {
    const user = await this.findUser(username);
    if (!user) {
      throw new Error('User not found');
    }
    
    const isValid = await this.verifyPassword(password, user.passwordHash);
    if (!isValid) {
      throw new Error('Invalid password');
    }
    
    return this.createSession(user);
  }

  createSession(user) {
    const token = this.generateJWT(user);
    this.sessionStore.set(token, { userId: user.id, createdAt: Date.now() });
    return { token, user: { id: user.id, username: user.username } };
  }

  generateJWT(user) {
    return jwt.sign({ userId: user.id }, this.jwtSecret, { expiresIn: this.tokenExpiry });
  }
}
`;

const LONG_CODE = SAMPLE_CODE.repeat(10); // ~4000 chars

test.describe('Summarization - RAG Summarizer', () => {
  test.setTimeout(60000);

  test('RAG summarizer returns non-empty summary', async ({ request }) => {
    const response = await request.post(`${API_BASE}/debug/test-summarizer`, {
      data: { text: SAMPLE_CODE }
    });
    
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    
    expect(result.status).toBe('ok');
    expect(result.summary).toBeDefined();
    expect(typeof result.summary).toBe('string');
    expect(result.summary.length).toBeGreaterThan(0);
  });

  test('summary produces output', async ({ request }) => {
    const response = await request.post(`${API_BASE}/debug/test-summarizer`, {
      data: { text: SAMPLE_CODE }
    });
    
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    
    if (result.status === 'ok') {
      // Summary should exist and be non-empty
      expect(result.summary).toBeDefined();
      expect(result.summary.length).toBeGreaterThan(0);
      
      // Log ratio for info (LLM may produce longer or shorter summaries)
      const ratio = result.summary.length / SAMPLE_CODE.length;
      console.log(`Summary ratio: ${ratio.toFixed(2)} (${result.summary.length}/${SAMPLE_CODE.length})`);
    }
  });

  test('summary contains key terms from code', async ({ request }) => {
    const response = await request.post(`${API_BASE}/debug/test-summarizer`, {
      data: { text: SAMPLE_CODE }
    });
    
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    
    if (result.status === 'ok') {
      const summaryLower = result.summary.toLowerCase();
      
      // Summary should mention key concepts
      const keyTerms = ['user', 'auth', 'session', 'token', 'jwt'];
      const foundTerms = keyTerms.filter(term => summaryLower.includes(term));
      
      // At least some key terms should be present
      expect(foundTerms.length).toBeGreaterThan(0);
    }
  });

  test('summary has reasonable minimum length', async ({ request }) => {
    const response = await request.post(`${API_BASE}/debug/test-summarizer`, {
      data: { text: SAMPLE_CODE }
    });
    
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    
    if (result.status === 'ok') {
      // Summary should be at least 50 characters
      expect(result.summary.length).toBeGreaterThan(50);
    }
  });

  test('summarizer returns timing info', async ({ request }) => {
    const response = await request.post(`${API_BASE}/debug/test-summarizer`, {
      data: { text: SAMPLE_CODE }
    });
    
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    
    if (result.status === 'ok') {
      expect(result.timeMs).toBeDefined();
      expect(typeof result.timeMs).toBe('number');
      expect(result.timeMs).toBeGreaterThan(0);
    }
  });

  test('empty text returns error', async ({ request }) => {
    const response = await request.post(`${API_BASE}/debug/test-summarizer`, {
      data: { text: '' }
    });
    
    expect(response.ok()).toBeFalsy();
    const result = await response.json();
    expect(result.error).toBeDefined();
  });

  test('missing text field returns error', async ({ request }) => {
    const response = await request.post(`${API_BASE}/debug/test-summarizer`, {
      data: {}
    });
    
    expect(response.ok()).toBeFalsy();
    const result = await response.json();
    expect(result.error).toContain('text');
  });
});

test.describe('Summarization - Long Text Handling', () => {
  test.setTimeout(120000); // Long text may take more time

  test('long text is handled without error', async ({ request }) => {
    const response = await request.post(`${API_BASE}/debug/test-summarizer`, {
      data: { text: LONG_CODE }
    });
    
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    
    // Should either succeed or return a graceful error
    expect(result.status).toBeDefined();
    
    if (result.status === 'ok') {
      expect(result.summary).toBeDefined();
      expect(result.summary.length).toBeGreaterThan(0);
    }
  });

  test('very long text produces reasonable summary length', async ({ request }) => {
    const response = await request.post(`${API_BASE}/debug/test-summarizer`, {
      data: { text: LONG_CODE }
    });
    
    const result = await response.json();
    
    if (result.status === 'ok') {
      // Summary should not be proportionally long
      const ratio = result.summary.length / LONG_CODE.length;
      expect(ratio).toBeLessThan(0.5); // Summary should be less than 50% of input
    }
  });
});

test.describe('Summarization - Summary Status', () => {
  test('summary status endpoint works', async ({ request }) => {
    const response = await request.get(`${API_BASE}/summary/status`);
    expect(response.ok()).toBeTruthy();
    const status = await response.json();
    
    expect(status.currentModel).toBeDefined();
  });

  test('summary reprocess endpoint accepts request', async ({ request }) => {
    const response = await request.post(`${API_BASE}/summary/reprocess`, {
      data: {}
    });
    
    // Should accept the request (may not do anything if no data)
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    expect(result.status).toBeDefined();
  });
});

test.describe('Summarization - Real Code Files', () => {
  test.setTimeout(90000);

  test('summarize actual project code from RAG', async ({ request }) => {
    // Ensure we have indexed data
    const statusResponse = await request.get(`${API_BASE}/rag/indexing-status`);
    const status = await statusResponse.json();
    
    if (status.dbStats.chunkCount === 0) {
      console.log('No indexed chunks, skipping real code test');
      return;
    }
    
    // Get a chunk from the database
    const chunksResponse = await request.get(`${API_BASE}/debug/rag/chunks?limit=1`);
    const chunksData = await chunksResponse.json();
    
    if (chunksData.chunks.length === 0) {
      console.log('No chunks available, skipping');
      return;
    }
    
    const chunk = chunksData.chunks[0];
    const codeContent = chunk.content || chunk.code || '';
    
    if (codeContent.length < 50) {
      console.log('Chunk too short for meaningful summary test');
      return;
    }
    
    // Summarize the actual code
    const summaryResponse = await request.post(`${API_BASE}/debug/test-summarizer`, {
      data: { text: codeContent }
    });
    
    expect(summaryResponse.ok()).toBeTruthy();
    const result = await summaryResponse.json();
    
    if (result.status === 'ok') {
      expect(result.summary.length).toBeGreaterThan(20);
      expect(result.summary.length).toBeLessThan(codeContent.length);
    }
  });

  test('summarizer handles different file types', async ({ request }) => {
    // Get files to see what types we have indexed
    const filesResponse = await request.get(`${API_BASE}/debug/rag/files`);
    const filesData = await filesResponse.json();
    
    if (filesData.files.length === 0) {
      console.log('No files indexed, skipping');
      return;
    }
    
    // Test with JavaScript code content
    const jsCode = `
      function processData(input) {
        const result = input.map(item => item * 2);
        return result.filter(x => x > 10);
      }
    `;
    
    const response = await request.post(`${API_BASE}/debug/test-summarizer`, {
      data: { text: jsCode }
    });
    
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    
    if (result.status === 'ok') {
      expect(result.summary.toLowerCase()).toMatch(/function|process|data|map|filter/i);
    }
  });
});

