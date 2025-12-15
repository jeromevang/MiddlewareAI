const http = require('http');

const options = {
    hostname: 'localhost',
    port: 4000,
    path: '/lmstudio/models/load-required',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    }
};

const req = http.request(options, (res) => {
    console.log(`Status: ${res.statusCode}`);
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    res.on('end', () => {
        console.log('Response:', data);
    });
});

req.on('error', (e) => {
    console.error('Error:', e.message);
});

req.end();