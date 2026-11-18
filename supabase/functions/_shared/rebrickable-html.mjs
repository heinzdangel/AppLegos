import colorNames from './catalogo/Colores-Rebrickable.json' with { type: 'json' };
import { AppError, colorLabel, lineId, rebrickableInventory, setNumber } from './catalog.mjs';

const aliases = new Map(Object.entries(colorNames).map(([id, name]) => [normalize(name), id]));
const entityNames = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', times: '×' };

function normalize(value) {
  return value.normalize('NFKC').toLowerCase().replace(/[\s‐‑–—_-]+/g, ' ').trim();
}

function decode(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (original, token) => {
    if (token[0] !== '#') return Object.hasOwn(entityNames, token) ? entityNames[token] : original;
    const point = token[1].toLowerCase() === 'x' ? Number.parseInt(token.slice(2), 16) : Number(token.slice(1));
    return point > 0 && point <= 0x10FFFF && !(point >= 0xD800 && point <= 0xDFFF) ? String.fromCodePoint(point) : original;
  });
}

function content(value) {
  return decode(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function extractRows(table) {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)];
}

function cells(row, tag) {
  const pattern = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '\\s*>', 'gi');
  return [...row.matchAll(pattern)].map(match => match[1]);
}

function attribute(markup, key) {
  const pattern = new RegExp('(?:^|\\s)' + key + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'<>+=]+))', 'i');
  const match = markup.match(pattern);
  return match ? decode(match[1] ?? match[2] ?? match[3]).trim() : '';
}

function remoteImage(markup) {
  const image = markup.match(/<img\b[^>]*>/i)?.[0] || '';
  for (const field of ['data-src', 'data-original', 'src']) {
    const value = attribute(image, field);
    if (!/^(?:https:\/\/|\/\/|\/media\/)/i.test(value)) continue;
    try {
      const url = new URL(value, 'https://cdn.rebrickable.com');
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
          ['rebrickable.com', 'cdn.rebrickable.com', 'www.rebrickable.com'].includes(url.hostname) &&
          url.pathname.startsWith('/media/')) return url.href;
    } catch {
      // A damaged or local image URL can be omitted independently of its row.
    }
  }
  return '';
}

const heading = {
  part: ['part num', 'part number', 'part', 'part id', 'numero de pieza', 'número de pieza'],
  quantity: ['quantity', 'qty', 'cantidad'],
  color: ['color', 'colour', 'color name', 'colour name'],
  name: ['description', 'part name', 'name', 'descripción', 'descripcion'],
  image: ['image', 'picture', 'imagen'],
  element: ['element id', 'element', 'lego element id'],
  colorId: ['color id', 'colour id', 'rebrickable color id'],
  spare: ['is spare', 'spare', 'extra', 'repuesto'],
};

function tableHeader(row) {
  const titles = cells(row, 'th').map(value => normalize(content(value)));
  const columns = Object.fromEntries(Object.entries(heading).map(([key, names]) =>
    [key, titles.findIndex(title => names.includes(title))]));
  if (['part', 'quantity', 'color', 'name'].every(key => columns[key] >= 0)) return columns;
}

function parseItem(values, columns, rowNumber) {
  const read = key => content(values[columns[key]] || '');
  const part = read('part');
  const name = read('name');
  const quantity = read('quantity');
  const color = read('color');
  const needed = Number(quantity);
  const type = /^fig-\d+$/i.test(part) ? 'minifig' : 'part';
  const spare = normalize(read('spare'));
  if (!/^[\w.-]{1,64}$/.test(part) || !name || name.length > 200 ||
      !/^\d{1,6}$/.test(quantity) || needed === 0 ||
      (type === 'part' && !color) || color.length > 100 ||
      !['', '0', '1', 'no', 'yes', 'false', 'true', 'sí', 'si', '✓', 'x'].includes(spare)) {
    throw new AppError('Fila ' + rowNumber + ' de la tabla HTML. Revisa la referencia, la cantidad, el color o el repuesto.');
  }
  const image = remoteImage(values[columns.image] || '');
  const explicitColor = read('colorId');
  const nameKey = normalize(color);
  const knownId = aliases.get(nameKey);
  const colorId = type === 'minifig' ? 'fig' : /^-?\d{1,7}$/.test(explicitColor) ? explicitColor :
    knownId || 'rb-name:' + nameKey;
  const explicitElement = read('element');
  const imageElement = image.match(/\/elements\/(\d{4,14})\.(?:png|jpe?g|webp)(?:[/?#]|$)/i)?.[1];
  const element = /^\d{4,14}$/.test(explicitElement) ? explicitElement : imageElement || '';
  const item = {
    part, name, needed, colorId, color: type === 'minifig' ? 'Figura' : colorLabel(colorId, color),
    image, element, spare: ['1', 'yes', 'true', 'sí', 'si', '✓', 'x'].includes(spare), type,
  };
  item.id = lineId(item);
  return item;
}

export function parseRebrickableHtml(input) {
  const document = input.replace(/<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const title = content(document.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '');
  const set = title.match(/^(?:Parts\s*[-–—:]\s*)?(\d{3,12}(?:-\d{1,4})?)\s*[-–—:]\s*(.{1,180})$/i);
  if (!set) {
    throw new AppError('El título del HTML no identifica un set. Descarga «HTML Table» desde el inventario de un set en Rebrickable.');
  }
  const number = setNumber(set[1]);
  for (const match of document.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)) {
    const rows = extractRows(match[1]);
    const headers = rows.map(row => tableHeader(row[1]));
    const headerIndex = headers.findIndex(Boolean);
    if (headerIndex === -1) continue;
    const columns = headers[headerIndex];
    const entries = new Map();
    for (let index = headerIndex + 1; index < rows.length; index++) {
      const values = cells(rows[index][1], 'td');
      if (!values.length || values.every(value => !content(value) && !value.includes('<img'))) continue;
      if (values.length === 1 && /<td\b[^>]*\bcolspan\s*=/i.test(rows[index][1])) continue;
      const item = parseItem(values, columns, index + 1);
      const previous = entries.get(item.id);
      if (previous) {
        previous.needed += item.needed;
        previous.image ||= item.image;
        previous.element ||= item.element;
        if (previous.needed > 999999) throw new AppError('La cantidad de una referencia supera el máximo admitido.');
      } else entries.set(item.id, item);
    }
    if (entries.size) {
      return rebrickableInventory({ number, name: set[2].trim(), source: 'Rebrickable HTML', items: [...entries.values()] });
    }
  }
  throw new AppError('El archivo no contiene una tabla de piezas válida. En «Export Parts» elige «HTML Table».');
}
