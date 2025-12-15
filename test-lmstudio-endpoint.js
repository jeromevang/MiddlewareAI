#!/usr/bin/env node

const axios = require('axios');

async function testLMStudioEndpoint() {
  try {
    console.log('Testing LM Studio registry endpoint...');
    const response = await axios.get('http://localhost:4000/models/lmstudio/discover');
    console.log('Response:', response.data);
  } catch (error) {
    console.log('Error:', error.response?.status, error.response?.data || error.message);
  }
}

testLMStudioEndpoint();
