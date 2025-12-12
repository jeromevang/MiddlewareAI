const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '../src/server.js');
const marker = "app.post('/search'";
const telemetryFlag = "app.get('/telemetry'";

const text = fs.readFileSync(serverPath, 'utf8');
if (text.includes(telemetryFlag)) {
    console.log('Telemetry routes already present, skipping');
    process.exit(0);
}

const eol = text.includes('\r\n') ? '\r\n' : '\n';
const snippet = [
    '',
    "app.get('/telemetry', (_req, res) => {",
    '    res.json(buildTelemetryStatus());',
    '});',
    '',
    "app.post('/telemetry', (req, res) => {",
    '    const { enabled } = req.body || {};',
    "    if (typeof enabled !== 'boolean') {",
    "        return res.status(400).json({ error: 'enabled boolean required' });",
    '    }',
    '    setTelemetryOverride(enabled);',
    "    appendLog(`Telemetry ${enabled ? 'enabled' : 'disabled'} via UI override`, 'info');",
    '    res.json(buildTelemetryStatus());',
    '});',
    '',
    ''
].join(eol);

if (!text.includes(marker)) {
    throw new Error('Insertion marker not found');
}

const updated = text.replace(marker, snippet + marker);
fs.writeFileSync(serverPath, updated, 'utf8');
console.log('Telemetry routes inserted.');
