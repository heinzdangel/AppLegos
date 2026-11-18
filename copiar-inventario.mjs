import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const [sourceArg, destinationArg, mode] = process.argv.slice(2);
if (!sourceArg || !destinationArg || (mode && mode !== '--restaurar')) {
  throw new Error('Uso: node copiar-inventario.mjs ORIGEN DESTINO [--restaurar]');
}
const source = resolve(sourceArg);
const destination = resolve(destinationArg);

function readInventory(db) {
  const row = db.prepare('SELECT version, payload FROM app_state WHERE id = 1').get();
  const { copies, boxes, catalog } = JSON.parse(row.payload);
  const { photos } = db.prepare('SELECT COUNT(*) AS photos FROM set_photos').get();
  return { version: row.version, sets: copies.length, cajas: boxes.length, listados: catalog.length, fotos: photos };
}

if (existsSync(destination)) {
  if (mode !== '--restaurar') throw new Error('El fichero de destino ya existe. Elige un nombre nuevo para la copia.');
  const current = new DatabaseSync(destination, { readOnly: true });
  try {
    const state = readInventory(current);
    if (state.version !== 0 || state.sets || state.cajas || state.fotos) {
      throw new Error('El destino ya contiene un inventario. Usa un servicio recién creado para la primera migración.');
    }
  } finally {
    current.close();
  }
}

const src = new DatabaseSync(source, { readOnly: true });
try {
  if (src.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('El inventario de origen no está íntegro.');
  readInventory(src);
  mkdirSync(dirname(destination), { recursive: true });
  await backup(src, destination, { rate: 128 });
} finally {
  src.close();
}

const saved = new DatabaseSync(destination, { readOnly: true });
try {
  if (saved.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('La copia de SQLite no está íntegra.');
  console.log(JSON.stringify(readInventory(saved)));
} finally {
  saved.close();
}
