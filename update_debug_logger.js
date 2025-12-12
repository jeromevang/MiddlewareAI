const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'debug_logger.js');
const anchor = 'const recentEvents = new Map();';

function ensureTelemetryLine(content, newline) {
    const telemetryLinePattern = /\r?\nlet telemetryOverride = null;\r?\n?/g;
    content = content.replace(telemetryLinePattern, newline);
    if (!content.includes(anchor)) {
        throw new Error('Anchor line not found in debug_logger.js');
    }
    return content.replace(
        anchor,
        `${anchor}${newline}${newline}let telemetryOverride = null;${newline}`
    );
}

function replaceTelemetryBlock(content, newline) {
    const start = content.indexOf('function isTelemetryEnabled()');
    const end = content.indexOf('function resolveEndpoint');
    if (start === -1 || end === -1 || end <= start) {
        throw new Error('Unable to locate telemetry block boundaries');
    }

    const newBlock = [
        'function isTelemetryEnabled() {',
        '    if (telemetryOverride !== null) {',
        '        return telemetryOverride;',
        '    }',
        '    const flag = process.env.ENABLE_DEBUG_TELEMETRY;',
        '    if (!flag) {',
        '        return false;',
        '    }',
        "    const normalized = String(flag).trim().toLowerCase();",
        "    return normalized === '1' || normalized === 'true' || normalized === 'yes';",
        '}',
        '',
        'function setTelemetryOverride(value) {',
        '    if (value === null || value === undefined) {',
        '        telemetryOverride = null;',
        '        return telemetryOverride;',
        '    }',
        '    telemetryOverride = Boolean(value);',
        '    return telemetryOverride;',
        '}',
        '',
        'function getTelemetryOverride() {',
        '    return telemetryOverride;',
        '}',
        ''
    ].join(newline);

    return `${content.slice(0, start)}${newBlock}${content.slice(end)}`;
}

function updateExports(content, newline) {
    const exportsRegex = /module\.exports = {\s*[\s\S]*?};/;
    if (!exportsRegex.test(content)) {
        throw new Error('module.exports block not found');
    }
    const exportsBlock = [
        'module.exports = {',
        '    logDebugEvent,',
        '    isTelemetryEnabled,',
        '    setTelemetryOverride,',
        '    getTelemetryOverride',
        '};'
    ].join(newline);
    return content.replace(exportsRegex, exportsBlock);
}

function applyUpdates() {
    let content = fs.readFileSync(filePath, 'utf8');
    const newline = content.includes('\r\n') ? '\r\n' : '\n';

    content = ensureTelemetryLine(content, newline);
    content = replaceTelemetryBlock(content, newline);
    content = updateExports(content, newline);

    fs.writeFileSync(filePath, content, 'utf8');
}

applyUpdates();
console.log('Updated src/debug_logger.js');
