// Bundles the extension into dist/ with esbuild.
//
// Each content script world gets its own bundle because they cannot share a module
// graph at runtime: the MAIN world script runs in page scope with no chrome.* access,
// and the isolated script runs in extension scope. They talk over window.postMessage.
//
// Pass --release to strip the dev panel, --watch to rebuild on change.

import { context, build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(root, 'dist');

const release = process.argv.includes('--release');
const watch = process.argv.includes('--watch');

const entryPoints = {
  'content/index': resolve(root, 'src/content/index.ts'),
  'content/main-world': resolve(root, 'src/content/main-world.ts'),
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints,
  outdir: outDir,
  bundle: true,
  format: 'iife', // content scripts are loaded as classic scripts, not modules

  target: 'chrome111', // content_scripts "world": "MAIN" landed in Chrome 111
  platform: 'browser',
  sourcemap: release ? false : 'inline',
  minify: release,
  legalComments: 'none',
  define: {
    DEV_TOOLS: String(!release),
  },
  logLevel: 'info',
};

async function copyStatic() {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  if (release) {
    manifest.name = manifest.name.replace(/ \(dev\)$/, '');
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  await cp(resolve(root, 'src/assets'), resolve(outDir, 'assets'), {
    recursive: true,
    force: true,
  }).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

await rm(outDir, { recursive: true, force: true });
await copyStatic();

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching for changes, ctrl-c to stop');
} else {
  await build(options);
  console.log(`built ${release ? 'release' : 'dev'} bundle into dist/`);
}
