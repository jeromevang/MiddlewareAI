const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'public', 'index.html');
const rawContent = fs.readFileSync(filePath, 'utf8');
const normalize = (str) => str.replace(/\r\n/g, '\n');
const denormalize = (str, useCRLF) => (useCRLF ? str.replace(/\n/g, '\r\n') : str);
const usesCRLF = /\r\n/.test(rawContent);
const content = normalize(rawContent);

const snippet = [
  '    if (telemetryToggle) {',
  "      telemetryToggle.addEventListener('change', handleTelemetryToggleChange);",
  '    }'
].join('\n');

if (content.includes(snippet)) {
  console.log('Telemetry toggle listener already present.');
  process.exit(0);
}

const targetBlock = [
  '    if (logAutoScroll) {',
  "      logAutoScroll.addEventListener('change', () => renderLogsTable());",
  '    }',
  '',
  ''
].join('\n');

if (!content.includes(targetBlock)) {
  throw new Error('Could not locate logAutoScroll listener block.');
}

const replacement = [
  '    if (logAutoScroll) {',
  "      logAutoScroll.addEventListener('change', () => renderLogsTable());",
  '    }',
  '    if (telemetryToggle) {',
  "      telemetryToggle.addEventListener('change', handleTelemetryToggleChange);",
  '    }',
  '',
  ''
].join('\n');

const updated = content.replace(targetBlock, replacement);
fs.writeFileSync(filePath, denormalize(updated, usesCRLF), 'utf8');
console.log('Telemetry toggle change listener added.');
