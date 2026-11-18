import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export function readLocalInventory(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('La base SQLite no está íntegra.');
    const payload = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload);
    const hasPhotos = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'set_photos'").get();
    const photos = hasPhotos ? db.prepare('SELECT id, set_id, mime, content FROM set_photos').all()
      .map(({ id, set_id, mime, content }) => ({ id, set_id, mime, data: Buffer.from(content).toString('base64') })) : [];
    return { payload, photos };
  } finally {
    db.close();
  }
}

export async function restoreInventory(url, key, { payload, photos }, send = fetch) {
  const host = url.replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(host) || !/^sb_secret_[\w-]+$/.test(key ?? '')) {
    throw new Error('Indica la URL del proyecto y una clave privada sb_secret_ en SUPABASE_SECRET_KEY.');
  }
  const response = await send(host + '/rest/v1/rpc/lego_restore', {
    method: 'POST', redirect: 'error',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_payload: payload, p_photos: photos }),
  });
  if (!response.ok) throw new Error(`Supabase rechazó la migración (HTTP ${response.status}). Comprueba el proyecto, la clave y las tablas.`);
  if (await response.json() !== true) throw new Error('Ese proyecto ya tiene un inventario. La migración requiere una base nueva.');
  return { sets: payload.copies.length, cajas: payload.boxes.length, listados: payload.catalog.length, fotos: photos.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [path, url] = process.argv.slice(2);
  if (!path || !url) throw new Error('Uso: node migrar-supabase.mjs INVENTARIO.sqlite URL_PROYECTO');
  console.log(await restoreInventory(url, process.env.SUPABASE_SECRET_KEY, readLocalInventory(path)));
}
