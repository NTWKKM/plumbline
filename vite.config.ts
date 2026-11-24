import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { defineConfig, type Plugin } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SW_BUILD_PLACEHOLDER = "const BUILD = { version: 'dev', assets: [] };";

/**
 * Stamps dist/sw.js with every emitted file (entry JS and CSS, chunks, the worker, images)
 * and a version derived from their hashed names, so a new build installs a fresh cache.
 */
function serviceWorkerPrecache(): Plugin {
  let outDir = 'dist';
  return {
    name: 'plumbline-sw-precache',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    writeBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((f) => !f.endsWith('.html') && !f.endsWith('.map'))
        .sort();
      const version = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 12);
      const swPath = path.join(outDir, 'sw.js');
      const source = readFileSync(swPath, 'utf8');
      if (!source.includes(SW_BUILD_PLACEHOLDER)) {
        throw new Error('sw.js no longer contains the BUILD placeholder the precache plugin replaces');
      }
      writeFileSync(
        swPath,
        source.replace(SW_BUILD_PLACEHOLDER, `const BUILD = ${JSON.stringify({ version, assets })};`)
      );
    },
  };
}

export default defineConfig(() => {
  return {
    base: './',
    plugins: [react(), tailwindcss(), serviceWorkerPrecache()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
