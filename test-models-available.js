#!/usr/bin/env node

const axios = require('axios');

async function testEndpoints() {
  try {
    console.log('Testing /models/available endpoint...');
    const response1 = await axios.get('http://localhost:4000/models/available');
    console.log('Available models count:', response1.data.models?.length || 0);

    console.log('\nTesting /models/lmstudio/discover endpoint...');
    const response2 = await axios.get('http://localhost:4000/models/lmstudio/discover');
    console.log('LM Studio models count:', response2.data.models?.length || 0);
  } catch (error) {
    console.log('Error:', error.response?.status, error.response?.data || error.message);
  }
}

testEndpoints();
