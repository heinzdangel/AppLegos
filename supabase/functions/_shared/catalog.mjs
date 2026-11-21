import { createHash } from 'node:crypto';

export const headers = [
  'set_num', 'set_name', 'inventory_version', 'part_num', 'part_name', 'element_id',
  'color_id', 'color_name', 'quantity', 'is_spare', 'image_url', 'item_type',
];

const colors = {
  0: 'Negro', 1: 'Azul', 2: 'Verde', 4: 'Rojo', 5: 'Rosa oscuro', 6: 'Marrón',
  7: 'Gris claro', 8: 'Gris oscuro', 14: 'Amarillo', 15: 'Blanco',
  19: 'Beige', 25: 'Naranja', 28: 'Beige oscuro', 70: 'Marrón rojizo', 71: 'Gris azulado claro',
  72: 'Gris azulado oscuro', 179: 'Plateado perlado', 182: 'Naranja transparente',
  288: 'Verde oscuro', 320: 'Rojo oscuro',
};

export function colorLabel(id, fallback) {
  return Object.hasOwn(colors, id) ? colors[id] : fallback;
}

export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function setNumber(value) {
  const code = String(value ?? '').trim().toUpperCase();
  if (/^MOC-\d{1,12}$/.test(code)) return code;
  if (!/^\d{3,12}(?:-\d{1,4})?$/.test(code)) {
    throw new AppError('Introduce un código válido, por ejemplo 60411 o MOC-191120.');
  }
  return code.includes('-') ? code : code + '-1';
}

export function setCode(value) {
  const number = setNumber(value);
  return number.startsWith('MOC-') ? number : number.split('-')[0];
}

export function htmlInventoryCode(value, inventory) {
  const entered = String(value ?? '').trim().toUpperCase();
  const code = setCode(inventory.number);
  const requested = code.startsWith('MOC-') && /^\d{1,12}$/.test(entered) ? 'MOC-' + entered : setCode(entered);
  if (requested !== code) {
    throw new AppError('El HTML corresponde a ' + code + ' y has indicado ' + requested + '. Revisa el código o el archivo.');
  }
  return code;
}

export function lineId(item) {
  return JSON.stringify([item.type, item.part, item.colorId, item.spare]);
}

export function pieceId(item) {
  return JSON.stringify([item.type, item.part, item.colorId]);
}

export function csvRows(input) {
  const rows = [];
  let row = [];
  let field = '';
  let mode = 'start';
  const finish = () => {
    row.push(field);
    field = '';
    mode = 'start';
  };
  const source = input.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  for (const char of source) {
    if (mode === 'quoted') {
      if (char === '"') mode = 'afterQuote';
      else field += char;
      continue;
    }
    if (char === ',' || char === '\n') {
      finish();
      if (char === '\n') {
        if (row.some(cell => cell.trim())) rows.push(row);
        row = [];
      }
    } else if (mode === 'afterQuote' && char === '"') {
      field += char;
      mode = 'quoted';
    } else if (mode === 'start' && char === '"') {
      mode = 'quoted';
    } else if (mode === 'afterQuote' || char === '"') {
      throw new AppError('Hay comillas mal colocadas en el CSV.');
    } else {
      field += char;
      mode = 'unquoted';
    }
  }
  if (mode === 'quoted') throw new AppError('Hay una celda entre comillas sin cerrar.');
  finish();
  if (row.some(cell => cell.trim())) rows.push(row);
  return rows;
}

function imageUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch {
    // Invalid image URLs are reported to the importer.
  }
  throw new AppError('La imagen debe tener una dirección HTTPS válida.');
}

export function parseInventory(input) {
  const [columns, ...rows] = csvRows(input);
  if (!columns || !headers.every(key => columns.includes(key)) || !rows.length || rows.length > 10000) {
    throw new AppError('El CSV debe incluir las 12 columnas de la plantilla y entre 1 y 10 000 líneas.');
  }
  const inventories = new Map();
  for (const [index, cells] of rows.entries()) {
    try {
      if (cells.length !== columns.length) throw new AppError('El número de columnas no coincide.');
      const data = Object.fromEntries(columns.map((key, i) => [key, cells[i].trim()]));
      const number = setNumber(data.set_num);
      const version = data.inventory_version;
      const type = data.item_type || 'part';
      const needed = Number(data.quantity);
      const validCode = /^[\w.-]{1,64}$/;
      if (!validCode.test(version) || !validCode.test(data.part_num) || !validCode.test(data.color_id) ||
          !data.set_name || !data.part_name || !data.color_name ||
          [data.set_name, data.part_name, data.color_name].some(value => value.length > 200) ||
          !/^\d{1,6}$/.test(data.quantity) || needed < 1 ||
          !['true', 'false', '1', '0'].includes(data.is_spare.toLowerCase()) ||
          !['part', 'minifig'].includes(type)) {
        throw new AppError('Revisa los códigos, el color, la cantidad y el tipo de pieza.');
      }
      const id = number + '/' + version;
      const item = {
        part: data.part_num, name: data.part_name, element: data.element_id,
        colorId: data.color_id, color: data.color_name, needed,
        spare: ['true', '1'].includes(data.is_spare.toLowerCase()),
        image: imageUrl(data.image_url), type,
      };
      item.id = lineId(item);
      if (!inventories.has(id)) {
        inventories.set(id, {
          id, number, name: data.set_name, version, source: version === 'muestra' ? 'Muestra' : 'CSV',
          partial: version === 'muestra', items: [],
        });
      }
      const inventory = inventories.get(id);
      if (inventory.name !== data.set_name || inventory.items.some(existing => existing.id === item.id)) {
        throw new AppError('Hay una referencia y color duplicados o varios nombres para el mismo set.');
      }
      inventory.items.push(item);
    } catch (error) {
      throw new AppError('Fila ' + (index + 2) + '. ' + error.message);
    }
  }
  for (const inventory of inventories.values()) inventory.items.sort((a, b) => a.id.localeCompare(b.id));
  return [...inventories.values()];
}

async function rebrickable(path, key, missingIsEmpty = false) {
  const response = await fetch('https://rebrickable.com/api/v3/' + path, {
    headers: { Authorization: 'key ' + key },
    signal: AbortSignal.timeout(12000),
  }).catch(() => null);
  if (response?.status === 404 && missingIsEmpty) return { results: [], next: null };
  if (response?.status === 404) throw new AppError('Rebrickable no encuentra ese set.', 404);
  if ([401, 403].includes(response?.status)) throw new AppError('Revisa la clave de Rebrickable del servidor.', 502);
  if (!response?.ok) throw new AppError('Rebrickable no está disponible ahora. Puedes importar un CSV.', 502);
  return response.json();
}

async function allPages(path, key) {
  const results = [];
  for (let page = 1; page <= 40; page++) {
    const data = await rebrickable(path + '?page_size=500&page=' + page, key, true);
    results.push(...data.results);
    if (!data.next) return results;
  }
  throw new AppError('El inventario supera el límite de páginas de importación.');
}

export async function importRebrickable(value, key) {
  if (!key) throw new AppError('Configura REBRICKABLE_API_KEY en el servidor o importa un CSV.');
  const number = setNumber(value);
  if (number.startsWith('MOC-')) throw new AppError('Para añadir un MOC, importa su inventario HTML de Rebrickable.');
  const path = 'lego/sets/' + encodeURIComponent(number) + '/';
  const set = await rebrickable(path, key);
  const [parts, figures] = await Promise.all([
    allPages(path + 'parts/', key),
    allPages(path + 'minifigs/', key),
  ]);
  const entries = new Map();
  function add(item) {
    item.id = lineId(item);
    const existing = entries.get(item.id);
    if (existing) existing.needed += item.needed;
    else entries.set(item.id, item);
  }
  for (const row of parts) {
    add({
      part: String(row.part.part_num), name: row.part.name, element: String(row.element_id ?? ''),
      colorId: String(row.color.id), color: colorLabel(row.color.id, row.color.name),
      needed: row.quantity, spare: Boolean(row.is_spare), type: 'part',
      image: imageUrl(row.part_img_url || row.part.part_img_url || ''),
    });
  }
  for (const row of figures) {
    add({
      part: row.set_num, name: row.set_name, colorId: 'fig', color: 'Figura',
      needed: row.quantity, spare: false, type: 'minifig', element: '',
      image: imageUrl(row.set_img_url || ''),
    });
  }
  const items = [...entries.values()];
  if (!items.length) throw new AppError('El set existe, pero Rebrickable no devuelve piezas ni figuras.', 502);
  return rebrickableInventory({
    number, name: set.name, source: 'Rebrickable', image: imageUrl(set.set_img_url || ''), items,
  });
}

export function rebrickableInventory({ number, name, source, image = '', items }) {
  items.sort((a, b) => a.id.localeCompare(b.id));
  const fingerprint = JSON.stringify(items.map(({ id, needed }) => [id, needed]));
  const version = 'rb-' + createHash('sha256').update(fingerprint).digest('hex').slice(0, 10);
  return { id: number + '/' + version, number, name, version, source, image, partial: false, items };
}
