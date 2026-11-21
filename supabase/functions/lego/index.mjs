import { Buffer } from 'node:buffer';
import { AppError, htmlInventoryCode, importRebrickable, parseInventory, setCode, setNumber } from '../_shared/catalog.mjs';
import { applyCommand } from '../_shared/inventory.mjs';
import { parseRebrickableHtml } from '../_shared/rebrickable-html.mjs';
import { addCatalog, addSet, importSet } from '../_shared/sets.mjs';
import { decodeSetPhotos, photoRequestLimit } from '../_shared/set-photos.mjs';

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const mb = 1024 * 1024;

async function readBody(request, limit) {
  if (!request.headers.get('content-type')?.startsWith('application/json') || !request.body) {
    throw new AppError('Se esperaba una solicitud JSON.', 415);
  }
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit * mb) {
      await reader.cancel();
      throw new AppError(`La solicitud supera el límite de ${limit} MB.`, 413);
    }
    chunks.push(value);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    // Both invalid JSON and a non-object body produce the same response.
  }
  throw new AppError('Contenido de solicitud no válido.');
}

function stagePhotos(set, photos, staged, makeCover = false) {
  set.photos ??= [];
  for (const { name, mime, bytes } of photos) {
    const id = crypto.randomUUID();
    staged.push({ id, set_id: set.id, mime, data: bytes.toString('base64') });
    set.photos.push({ id, name });
  }
  if (makeCover) set.coverPhotoId = set.photos.at(-1).id;
  else set.coverPhotoId ??= set.photos[0].id;
}

export function createHandler({ url, publicKey, dataKey, origin, ownerId, catalogKey, send = fetch }) {
  async function database(path, body) {
    const headers = { apikey: dataKey };
    if (dataKey.startsWith('eyJ')) headers.Authorization = 'Bearer ' + dataKey;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await send(url + '/rest/v1/' + path, {
      method: body === undefined ? 'GET' : 'POST', headers, body: JSON.stringify(body),
    });
    if (!response.ok) throw new AppError('Supabase no pudo acceder al inventario.', 502);
    return response.json();
  }

  function snapshot(result) {
    return { ...result.payload, version: result.version, protected: true,
      liveCatalog: Boolean(catalogKey), setPhotos: true, setCreationDetails: true };
  }

  async function commit(requestId, apply) {
    let current = await database('rpc/lego_read', { p_request: requestId });
    if (!current?.payload) throw new AppError('Crea las tablas del inventario en Supabase.', 503);
    if (current.duplicate) return { state: snapshot(current), outcome: 'unchanged' };
    for (let attempt = 0; attempt < 4; attempt++) {
      const photos = [];
      const change = apply(current.payload, photos);
      const saved = await database('rpc/lego_commit', {
        p_expected: current.version, p_request: requestId, p_payload: current.payload,
        p_changed: change.outcome !== 'unchanged', p_photos: photos, p_delete_set: change.deleteSet ?? null,
      });
      if (saved.status !== 'conflict') {
        return { state: snapshot(saved), outcome: saved.status === 'duplicate' ? 'unchanged' : change.outcome };
      }
      current = saved;
    }
    throw new AppError('El inventario cambió en otro dispositivo. Vuelve a intentarlo.', 409);
  }

  return async request => {
    const cors = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
    const allowed = Boolean(origin && request.headers.get('origin') === origin);
    if (allowed) cors.set('Access-Control-Allow-Origin', origin);
    const response = (value, status = 200) => {
      const headers = new Headers(cors);
      headers.set('Content-Type', 'application/json; charset=utf-8');
      return new Response(JSON.stringify(value), { status, headers });
    };
    try {
      if (!url || !publicKey || !dataKey || !uuid.test(ownerId ?? '')) {
        throw new AppError('Completa la configuración del inventario en Supabase.', 503);
      }
      if (!allowed) throw new AppError('Origen de la solicitud no permitido.', 403);
      if (request.method === 'OPTIONS') {
        cors.set('Access-Control-Allow-Headers', 'apikey, authorization, content-type');
        cors.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        cors.set('Access-Control-Max-Age', '600');
        return new Response(null, { status: 204, headers: cors });
      }
      const auth = request.headers.get('authorization');
      if (!/^Bearer [\w.-]+$/.test(auth ?? '')) throw new AppError('Entra para consultar tu inventario.', 401);
      const account = await send(url + '/auth/v1/user', { headers: { apikey: publicKey, Authorization: auth } });
      if (account.status >= 500 || account.status === 429) throw new AppError('Supabase Auth no está disponible.', 503);
      if (!account.ok) throw new AppError('Vuelve a entrar en tu inventario.', 401);
      if ((await account.json()).id !== ownerId) throw new AppError('Esta cuenta no tiene acceso al inventario.', 403);

      const path = new URL(request.url).pathname.replace(/^\/(?:functions\/v1\/)?lego(?=\/|$)/, '');
      if (request.method === 'GET' && path === '/api/state') {
        const [current] = await database('lego_state?id=eq.1&select=version,payload');
        if (!current) throw new AppError('Crea las tablas del inventario en Supabase.', 503);
        return response(snapshot(current));
      }
      const photoId = path.match(/^\/api\/set-photos\/([^/]+)$/)?.[1];
      if (request.method === 'GET' && uuid.test(photoId ?? '')) {
        const [photo] = await database('lego_photos?id=eq.' + photoId + '&select=mime,content');
        if (!photo) throw new AppError('No se encontró la foto.', 404);
        cors.set('Content-Type', photo.mime);
        return new Response(Buffer.from(photo.content.slice(2), 'hex'), { headers: cors });
      }
      if (request.method !== 'POST') throw new AppError('Operación no encontrada.', 404);
      const limit = path === '/api/set-photos' ? photoRequestLimit
        : ['/api/sets', '/api/catalog/html'].includes(path) ? 18 : 4;
      const data = await readBody(request, limit);
      if (!uuid.test(data.requestId ?? '')) throw new AppError('La solicitud debe incluir un identificador.');
      let apply;
      let importedCode;
      switch (path) {
        case '/api/command':
          apply = state => {
            applyCommand(state, data);
            return { deleteSet: data.action === 'remove-copy' ? data.copyId : null };
          };
          break;
        case '/api/sets': {
          const photos = decodeSetPhotos([data.photo]);
          apply = (state, staged) => {
            stagePhotos(addSet(state, data.catalogId, data.name), photos, staged);
            return {};
          };
          break;
        }
        case '/api/set-photos': {
          const photos = decodeSetPhotos(data.photos);
          apply = (state, staged) => {
            const set = state.copies.find(entry => entry.id === data.copyId);
            if (!set) throw new AppError('El set ya no existe.', 404);
            stagePhotos(set, photos, staged);
            return {};
          };
          break;
        }
        case '/api/catalog/csv': {
          const inventories = parseInventory(String(data.csv ?? ''));
          apply = state => { addCatalog(state, inventories); return {}; };
          break;
        }
        case '/api/catalog/html': {
          if (typeof data.html !== 'string') throw new AppError('Selecciona un archivo HTML de Rebrickable.');
          if (Buffer.byteLength(data.html, 'utf8') > 2 * mb) throw new AppError('El HTML puede pesar hasta 2 MB.', 413);
          const inventory = parseRebrickableHtml(data.html);
          importedCode = htmlInventoryCode(data.code, inventory);
          const photos = data.photo === undefined ? [] : decodeSetPhotos([data.photo]);
          apply = (state, staged) => {
            const result = importSet(state, inventory, data.name);
            if (photos.length) stagePhotos(result.set, photos, staged, true);
            return { outcome: photos.length && result.outcome === 'unchanged' ? 'updated' : result.outcome };
          };
          break;
        }
        case '/api/catalog/rebrickable': {
          const inventory = await importRebrickable(setNumber(data.number), catalogKey);
          apply = state => { addCatalog(state, [inventory]); return {}; };
          break;
        }
        default:
          throw new AppError('Operación no encontrada.', 404);
      }
      const { state, outcome } = await commit(data.requestId, apply);
      if (importedCode) {
        const inventory = state.catalog.find(entry => setCode(entry.number) === importedCode);
        const set = state.copies.find(entry => entry.catalogId === inventory?.id);
        state.importedSet = { code: importedCode, id: set?.id, outcome };
      }
      return response(state);
    } catch (error) {
      if (!(error instanceof AppError)) console.error('Error al procesar la solicitud de Inventario LEGO:', error.name);
      return response({ error: error instanceof AppError ? error.message : 'No se pudo consultar o guardar el inventario.' },
        error instanceof AppError ? error.status : 500);
    }
  };
}

if (typeof Deno !== 'undefined') {
  const env = name => Deno.env.get(name);
  const key = (name, fallback) => {
    const keys = JSON.parse(env(name) || '{}');
    return keys.default || Object.values(keys)[0] || env(fallback);
  };
  Deno.serve(createHandler({
    url: env('SUPABASE_URL'),
    publicKey: key('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY'),
    dataKey: key('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'),
    origin: env('LEGO_ORIGIN'), ownerId: env('LEGO_OWNER_ID'), catalogKey: env('REBRICKABLE_API_KEY'),
  }));
}
