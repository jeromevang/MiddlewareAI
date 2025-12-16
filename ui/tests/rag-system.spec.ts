import { test, expect } from '@playwright/test';

const API_BASE = 'http://localhost:4000';

test.describe('RAG System - Reset & Reindex', () => {
  test.setTimeout(120000); // RAG operations can take time

  test('reset endpoint clears all RAG data', async ({ request }) => {
    // First check current status
    const beforeResponse = await request.get(`${API_BASE}/rag/indexing-status`);
    expect(beforeResponse.ok()).toBeTruthy();
    const beforeStatus = await beforeResponse.json();
    
    // Reset RAG data
    const resetResponse = await request.post(`${API_BASE}/rag/reset`);
    expect(resetResponse.ok()).toBeTruthy();
    const resetResult = await resetResponse.json();
    
    expect(resetResult.status).toBe('ok');
    expect(resetResult.message).toContain('cleared');
    expect(resetResult.cleared).toBeDefined();
    expect(resetResult.current).toBeDefined();
    
    // Verify FAISS is cleared
    expect(resetResult.current.faissEntries).toBe(0);
    expect(resetResult.current.dbChunks).toBe(0);
    
    // Verify via indexing-status endpoint
    const afterResponse = await request.get(`${API_BASE}/rag/indexing-status`);
    const afterStatus = await afterResponse.json();
    
    expect(afterStatus.dbStats.chunkCount).toBe(0);
    expect(afterStatus.faissStats.entries).toBe(0);
  });

  test('reindex can be triggered and starts processing', async ({ request }) => {
    // Trigger reindex
    const reindexResponse = await request.post(`${API_BASE}/rag/reindex`, {
      data: { reason: 'test-reindex' }
    });
    expect(reindexResponse.ok()).toBeTruthy();
    const reindexResult = await reindexResponse.json();
    expect(reindexResult.status).toBe('ok');
    expect(reindexResult.message).toContain('started');
    
    // Wait briefly and check if indexing is running or has started
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const statusResponse = await request.get(`${API_BASE}/rag/indexing-status`);
    const status = await statusResponse.json();
    
    // Status should reflect activity (processing, indexing, idle, or completed)
    const validStatuses = ['processing', 'indexing', 'idle', 'completed'];
    expect(validStatuses.includes(status.status)).toBeTruthy();
  });

  test('FAISS entries match DB chunk count when not indexing', async ({ request }) => {
    const statusResponse = await request.get(`${API_BASE}/rag/indexing-status`);
    const status = await statusResponse.json();
    
    // Skip if indexing is currently active (counts may be temporarily out of sync)
    if (status.isIndexing) {
      console.log('Skipping: indexing is currently active');
      return;
    }
    
    // FAISS entries should equal DB chunks when indexing is complete
    expect(status.faissStats.entries).toBe(status.dbStats.chunkCount);
  });

  test('embedding dimension is correctly configured', async ({ request }) => {
    const statusResponse = await request.get(`${API_BASE}/rag/indexing-status`);
    const status = await statusResponse.json();
    
    // Standard embedding dimensions
    const validDimensions = [384, 512, 768, 1024, 1536];
    expect(validDimensions).toContain(status.faissStats.dim);
  });
});

test.describe('RAG System - Chunk Retrieval', () => {
  test.setTimeout(30000);

  test('search returns relevant code chunks', async ({ request }) => {
    // First ensure we have indexed data
    const statusResponse = await request.get(`${API_BASE}/rag/indexing-status`);
    const status = await statusResponse.json();
    
    if (status.dbStats.chunkCount === 0) {
      console.log('No indexed data, triggering reindex first');
      await request.post(`${API_BASE}/rag/reindex`, { data: { reason: 'test' } });
      
      // Wait for indexing
      let attempts = 0;
      while (attempts < 30) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const checkStatus = await request.get(`${API_BASE}/rag/indexing-status`);
        const checkData = await checkStatus.json();
        if (!checkData.isIndexing && checkData.dbStats.chunkCount > 0) break;
        attempts++;
      }
    }
    
    // Search for code-related content
    const searchResponse = await request.post(`${API_BASE}/debug/rag/search-explain`, {
      data: { query: 'function that handles model loading', topK: 5 }
    });
    
    expect(searchResponse.ok()).toBeTruthy();
    const searchResult = await searchResponse.json();
    
    expect(searchResult.results).toBeDefined();
    expect(Array.isArray(searchResult.results)).toBeTruthy();
    
    if (searchResult.results.length > 0) {
      // Each result should have chunk info
      const firstResult = searchResult.results[0];
      expect(firstResult.chunkId || firstResult.chunk_id).toBeDefined();
      expect(firstResult.score || firstResult.similarity).toBeDefined();
    }
  });

  test('search with empty query returns error or empty', async ({ request }) => {
    const searchResponse = await request.post(`${API_BASE}/debug/rag/search-explain`, {
      data: { query: '', topK: 5 }
    });
    
    // Should either return error or empty results
    if (searchResponse.ok()) {
      const result = await searchResponse.json();
      expect(result.results?.length || 0).toBe(0);
    } else {
      expect(searchResponse.status()).toBe(400);
    }
  });

  test('topK parameter limits results', async ({ request }) => {
    const statusResponse = await request.get(`${API_BASE}/rag/indexing-status`);
    const status = await statusResponse.json();
    
    if (status.dbStats.chunkCount === 0) {
      console.log('No indexed data, skipping topK test');
      return;
    }
    
    // Request 3 results
    const searchResponse = await request.post(`${API_BASE}/debug/rag/search-explain`, {
      data: { query: 'server configuration', topK: 3 }
    });
    
    expect(searchResponse.ok()).toBeTruthy();
    const result = await searchResponse.json();
    
    expect(result.results.length).toBeLessThanOrEqual(3);
  });
});

test.describe('RAG System - Tier Management', () => {
  test.setTimeout(60000);

  test('current tier is valid', async ({ request }) => {
    const tierResponse = await request.get(`${API_BASE}/rag/tier`);
    expect(tierResponse.ok()).toBeTruthy();
    const tierData = await tierResponse.json();
    
    expect(tierData.currentTier).toBeDefined();
    expect(['low', 'medium', 'high']).toContain(tierData.currentTier);
  });

  test('tier configuration includes embedder and summarizer', async ({ request }) => {
    const tierResponse = await request.get(`${API_BASE}/rag/tier`);
    const tierData = await tierResponse.json();
    
    expect(tierData.config).toBeDefined();
    expect(tierData.config.embedder).toBeDefined();
    expect(tierData.config.ragSummarizer).toBeDefined();
    
    // Embedder should have model_name and dimension
    expect(tierData.config.embedder.model_name).toBeDefined();
    expect(tierData.config.embedder.dimension).toBeDefined();
  });

  test('available tiers are listed', async ({ request }) => {
    const tierResponse = await request.get(`${API_BASE}/rag/tier`);
    const tierData = await tierResponse.json();
    
    expect(tierData.availableTiers).toBeDefined();
    expect(tierData.availableTiers.length).toBe(3);
    
    // Each tier should have id and name
    tierData.availableTiers.forEach((tier: any) => {
      expect(tier.id).toBeDefined();
      expect(tier.name).toBeDefined();
    });
  });
});

test.describe('RAG System - Debug Endpoints', () => {
  test('debug stats returns valid data', async ({ request }) => {
    const statsResponse = await request.get(`${API_BASE}/debug/rag/stats`);
    expect(statsResponse.ok()).toBeTruthy();
    const data = await statsResponse.json();
    
    expect(data.status).toBe('ok');
    expect(data.stats).toBeDefined();
    expect(data.stats.totalChunks).toBeDefined();
    expect(typeof data.stats.totalChunks).toBe('number');
    expect(data.stats.totalChunks).toBeGreaterThanOrEqual(0);
  });

  test('debug files returns indexed file list', async ({ request }) => {
    const filesResponse = await request.get(`${API_BASE}/debug/rag/files`);
    expect(filesResponse.ok()).toBeTruthy();
    const files = await filesResponse.json();
    
    expect(files.files).toBeDefined();
    expect(Array.isArray(files.files)).toBeTruthy();
  });

  test('debug chunks returns paginated results', async ({ request }) => {
    const chunksResponse = await request.get(`${API_BASE}/debug/rag/chunks?limit=10&offset=0`);
    expect(chunksResponse.ok()).toBeTruthy();
    const chunks = await chunksResponse.json();
    
    expect(chunks.chunks).toBeDefined();
    expect(Array.isArray(chunks.chunks)).toBeTruthy();
    expect(chunks.chunks.length).toBeLessThanOrEqual(10);
  });
});

