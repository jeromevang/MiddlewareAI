#!/usr/bin/env node

/**
 * Test LM Studio model discovery APIs
 */

const axios = require('axios');

const LM_STUDIO_URL = 'http://localhost:1234';

async function testEndpoint(url, method = 'GET', data = null) {
  try {
    console.log(`\n🧪 Testing ${method} ${url}`);
    const response = await axios({ method, url, data });
    console.log(`✅ Success: ${response.status}`);
    console.log(`📄 Response:`, JSON.stringify(response.data, null, 2).substring(0, 500) + '...');
    return response.data;
  } catch (error) {
    console.log(`❌ Error: ${error.response?.status || error.code}`);
    console.log(`📄 Details:`, error.response?.data || error.message);
    return null;
  }
}

async function main() {
  console.log('🚀 Testing LM Studio Model Discovery APIs...\n');

  // Test basic endpoints
  await testEndpoint(`${LM_STUDIO_URL}/v1/models`);
  await testEndpoint(`${LM_STUDIO_URL}/api/tags`);
  await testEndpoint(`${LM_STUDIO_URL}/api/models`);

  // Test model discovery/search
  await testEndpoint(`${LM_STUDIO_URL}/api/search/models?q=qwen`);
  await testEndpoint(`${LM_STUDIO_URL}/api/models/search?q=qwen`);

  // Test registry/discovery endpoints
  await testEndpoint(`${LM_STUDIO_URL}/api/registry/models`);
  await testEndpoint(`${LM_STUDIO_URL}/api/discovery/models`);
  await testEndpoint(`${LM_STUDIO_URL}/api/hub/models`);

  console.log('\n✨ Test complete!');
}

if (require.main === module) {
  main().catch(console.error);
}