const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, '../public/index.html');
const marker = "    function escapeHtml(str = '') {\n      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\n    }\n\n";
const block = `    function applyTelemetryState(state) {
      if (!telemetryToggle) return;
      const enabled = !!(state && state.enabled);
      telemetryToggle.checked = enabled;
      if (telemetryState) {
        const sourceLabel = state && state.source === 'override' ? 'override' : 'env';
        telemetryState.textContent = \`Telemetry: \${enabled ? 'on' : 'off'} (\${sourceLabel})\`;
        telemetryState.className = \`badge \${enabled ? 'ok' : 'bad'}\`;
      }
    }

    async function refreshTelemetryState() {
      if (!telemetryToggle) return;
      try {
        const data = await fetchJSON('/telemetry');
        applyTelemetryState(data);
      } catch (err) {
        console.error('Failed to load telemetry state', err);
        if (telemetryState) {
          telemetryState.textContent = 'Telemetry: error';
          telemetryState.className = 'badge bad';
        }
      }
    }

    async function handleTelemetryToggleChange() {
      if (!telemetryToggle) return;
      const desired = telemetryToggle.checked;
      telemetryToggle.disabled = true;
      try {
        const data = await fetchJSON('/telemetry', {
          method: 'POST',
          body: JSON.stringify({ enabled: desired })
        });
        applyTelemetryState(data);
      } catch (err) {
        console.error('Telemetry toggle failed', err);
        telemetryToggle.checked = !desired;
        if (telemetryState) {
          telemetryState.textContent = 'Telemetry: failed';
          telemetryState.className = 'badge bad';
        }
      } finally {
        telemetryToggle.disabled = false;
      }
    }
\n`;

if (!fs.existsSync(filePath)) {
  console.error('Target file missing:', filePath);
  process.exit(1);
}

const original = fs.readFileSync(filePath, 'utf8');

if (original.includes('function applyTelemetryState(')) {
  console.log('Telemetry helpers already present.');
  process.exit(0);
}

const markerWin = marker.replace(/\n/g, '\r\n');
let idx = original.indexOf(markerWin);
let activeMarker = markerWin;

if (idx === -1) {
  idx = original.indexOf(marker);
  activeMarker = marker;
}

if (idx === -1) {
  console.error('escapeHtml marker not found; file layout changed?');
  process.exit(1);
}

const newline = activeMarker.includes('\r\n') ? '\r\n' : '\n';
const blockWithNewlines = block.replace(/\n/g, newline);
const updated = original.slice(0, idx + activeMarker.length) + blockWithNewlines + original.slice(idx + activeMarker.length);

fs.writeFileSync(filePath, updated);
console.log('Telemetry helper block inserted.');
