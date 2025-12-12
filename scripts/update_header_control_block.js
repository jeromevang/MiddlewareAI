const fs = require('fs');
const path = require('path');

const targetPath = path.join(__dirname, '..', 'public', 'index.html');

try {
  const original = fs.readFileSync(targetPath, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';

  const blockToReplace = [
    '    <div class="row">',
    '      <label class="muted">API Key</label>',
    '      <input id="apiKey" type="password" placeholder="Bearer token (optional)" />',
    '      <span id="wsStatus" class="badge">WS: connecting</span>',
    '    </div>'
  ].join(newline);

  const replacementBlock = [
    '    <div class="row">',
    '      <label class="muted">API Key</label>',
    '      <input id="apiKey" type="password" placeholder="Bearer token (optional)" />',
    '      <span id="wsStatus" class="badge">WS: connecting</span>',
    '      <label class="header-toggle">',
    '        <input type="checkbox" id="telemetryToggle" />',
    '        Telemetry',
    '      </label>',
    '      <span id="telemetryState" class="badge secondary">Telemetry: env</span>',
    '    </div>'
  ].join(newline);

  if (!original.includes(blockToReplace)) {
    throw new Error('Target header control block not found.');
  }

  if (original.includes('<span id="telemetryState"')) {
    console.log('Telemetry controls already present.');
    process.exit(0);
  }

  const updated = original.replace(blockToReplace, replacementBlock);
  if (updated === original) {
    throw new Error('No changes applied.');
  }

  fs.writeFileSync(targetPath, updated, 'utf8');
  console.log('Header control block updated.');
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
