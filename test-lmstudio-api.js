#!/usr/bin/env node

/**
 * Simple test script for LM Studio API endpoints
 * Run with: node test-lmstudio-api.js
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:4000';

async function testEndpoint(method, path, data = null) {
  try {
    const url = `${BASE_URL}${path}`;
    console.log(`\n🧪 Testing ${method} ${url}`);

    const config = {
      method,
      url,
      headers: { 'Content-Type': 'application/json' },
      ...(data && { data })
    };

    const response = await axios(config);
    console.log(`✅ Success: ${response.status}`);
    console.log(`📄 Response:`, JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error) {
    console.log(`❌ Error: ${error.response?.status || error.code}`);
    console.log(`📄 Details:`, error.response?.data || error.message);
    return null;
  }
}

async function runTests() {
  console.log('🚀 Testing LM Studio API endpoints...\n');

  // Test 1: List loaded models
  await testEndpoint('GET', '/lmstudio/models');

  // Test 2: Get server status
  await testEndpoint('GET', '/lmstudio/server/status');

  // Test 3: Try to unload a non-existent model (should fail gracefully)
  await testEndpoint('POST', '/lmstudio/models/unload', { modelId: 'non-existent-model' });

  console.log('\n✨ Test complete!');
  console.log('\n💡 To test with real models:');
  console.log('1. Start LM Studio and load some models');
  console.log('2. Run this script again');
  console.log('3. Use the model IDs from the list endpoint to test unloading');
}

if (require.main === module) {
  runTests().catch(console.error);
}