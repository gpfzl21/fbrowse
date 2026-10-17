import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { atomicJson } from './storage.mjs';
import { digest, editorDirectory } from './editor-locks.mjs';

async function location(project, rootId, boundary, relative) {
  return path.join(await editorDirectory('views'), digest(JSON.stringify([project, rootId, boundary, relative])) + '.json');
}

export async function readViewPreference(boundary, relative, fallback, project = boundary, rootId = 'project') {
  let file;
  try {
    file = await fs.open(await location(project, rootId, boundary, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || info.size > 32_768) return fallback;
    const value = JSON.parse(await file.readFile('utf8'));
    return value.version === 1 && value.project === project && value.root_id === rootId && value.root === boundary && value.path === relative &&
      ['source', 'preview'].includes(value.tab) ? value.tab : fallback;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback;
    throw error;
  } finally { await file?.close(); }
}

export async function writeViewPreference(boundary, relative, tab, project = boundary, rootId = 'project') {
  // One lazily addressed record per file: no recent-file list, scanning, cap,
  // document contents, or undo history. Atomic replacement makes readers safe.
  await atomicJson(await location(project, rootId, boundary, relative), { version: 1, project, root_id: rootId, root: boundary, path: relative, tab });
}
