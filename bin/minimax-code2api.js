#!/usr/bin/env node
// Launcher for `npx minimax-code2api` / global install usage.
// Usage: minimax-code2api [path/to/config.json]
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

const serverJs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js');
const child = spawn(process.execPath, [serverJs, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
