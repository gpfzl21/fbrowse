import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { failure, inside, listedEntry, resolvePath, visible } from './files.mjs';

// Resolve document links in filesystem space, before URL normalization can
// consume ../ segments that leave the current registered root.
export async function resolveMarkdownLink(roots, sourceRoot, sourcePath, href, showHidden = false) {
  if (!Object.hasOwn(roots, sourceRoot) || typeof href !== 'string' || !href ||
      href.includes('\\') || /[\0-\x1f\x7f]/.test(href)) throw failure('Invalid document link', 400);
  const sourceBoundary = roots[sourceRoot].path;
  await resolvePath(sourceBoundary, sourcePath, showHidden);
  const url = new URL(href, 'http://fbrowse.local');
  let target, preferred;
  if (url.protocol === 'file:') target = fileURLToPath(url);
  else {
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) throw failure('Invalid document link', 400);
    const pathname = decodeURIComponent(href.split(/[?#]/, 1)[0]);
    const route = /^\/roots\/([^/]+)\/files\/(.*)$/.exec(pathname);
    let relative;
    if (route) { preferred = route[1]; relative = route[2]; }
    else if (['/', '/_preview'].includes(pathname) && url.searchParams.has('path')) {
      preferred = url.searchParams.get('root') || sourceRoot; relative = url.searchParams.get('path');
    } else if (pathname.startsWith('/files/')) { preferred = 'project'; relative = pathname.slice(7); }
    if (relative !== undefined) {
      if (!Object.hasOwn(roots, preferred)) throw failure('Unknown root');
      // App URLs already identify a root-relative path. Keep their boundary checks.
      await resolvePath(roots[preferred].path, relative, showHidden);
      target = path.join(roots[preferred].path, relative);
    } else target = path.resolve(path.dirname(path.join(sourceBoundary, sourcePath)), pathname || path.basename(sourcePath));
  }
  if (target.includes('\0') || target.includes('\\')) throw failure('Invalid document link', 400);
  const candidates = Object.entries(roots).sort(([a, left], [b, right]) =>
    Number(b === preferred) - Number(a === preferred) || right.path.length - left.path.length ||
    Number(b === sourceRoot) - Number(a === sourceRoot));
  async function mapped(absolute) {
    for (const [id, record] of candidates) {
      if (!inside(record.path, absolute)) continue;
      const relative = path.relative(record.path, absolute);
      if (!visible(relative, showHidden)) throw failure('Path is excluded');
      let entry;
      try { entry = await listedEntry(record.path, relative, id, showHidden); }
      catch (error) { if (error.status === 403) continue; throw error; }
      if (entry.available !== false) return { entry, hash: url.hash, root_path: record.path, source_root_path: sourceBoundary };
    }
  }
  const direct = await mapped(target);
  if (direct) return direct;
  // A symlink may lead to a different registered root. Open the target through
  // that root, retaining the normal preview/editor boundary checks.
  const canonical = await fs.realpath(target);
  const resolved = await mapped(canonical);
  if (resolved) return resolved;
  throw failure('Connect the link target folder in Manage Roots, then open it again.', 400);
}
