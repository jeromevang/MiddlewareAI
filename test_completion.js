#!/usr/bin/env node

const axios = require('axios');

async function testCompletion() {
  try {
    console.log('Testing completion endpoint...');

    const response = await axios.post('http://localhost:4000/v1/chat/completions', {
      messages: [
        {
          role: 'user',
          content: 'Hello, can you respond with a simple greeting?'
        }
      ],
      temperature: 0.7,
      max_tokens: 100
    }, {
      timeout: 30000
    });

    console.log('Response status:', response.status);
    console.log('Response data:', JSON.stringify(response.data, null, 2));

    if (response.data.choices && response.data.choices[0]) {
      console.log('Completion successful!');
      console.log('Model used:', response.data.model || 'unknown');
      console.log('Response:', response.data.choices[0].message?.content || 'no content');
    } else {
      console.log('Unexpected response format');
    }

  } catch (error) {
    console.error('Error testing completion:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
  }
}

testCompletion();
