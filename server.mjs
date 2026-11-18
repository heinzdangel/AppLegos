import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AppError, importRebrickable, parseInventory, setCode, setNumber } from './catalog.mjs';
import { applyCommand } from './inventory.mjs';
import { parseRebrickableHtml } from './rebrickable-html.mjs';
import { addCatalog, addSet, consolidateSets, importSet } from './sets.mjs';
import { decodeSetPhotos, photoRequestLimit } from './set-photos.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const host = process.env.APP_HOST || '127.0.0.1';
const port = Number(process.env.APP_PORT || process.env.PORT || '4173');
const password = process.env.APP_PASSWORD;
const tls = process.env.APP_SECURE_COOKIE === '1';
const origin = process.env.APP_ORIGIN;
const pagesOrigin = process.env.APP_PAGES_ORIGIN;
const catalogKey = process.env.REBRICKABLE_API_KEY;
const setCreationRequestLimit = 18;
const htmlLimit = 2 * 1024 * 1024;
if ((password && password.length < 12) || (!['127.0.0.1', '::1', 'localhost'].includes(host) && !password)) {
  throw new Error('Para habilitar acceso por red, configura APP_PASSWORD con al menos 12 caracteres.');
}
if (pagesOrigin) {
  const address = new URL(pagesOrigin);
  if (address.protocol !== 'https:' || address.origin !== pagesOrigin || !password) {
    throw new Error('Configura APP_PAGES_ORIGIN como un origen HTTPS sin ruta y define APP_PASSWORD.');
  }
}

const directory = resolve(process.env.APP_DATA_DIR || join(root, 'datos'));
mkdirSync(directory, { recursive: true });
const db = new DatabaseSync(join(directory, 'inventario.sqlite'));
db.exec([
  'PRAGMA journal_mode = WAL;',
  'PRAGMA busy_timeout = 5000;',
  'CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, payload TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS completed_requests (id TEXT PRIMARY KEY, completed_at INTEGER NOT NULL);',
  'CREATE TABLE IF NOT EXISTS set_photos (id TEXT PRIMARY KEY, set_id TEXT NOT NULL, mime TEXT NOT NULL, content BLOB NOT NULL);',
  'CREATE INDEX IF NOT EXISTS set_photos_set_id ON set_photos(set_id);',
].join('\n'));
const samples = parseInventory(readFileSync(join(root, 'catalogo', 'Muestra-inventario.csv'), 'utf8'));
db.prepare('INSERT OR IGNORE INTO app_state VALUES (1, 0, ?)').run(
  JSON.stringify({ catalog: samples, copies: [], boxes: [] }),
);
const readState = db.prepare('SELECT version, payload FROM app_state WHERE id = 1');
const writeState = db.prepare('UPDATE app_state SET version = version + 1, payload = ? WHERE id = 1');
const readRequest = db.prepare('SELECT 1 FROM completed_requests WHERE id = ?');
const saveRequest = db.prepare('INSERT INTO completed_requests VALUES (?, ?)');
const purgeRequests = db.prepare('DELETE FROM completed_requests WHERE completed_at < ?');
const savePhoto = db.prepare('INSERT INTO set_photos VALUES (?, ?, ?, ?)');
const readPhoto = db.prepare('SELECT mime, content FROM set_photos WHERE id = ?');
const deleteSetPhotos = db.prepare('DELETE FROM set_photos WHERE set_id = ?');
const maxAge = 30 * 24 * 60 * 60;
const pagesAge = 12 * 60 * 60;
const secret = randomBytes(32);
const digest = value => createHash('sha256').update(value).digest();
const passwordDigest = password ? digest(password) : null;
const sign = value => createHmac('sha256', secret).update(value).digest('hex');
const attempts = new Map();

function fetchState() {
  const row = readState.get();
  return { ...JSON.parse(row.payload), version: row.version, liveCatalog: Boolean(catalogKey),
    protected: Boolean(passwordDigest), setPhotos: true, setCreationDetails: true };
}

function attachSetPhotos(set, photos) {
  set.photos ??= [];
  for (const { name, mime, bytes } of photos) {
    const id = randomUUID();
    savePhoto.run(id, set.id, mime, bytes);
    set.photos.push({ id, name });
  }
  set.coverPhotoId ??= set.photos[0].id;
}

function migrateSavedSets() {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = readState.get();
    const state = JSON.parse(row.payload);
    if (consolidateSets(state)) {
      db.exec('CREATE TABLE IF NOT EXISTS set_migration_backup (version INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
      db.prepare('INSERT OR IGNORE INTO set_migration_backup VALUES (?, ?)').run(row.version, row.payload);
      writeState.run(JSON.stringify(state));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

migrateSavedSets();

function commit(requestId, operation) {
  if (typeof requestId !== 'string' || !/^[\da-f-]{36}$/i.test(requestId)) {
    throw new AppError('La solicitud debe incluir un identificador.');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const state = fetchState();
    if (!readRequest.get(requestId)) {
      if (operation(state) !== false) {
        const { version, liveCatalog, protected: isProtected, setPhotos, setCreationDetails, ...payload } = state;
        writeState.run(JSON.stringify(payload));
        state.version = version + 1;
      }
      saveRequest.run(requestId, Date.now());
      purgeRequests.run(Date.now() - 7 * 86400000);
    }
    db.exec('COMMIT');
    return state;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function loggedIn(request, pagesRequest) {
  if (!passwordDigest) return true;
  const token = pagesRequest
    ? /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1]
    : /(?:^|;\s*)inventario=([^;]+)/.exec(request.headers.cookie ?? '')?.[1];
  const [expiration, nonce, signature, extra] = (token ?? '').split('.');
  return /^\d{10,13}$/.test(expiration || '') && Number(expiration) > Date.now() &&
    /^[a-f0-9]{32}$/.test(nonce || '') && /^[a-f0-9]{64}$/.test(signature || '') && extra === undefined &&
    timingSafeEqual(Buffer.from(signature, 'hex'),
      Buffer.from(sign((pagesRequest ? 'pages:' : '') + expiration + '.' + nonce), 'hex'));
}

function cookie(value, age) {
  return 'inventario=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + age +
    (tls ? '; Secure' : '');
}

async function readJson(request, limitMb = 4) {
  const chunks = [];
  let size = 0;
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new AppError('Se esperaba una solicitud JSON.', 415);
  }
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitMb * 1024 * 1024) throw new AppError('La solicitud supera el límite de ' + limitMb + ' MB.', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // A single message also covers malformed JSON.
  }
  throw new AppError('Contenido de solicitud no válido.');
}

const assets = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/config.js', ['public/config.js', 'text/javascript; charset=utf-8']],
  ['/pages-login', ['public/pages-login.html', 'text/html; charset=utf-8']],
  ['/pages-login.js', ['public/pages-login.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['public/icon.svg', 'image/svg+xml']],
  ['/part.svg', ['public/part.svg', 'image/svg+xml']],
  ['/manifest.webmanifest', ['public/manifest.webmanifest', 'application/manifest+json']],
  ['/muestra.csv', ['catalogo/Muestra-inventario.csv', 'text/csv; charset=utf-8']],
]);
const common = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' https:; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

function respond(response, status, value, extra = {}) {
  response.writeHead(status, { ...common, 'Content-Type': 'application/json; charset=utf-8', ...extra });
  response.end(JSON.stringify(value));
}

function checkOrigin(request) {
  const expected = origin || ((tls ? 'https://' : 'http://') + request.headers.host);
  if (request.headers.origin ? request.headers.origin !== expected :
      request.headers['sec-fetch-site'] === 'cross-site') {
    throw new AppError('Origen de la solicitud no permitido.', 403);
  }
}

export async function route(request, response) {
  const url = new URL(request.url, 'http://localhost');
  const apiPath = url.pathname.startsWith('/api/');
  const pagesRequest = Boolean(pagesOrigin && apiPath && request.headers.origin === pagesOrigin);
  if (pagesOrigin && apiPath) response.setHeader('Vary', 'Origin');
  if (pagesRequest) response.setHeader('Access-Control-Allow-Origin', pagesOrigin);
  if (!passwordDigest && !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(request.headers.host || '')) {
    throw new AppError('El servidor local solo acepta el nombre del equipo local.', 403);
  }
  const method = request.method;
  if (method === 'OPTIONS' && apiPath) {
    if (!pagesRequest) throw new AppError('Origen de la solicitud no permitido.', 403);
    response.writeHead(204, {
      ...common, 'Access-Control-Allow-Methods': 'GET, HEAD, POST',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600',
    });
    return response.end();
  }
  if (assets.has(url.pathname) && (method === 'GET' || method === 'HEAD')) {
    if (url.pathname.startsWith('/pages-login') && !pagesOrigin) throw new AppError('Página no encontrada.', 404);
    const [file, type] = assets.get(url.pathname);
    const body = method === 'HEAD' ? undefined : readFileSync(join(root, file));
    response.writeHead(200, { ...common, 'Content-Type': type });
    return response.end(body);
  }
  if (method === 'POST' && (!pagesRequest || ['/api/login', '/api/pages-session'].includes(url.pathname))) checkOrigin(request);
  if (method === 'POST' && url.pathname === '/api/login') {
    if (!passwordDigest) return respond(response, 200, { ok: true });
    const address = request.socket.remoteAddress;
    const input = await readJson(request);
    const now = Date.now();
    for (const [key, entry] of attempts) {
      if (entry.until < now) attempts.delete(key);
    }
    const attempt = attempts.get(address) || { failures: 0, until: now + 60000 };
    if (attempt.failures >= 8) throw new AppError('Demasiados intentos. Prueba dentro de un minuto.', 429);
    if (typeof input.password !== 'string' || !timingSafeEqual(digest(input.password), passwordDigest)) {
      attempt.failures++;
      attempts.set(address, attempt);
      throw new AppError('La contraseña no es correcta.', 401);
    }
    attempts.delete(address);
    const token = (Date.now() + maxAge * 1000) + '.' + randomBytes(16).toString('hex');
    return respond(response, 200, { ok: true }, { 'Set-Cookie': cookie(token + '.' + sign(token), maxAge) });
  }
  if (!apiPath) throw new AppError('Página no encontrada.', 404);
  if (!loggedIn(request, pagesRequest)) throw new AppError('Introduce la contraseña de la colección.', 401);
  if (method === 'POST' && url.pathname === '/api/pages-session' && pagesOrigin) {
    const token = (Date.now() + pagesAge * 1000) + '.' + randomBytes(16).toString('hex');
    return respond(response, 200, { origin: pagesOrigin, token: token + '.' + sign('pages:' + token) });
  }
  if (method === 'GET' && url.pathname === '/api/state') return respond(response, 200, fetchState());
  const photoId = url.pathname.match(/^\/api\/set-photos\/([\da-f-]{36})$/i)?.[1];
  if (photoId && (method === 'GET' || method === 'HEAD')) {
    const photo = readPhoto.get(photoId);
    if (!photo) throw new AppError('No se encontró la foto.', 404);
    response.writeHead(200, { ...common, 'Content-Type': photo.mime, 'Content-Length': photo.content.byteLength });
    return response.end(method === 'HEAD' ? undefined : photo.content);
  }
  if (method === 'POST' && url.pathname === '/api/logout') {
    if (pagesRequest) return respond(response, 200, { ok: true });
    return respond(response, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  }
  if (method === 'POST' && url.pathname === '/api/command') {
    const data = await readJson(request);
    return respond(response, 200, commit(data.requestId, current => {
      applyCommand(current, data);
      if (data.action === 'remove-copy') deleteSetPhotos.run(data.copyId);
    }));
  }
  if (method === 'POST' && url.pathname === '/api/sets') {
    const data = await readJson(request, setCreationRequestLimit);
    const photos = decodeSetPhotos([data.photo]);
    return respond(response, 200, commit(data.requestId, current => {
      const set = addSet(current, data.catalogId, data.name);
      attachSetPhotos(set, photos);
    }));
  }
  if (method === 'POST' && url.pathname === '/api/set-photos') {
    const data = await readJson(request, photoRequestLimit);
    const photos = decodeSetPhotos(data.photos);
    return respond(response, 200, commit(data.requestId, current => {
      const set = current.copies.find(entry => entry.id === data.copyId);
      if (!set) throw new AppError('El set ya no existe.', 404);
      attachSetPhotos(set, photos);
    }));
  }
  if (method === 'POST' && url.pathname === '/api/catalog/csv') {
    const data = await readJson(request);
    const inventories = parseInventory(String(data.csv ?? ''));
    return respond(response, 200, commit(data.requestId, current => addCatalog(current, inventories)));
  }
  if (method === 'POST' && url.pathname === '/api/catalog/html') {
    const data = await readJson(request, setCreationRequestLimit);
    if (typeof data.html !== 'string') throw new AppError('Selecciona un archivo HTML de Rebrickable.');
    if (Buffer.byteLength(data.html, 'utf8') > htmlLimit) throw new AppError('El HTML puede pesar hasta 2 MB.', 413);
    const code = setCode(data.code);
    const inventory = parseRebrickableHtml(data.html);
    const fileCode = setCode(inventory.number);
    if (code !== fileCode) {
      throw new AppError('El HTML corresponde al set ' + fileCode + ' y has indicado ' + code + '. Revisa el código o el archivo.');
    }
    const photos = data.photo === undefined ? [] : decodeSetPhotos([data.photo]);
    let outcome = 'unchanged';
    const state = commit(data.requestId, current => {
      const result = importSet(current, inventory, data.name);
      outcome = result.outcome;
      if (photos.length) {
        attachSetPhotos(result.set, photos);
        result.set.coverPhotoId = result.set.photos.at(-1).id;
        if (outcome === 'unchanged') outcome = 'updated';
      }
      return outcome !== 'unchanged';
    });
    const savedInventory = state.catalog.find(entry => setCode(entry.number) === code);
    const savedSet = state.copies.find(entry => entry.catalogId === savedInventory?.id);
    return respond(response, 200, { ...state, importedSet: { code, id: savedSet?.id, outcome } });
  }
  if (method === 'POST' && url.pathname === '/api/catalog/rebrickable') {
    const data = await readJson(request);
    const number = setNumber(data.number);
    const current = fetchState();
    if (current.catalog.some(entry => entry.number === number && entry.source === 'Rebrickable') && !data.refresh) {
      return respond(response, 200, current);
    }
    const inventory = await importRebrickable(number, catalogKey);
    return respond(response, 200, commit(data.requestId, current => addCatalog(current, [inventory])));
  }
  throw new AppError('Operación no encontrada.', 404);
}

export const server = createServer((request, response) => {
  route(request, response).catch(error => {
    if (!response.headersSent) {
      if (!(error instanceof AppError)) console.error(error);
      respond(response, error.status || 500, {
        error: error instanceof AppError ? error.message : 'No se pudo guardar. Inténtalo de nuevo.',
      });
    }
  });
});
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  server.listen(port, host, () => console.log('Inventario LEGO · ' + server.address().address + ':' + server.address().port));
  server.on('error', error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
