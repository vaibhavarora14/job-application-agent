// Symlink-safe "is this module the process entrypoint?" check.
//
// Node resolves the main module through fs.realpath, so `import.meta.url` names the real file, while
// `process.argv[1]` keeps the path exactly as invoked. Comparing them directly fails whenever the
// script is reached through a symlink (a symlinked ~/.agents or skills directory, a symlinked
// script, a macOS /var -> /private/var temp path), and the CLI then exits 0 with no output.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function realOrResolved(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function same(a, b, platform) {
  // Windows and default macOS volumes are case-insensitive; realpath normalizes case on Windows
  // but not always the drive letter, so compare case-insensitively there.
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isEntrypoint(moduleUrl, argv1 = process.argv[1], platform = process.platform) {
  if (!argv1 || !moduleUrl) return false;
  try {
    if (pathToFileURL(argv1).href === moduleUrl) return true;
    return same(realOrResolved(argv1), realOrResolved(fileURLToPath(moduleUrl)), platform);
  } catch {
    return false;
  }
}
