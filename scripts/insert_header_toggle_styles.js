const fs = require('fs');
const path = require('path');

const targetPath = path.join(__dirname, '..', 'public', 'index.html');
const marker = '    .panel-controls input[type="checkbox"] { accent-color: var(--accent); }';
const addition = [
  '    .header-toggle {',
  '      display: flex;',
  '      align-items: center;',
  '      gap: 6px;',
  '      font-size: 12px;',
  '      color: var(--muted);',
  '    }',
  '    .header-toggle input[type="checkbox"] {',
  '      accent-color: var(--accent);',
  '    }'
].join('\n');

try {
  const original = fs.readFileSync(targetPath, 'utf8');
  if (!original.includes(marker)) {
    throw new Error('Marker CSS rule not found.');
  }
  if (original.includes('    .header-toggle {')) {
    console.log('Header toggle styles already inserted.');
    process.exit(0);
  }
  const updated = original.replace(marker, `${marker}\n${addition}`);
  if (updated === original) {
    throw new Error('Replacement did not modify the file.');
  }
  fs.writeFileSync(targetPath, updated);
  console.log('Header toggle styles inserted.');
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
