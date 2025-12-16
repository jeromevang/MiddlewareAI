import { test, expect } from '@playwright/test';

const API_BASE = 'http://localhost:4000';

test.describe('Database - Chunk Storage', () => {
  test.setTimeout(60000);

  test('chunks are stored after indexing', async ({ request }) => {
    // Get current indexing status
    const statusResponse = await request.get(`${API_BASE}/rag/indexing-status`);
    expect(statusResponse.ok()).toBeTruthy();
    const status = await statusResponse.json();
    
    // If no chunks, trigger reindex and wait
    if (status.dbStats.chunkCount === 0) {
      console.log('No chunks found, triggering reindex...');
      await request.post(`${API_BASE}/rag/reindex`, { data: { reason: 'db-test' } });
      
      // Wait for indexing to complete
      let attempts = 0;
      while (attempts < 60) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const checkStatus = await request.get(`${API_BASE}/rag/indexing-status`);
        const checkData = await checkStatus.json();
        if (!checkData.isIndexing && checkData.dbStats.chunkCount > 0) break;
        attempts++;
      }
    }
    
    // Verify chunks exist
    const finalStatus = await request.get(`${API_BASE}/rag/indexing-status`);
    const finalData = await finalStatus.json();
    
    expect(finalData.dbStats.chunkCount).toBeGreaterThan(0);
    expect(finalData.dbStats.fileCount).toBeGreaterThan(0);
  });

  test('chunks have required fields', async ({ request }) => {
    // Get chunks via debug endpoint
    const chunksResponse = await request.get(`${API_BASE}/debug/rag/chunks?limit=5`);
    expect(chunksResponse.ok()).toBeTruthy();
    const chunksData = await chunksResponse.json();
    
    expect(chunksData.status).toBe('ok');
    expect(chunksData.chunks).toBeDefined();
    expect(Array.isArray(chunksData.chunks)).toBeTruthy();
    
    if (chunksData.chunks.length === 0) {
      console.log('No chunks to verify fields (RAG may be empty or indexing)');
      return;
    }
    
    // Each chunk should have required fields (check first chunk structure)
    const chunk = chunksData.chunks[0];
    const hasIdField = chunk.chunk_id !== undefined || chunk.id !== undefined || chunk.chunkId !== undefined;
    const hasFileField = chunk.file_path !== undefined || chunk.filePath !== undefined;
    
    expect(hasIdField).toBeTruthy();
    expect(hasFileField).toBeTruthy();
  });

  test('chunk count equals FAISS entries when not indexing', async ({ request }) => {
    const statusResponse = await request.get(`${API_BASE}/rag/indexing-status`);
    const status = await statusResponse.json();
    
    // Skip if indexing is active (counts may be out of sync)
    if (status.isIndexing) {
      console.log('Indexing is active, skipping consistency test');
      return;
    }
    
    // FAISS and DB should be in sync when not indexing
    expect(status.faissStats.entries).toBe(status.dbStats.chunkCount);
  });

  test('indexed files list is accurate', async ({ request }) => {
    const statusResponse = await request.get(`${API_BASE}/rag/indexing-status`);
    const status = await statusResponse.json();
    
    // Get actual file list
    const filesResponse = await request.get(`${API_BASE}/debug/rag/files`);
    const filesData = await filesResponse.json();
    
    // File count should match
    expect(filesData.files.length).toBe(status.dbStats.fileCount);
  });

  test('chunk retrieval by file path works', async ({ request }) => {
    // Get a file path from indexed files
    const filesResponse = await request.get(`${API_BASE}/debug/rag/files`);
    const filesData = await filesResponse.json();
    
    if (!filesData.files || filesData.files.length === 0) {
      console.log('No indexed files, skipping');
      return;
    }
    
    const testFilePath = filesData.files[0]?.file_path || filesData.files[0];
    
    // Get chunks for that file
    const chunksResponse = await request.get(`${API_BASE}/debug/rag/chunks?filePath=${encodeURIComponent(testFilePath)}&limit=10`);
    expect(chunksResponse.ok()).toBeTruthy();
    const chunksData = await chunksResponse.json();
    
    expect(chunksData.status).toBe('ok');
    expect(chunksData.chunks).toBeDefined();
    
    // May have 0 chunks if indexing is in progress or file has no chunks
    if (chunksData.chunks.length === 0) {
      console.log('No chunks for file, may still be indexing');
      return;
    }
    
    // All chunks should be from the requested file
    chunksData.chunks.forEach((chunk: any) => {
      const chunkPath = chunk.file_path || chunk.filePath;
      expect(chunkPath).toBe(testFilePath);
    });
  });
});

test.describe('Database - Stats & Metrics', () => {
  test('database stats are available', async ({ request }) => {
    const statusResponse = await request.get(`${API_BASE}/rag/indexing-status`);
    expect(statusResponse.ok()).toBeTruthy();
    const status = await statusResponse.json();
    
    expect(status.dbStats).toBeDefined();
    expect(typeof status.dbStats.chunkCount).toBe('number');
    expect(typeof status.dbStats.fileCount).toBe('number');
  });

  test('stats include token information', async ({ request }) => {
    const statusResponse = await request.get(`${API_BASE}/rag/indexing-status`);
    const status = await statusResponse.json();
    
    expect(status.dbStats).toBeDefined();
    
    // Token stats may be present if chunks exist
    if (status.dbStats.chunkCount > 0) {
      expect(status.dbStats.totalTokens).toBeDefined();
      expect(status.dbStats.avgChunkSize).toBeDefined();
    }
  });

  test('last indexed timestamp is tracked', async ({ request }) => {
    const statusResponse = await request.get(`${API_BASE}/rag/indexing-status`);
    const status = await statusResponse.json();
    
    if (status.dbStats.chunkCount > 0) {
      expect(status.dbStats.lastIndexed).toBeDefined();
    }
  });
});

test.describe('Database - Data Persistence', () => {
  test.setTimeout(60000);

  test('reset clears data and reindex can restore it', async ({ request }) => {
    // Reset first
    const resetResponse = await request.post(`${API_BASE}/rag/reset`);
    expect(resetResponse.ok()).toBeTruthy();
    
    // Verify reset cleared the data
    const afterResetStatus = await request.get(`${API_BASE}/rag/indexing-status`);
    const afterResetData = await afterResetStatus.json();
    
    // After reset, counts should be 0
    expect(afterResetData.dbStats.chunkCount).toBe(0);
    expect(afterResetData.faissStats.entries).toBe(0);
    
    // Trigger reindex
    const reindexResponse = await request.post(`${API_BASE}/rag/reindex`, { data: { reason: 'persistence-test' } });
    expect(reindexResponse.ok()).toBeTruthy();
    
    // Verify reindex was accepted
    const reindexData = await reindexResponse.json();
    expect(reindexData.status).toBe('ok');
    
    // We don't wait for indexing to complete here - that's tested elsewhere
  });

  test('session data is separate from RAG data', async ({ request }) => {
    // Reset RAG
    await request.post(`${API_BASE}/rag/reset`);
    
    // Verify RAG is cleared
    const ragStatus = await request.get(`${API_BASE}/rag/indexing-status`);
    const ragData = await ragStatus.json();
    expect(ragData.dbStats.chunkCount).toBe(0);
    
    // Sessions should still be accessible (even if empty)
    const sessionsResponse = await request.get(`${API_BASE}/sessions?limit=10`);
    expect(sessionsResponse.ok()).toBeTruthy();
  });
});

