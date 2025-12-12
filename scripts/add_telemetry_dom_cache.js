const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'public', 'index.html');
const marker = "    const logAutoScroll = document.getElementById('logAutoScroll');";
const snippet = [
  "    const telemetryToggle = document.getElementById('telemetryToggle');",
  "    const telemetryState = document.getElementById('telemetryState');",
].join('\n');

let fileContents;
try {
  fileContents = fs.readFileSync(filePath, 'utf8');
} catch (err) {
  console.error('Failed to read target file:', err.message);
  process.exitCode = 1;
  return;
}

if (fileContents.includes(snippet)) {
  console.log('Telemetry DOM cache snippet already present.');
  return;
}

if (!fileContents.includes(marker)) {
  console.error('Could not locate marker line in index.html.');
  process.exitCode = 1;
  return;
}

const updated = fileContents.replace(marker, `${marker}\n${snippet}`);

if (updated === fileContents) {
  console.log('No changes were applied.');
  return;
}

try {
  fs.writeFileSync(filePath, updated);
  console.log('Telemetry DOM cache snippet inserted.');
} catch (err) {
  console.error('Failed to write updated file:', err.message);
  process.exitCode = 1;
}
