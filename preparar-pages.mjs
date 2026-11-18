import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const output = join(root, 'docs');
const config = join(output, 'config.js');
const useSupabase = process.argv[2] === '--supabase';
const api = useSupabase ? undefined : process.argv[2];
if (api) {
  const url = new URL(api);
  if (url.protocol !== 'https:' || url.origin !== api) {
    throw new Error('Indica el origen HTTPS del servidor, sin ruta ni barra final.');
  }
}
mkdirSync(output, { recursive: true });
for (const file of ['app.js', 'styles.css', 'icon.svg', 'part.svg', 'manifest.webmanifest']) {
  copyFileSync(join(root, 'public', file), join(output, file));
}
const csp = "default-src 'self'; connect-src https:; img-src 'self' https: blob:; object-src 'none'; base-uri 'none'; form-action 'none'";
const index = readFileSync(join(root, 'public', 'index.html'), 'utf8')
  .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`);
writeFileSync(join(output, 'index.html'), index);
if (useSupabase) {
  const shared = join(root, 'supabase', 'functions', '_shared');
  mkdirSync(join(shared, 'catalogo'), { recursive: true });
  for (const file of ['catalog.mjs', 'inventory.mjs', 'sets.mjs', 'rebrickable-html.mjs', 'set-photos.mjs',
    'catalogo/Colores-Rebrickable.json']) {
    copyFileSync(join(root, file), join(shared, file));
  }
  if (!existsSync(config) || !readFileSync(config, 'utf8').includes('window.inventarioSupabase')) {
    writeFileSync(config, 'window.inventarioPages = true;\nwindow.inventarioSupabase = { url: "", key: "" };\n');
  }
} else if (api || !existsSync(config)) {
  writeFileSync(config, `window.inventarioPages = true;\nwindow.inventarioApi = ${JSON.stringify(api ?? '')};\n`);
}
copyFileSync(join(root, 'catalogo', 'Muestra-inventario.csv'), join(output, 'muestra.csv'));
writeFileSync(join(output, '.nojekyll'), '');
console.log('Archivos de GitHub Pages preparados en docs/.');
