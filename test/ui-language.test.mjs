import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// Shipped app code owns UI/error/help strings. User fixtures and external assets
// are deliberately excluded, so Korean document content remains fully supported.
test('app-owned UI, server errors and CLI help stay in English', async () => {
  for (const directory of ['public', 'lib', 'bin']) {
    for (const name of await readdir(new URL('../' + directory + '/', import.meta.url))) {
      if (!/\.(?:html|js|mjs)$/.test(name)) continue;
      const source = await readFile(new URL('../' + directory + '/' + name, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u, directory + '/' + name + ' contains an untranslated app string');
      if (name.endsWith('.html')) assert.match(source, /<html lang="en">/, name + ' declares English');
    }
  }
});
