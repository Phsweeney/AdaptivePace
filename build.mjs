// Bundles the extension into dist/ with esbuild.
//
// Two passes, because a single esbuild call emits one output format and this extension needs
// two. Content scripts, the options page and the popup are loaded as classic scripts, so they
// are IIFE. The service worker is declared "type": "module" in the manifest, so it must be
// ESM; shipping it as an IIFE registers no listeners and fails silently.
//
// Each content script world gets its own bundle because they cannot share a module graph at
// runtime: the MAIN world script runs in page scope with no chrome.* access, and the isolated
// script runs in extension scope. They talk over window.postMessage.
//
// Pass --release to strip the dev panel, --watch to rebuild on change.

import { context, build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(root, 'dist');

const release = process.argv.includes('--release');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
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

/** @type {import('esbuild').BuildOptions[]} */
const passes = [
  {
    ...shared,
    format: 'iife',
    outdir: outDir,
    entryPoints: {
      'content/index': resolve(root, 'src/content/index.ts'),
      'content/main-world': resolve(root, 'src/content/main-world.ts'),
      'options/options': resolve(root, 'src/options/options.ts'),
      'popup/popup': resolve(root, 'src/popup/popup.ts'),
    },
  },
  {
    ...shared,
    format: 'esm',
    outdir: outDir,
    entryPoints: {
      'background/service-worker': resolve(root, 'src/background/service-worker.ts'),
    },
  },
];

/** Copies the page shells and stylesheets esbuild does not process. */
async function copyPages() {
  for (const page of ['options', 'popup']) {
    const from = resolve(root, 'src', page);
    const to = resolve(outDir, page);
    await mkdir(to, { recursive: true });

    for (const name of await readdir(from)) {
      if (!['.html', '.css'].includes(extname(name))) continue;
      await cp(resolve(from, name), resolve(to, name));
    }
  }
}

async function copyStatic() {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  if (release) {
    manifest.name = manifest.name.replace(/ \(dev\)$/, '');
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  await copyPages();

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
  const contexts = await Promise.all(passes.map((options) => context(options)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('watching for changes, ctrl-c to stop');
} else {
  await Promise.all(passes.map((options) => build(options)));
  console.log(`built ${release ? 'release' : 'dev'} bundle into dist/`);
}
