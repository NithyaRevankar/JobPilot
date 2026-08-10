import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import fs from 'node:fs';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = 'dist';

/**
 * Static files Chrome loads directly — they are NOT part of the React bundle and
 * must land in dist/ byte-for-byte.
 *
 * WHY A COPY AND NOT A ROLLUP INPUT: background/service-worker.js and
 * content/content-script.js were checked for ES module syntax before this was
 * written. Neither has a single `import`, `export`, dynamic `import()` or
 * `importScripts` — the worker is flat top-level code and the content script is
 * one self-contained IIFE. Nothing to bundle, so bundling them would only add a
 * hashed filename, a rewritten manifest and a sourcemap for zero benefit. It
 * would also risk breaking test/worker-harness.mjs, which imports
 * background/service-worker.js from SOURCE. A copy keeps source and shipped
 * artifact identical.
 *
 * `from` is repo-relative; `to` is dist-relative.
 */
const STATIC_COPIES = [
  { from: 'manifest.json', to: 'manifest.json' },
  { from: 'background/service-worker.js', to: 'background/service-worker.js' },
  { from: 'content/content-script.js', to: 'content/content-script.js' },
  // Icons only. make_icons.py is a build-time authoring script; it has no place
  // in a shipped extension.
  { from: 'assets', to: 'assets', filter: (src) => !src.endsWith('.py') },
];

/**
 * Copies the static extension shell into dist/ and then PROVES the manifest is
 * still internally consistent: every path manifest.json names must exist in
 * dist/. Without this check a renamed output path fails silently at build time
 * and only shows up as a blank side panel in Chrome.
 */
function extensionShell() {
  return {
    name: 'jobpilot-extension-shell',
    apply: 'build',
    // Runs last so it cannot be clobbered by Vite's own emit.
    enforce: 'post',

    // Make `vite build --watch` react to the static files too, not just JSX.
    buildStart() {
      for (const { from } of STATIC_COPIES) {
        const abs = resolve(ROOT, from);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) this.addWatchFile(abs);
      }
    },

    // writeBundle runs AFTER Vite has emptied outDir and written its own output,
    // so emptyOutDir can never delete these copies. It also re-runs on every
    // rebuild in watch mode.
    writeBundle() {
      const outAbs = resolve(ROOT, OUT_DIR);

      for (const { from, to, filter } of STATIC_COPIES) {
        const src = resolve(ROOT, from);
        const dest = join(outAbs, to);
        if (!fs.existsSync(src)) {
          this.error(`extension shell: missing source file ${from}`);
        }
        fs.mkdirSync(dirname(dest), { recursive: true });
        fs.cpSync(src, dest, { recursive: true, filter });
      }

      verifyManifest.call(this, outAbs);
    },
  };
}

/** Collect every extension-internal path manifest.json points at. */
function manifestPaths(manifest) {
  const paths = [];
  const push = (p) => {
    if (typeof p === 'string' && p && !/^[a-z]+:/i.test(p)) paths.push(p);
  };

  push(manifest.background?.service_worker);
  push(manifest.side_panel?.default_path);
  for (const cs of manifest.content_scripts ?? []) {
    for (const f of cs.js ?? []) push(f);
    for (const f of cs.css ?? []) push(f);
  }
  for (const p of Object.values(manifest.icons ?? {})) push(p);
  for (const p of Object.values(manifest.action?.default_icon ?? {})) push(p);
  push(manifest.action?.default_popup);
  for (const r of manifest.web_accessible_resources ?? []) {
    for (const f of r.resources ?? []) push(f);
  }
  return paths;
}

function verifyManifest(outAbs) {
  const manifestFile = join(outAbs, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

  const missing = manifestPaths(manifest).filter(
    (p) => !fs.existsSync(join(outAbs, p)),
  );

  if (missing.length) {
    this.error(
      `manifest.json points at ${missing.length} path(s) that do not exist in ${OUT_DIR}/:\n` +
        missing.map((p) => `  - ${p}`).join('\n') +
        `\nEither fix the output path or rewrite the manifest as it is copied.`,
    );
  }
}

export default defineConfig(({ mode }) => ({
  root: ROOT,

  // MUST stay relative. A chrome-extension:// page resolving a root-absolute
  // "/bundle/panel.js" would look for chrome-extension://<id>/bundle/... only by
  // luck of the extension root, and any nesting change breaks it. './' makes
  // Vite emit paths relative to the HTML file itself.
  base: './',

  plugins: [react(), extensionShell()],

  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,

    // manifest.json declares minimum_chrome_version 116, which is far past every
    // syntax feature esbuild/rolldown would otherwise down-level.
    target: 'esnext',

    // Vite's own output lives in dist/bundle/ so it can never collide with the
    // extension's own dist/assets/ icon directory that manifest.json references.
    assetsDir: 'bundle',

    // Chrome 116 supports <link rel="modulepreload"> natively; the polyfill is
    // dead weight in an extension.
    modulePreload: { polyfill: false },

    // External .map files only. Never 'inline' and never eval-based — MV3 CSP is
    // script-src 'self', so an eval sourcemap would be blocked outright.
    sourcemap: mode !== 'production',

    rollupOptions: {
      input: {
        panel: resolve(ROOT, 'sidepanel/panel.html'),
      },
    },
  },
}));
