#!/usr/bin/env node
import { main } from '../lib/cli.mjs';

process.umask(0o077);
try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error('Node.js 22.12 or later is required.');
  }
  await main(process.argv.slice(2));
} catch (error) {
  const messages = new Map([
    ['Root ID already exists', 'Root ID already exists.'],
    ['Unknown root ID', 'Root ID does not exist.'],
    ['Root ID: 1–48 ASCII letters/digits/_/-, excluding project', 'Root IDs must be 1–48 letters, digits, _ or -; project is reserved.'],
    ['Root name is required (max 120 characters)', 'A root name is required (up to 120 characters).'],
    ['Invalid project root configuration', 'Invalid project root configuration.'],
    ['Invalid roots', 'Invalid root configuration.'],
    ['Invalid root name', 'Invalid root name.'],
    ['Root paths must be absolute', 'Root paths must be absolute.'],
    ['Timed out waiting for root configuration lock', 'Timed out waiting for the root configuration lock.'],
  ]);
  const message = messages.get(error.message) ?? (error.code === 'ENOENT' ? `Path not found: ${error.path ?? error.message}` :
    ['EACCES', 'EPERM'].includes(error.code) ? `Permission denied: ${error.path ?? error.message}` : error.message);
  console.error(`fbrowse: ${message}`);
  process.exitCode = 1;
}
