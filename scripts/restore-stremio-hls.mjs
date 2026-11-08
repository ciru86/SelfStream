#!/usr/bin/env node

// Reapply the two Stremio HLS segment fixes after syncing the upstream fork.
// Run from the repository root: node scripts/restore-stremio-hls.mjs
// Add --check to verify without changing files.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const check = args.includes('--check');
const fileArg = args.find((arg) => arg !== '--check');
if (args.length > (check ? 2 : 1)) {
    console.error('Usage: node scripts/restore-stremio-hls.mjs [--check] [path/to/addon.ts]');
    process.exit(2);
}

const file = resolve(fileArg || 'src/addon.ts');
const source = readFileSync(file, 'utf8');
const startMarker = "app.get('/proxy/hls/segment.ts', async (req: any, res: any) => {";
const endMarker = '// Subtitle m3u8 wrapper';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0 || source.indexOf(startMarker, start + 1) >= 0) {
    console.error('Segment proxy not found uniquely; review src/addon.ts manually.');
    process.exit(1);
}

let route = source.slice(start, end);
const changes = [];

function replaceOnce(oldText, newText, label) {
    const position = route.indexOf(oldText);
    if (position < 0 || route.indexOf(oldText, position + 1) >= 0) {
        throw new Error(`${label}: expected code not found uniquely; review the upstream changes manually.`);
    }
    route = route.slice(0, position) + newText + route.slice(position + oldText.length);
}

try {
    const mimePresent = route.includes("upstreamContentType?.toLowerCase().startsWith('text/html')")
        && route.includes("res.setHeader('Content-Type', contentType)");
    if (!mimePresent) {
        replaceOnce(
            "        const contentType = respHeaders['content-type'] || 'video/mp2t';",
            [
                "        // VixSrc serves encrypted MPEG-TS segments as text/html. Keep binary",
                "        // responses such as HLS keys intact, but label disguised segments correctly.",
                "        const rawContentType = respHeaders['content-type'];",
                '        const upstreamContentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;',
                "        const contentType = upstreamContentType?.toLowerCase().startsWith('text/html')",
                "            ? 'video/mp2t'",
                "            : upstreamContentType || 'video/mp2t';",
            ].join('\n'),
            'MIME type',
        );
        changes.push('MIME type');
    }

    const rangeMarkers = [
        'const requestHeaders = req.headers.range',
        'statusCode !== 200 && statusCode !== 206',
        'res.status(statusCode);',
        "['content-length', 'content-range', 'accept-ranges']",
        "res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');",
    ];
    const presentCount = rangeMarkers.filter((marker) => route.includes(marker)).length;
    if (presentCount > 0 && presentCount < rangeMarkers.length) {
        throw new Error('Range support is only partly present; review the route manually.');
    }
    if (presentCount === 0) {
        replaceOnce(
            "        const { body, statusCode, headers: respHeaders } = await request(upstream, { headers });\n        if (statusCode !== 200) {",
            [
                '        const requestHeaders = req.headers.range',
                '            ? { ...headers, Range: req.headers.range }',
                '            : headers;',
                '        const { body, statusCode, headers: respHeaders } = await request(upstream, { headers: requestHeaders });',
                '        if (statusCode !== 200 && statusCode !== 206) {',
            ].join('\n'),
            'Range request',
        );
        replaceOnce(
            "        res.setHeader('Content-Type', contentType);\n        res.setHeader('Cache-Control', 'public, max-age=3600');",
            [
                '        res.status(statusCode);',
                "        res.setHeader('Content-Type', contentType);",
                "        res.setHeader('Cache-Control', 'public, max-age=3600');",
                "        for (const name of ['content-length', 'content-range', 'accept-ranges']) {",
                '            const value = respHeaders[name];',
                '            if (value) res.setHeader(name, value);',
                '        }',
                "        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');",
            ].join('\n'),
            'Range response',
        );
        changes.push('Range support');
    }
} catch (error) {
    console.error(error.message);
    process.exit(1);
}

if (check) {
    console.log(changes.length ? `Missing: ${changes.join(', ')}` : 'Both HLS fixes are present.');
    process.exit(changes.length ? 1 : 0);
}

if (changes.length) {
    writeFileSync(file, source.slice(0, start) + route + source.slice(end));
    console.log(`Applied: ${changes.join(', ')}.`);
} else {
    console.log('Both HLS fixes are already present; no changes made.');
}
