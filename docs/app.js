const $ = selector => document.querySelector(selector);
const page = $('#page');
const shell = $('#shell');
const access = $('#access');
const notice = $('#notice');
const dialog = $('#dialog');
const dialogContent = $('#dialog-content');
const iconFallback = './part.svg';
const pagesMode = Boolean(window.inventarioPages);
const supabase = pagesMode && window.inventarioSupabase;
let serverOrigin = '';
const configuredOrigin = supabase ? supabase.url : window.inventarioApi;
if (pagesMode && configuredOrigin) {
  try {
    const apiUrl = new URL(configuredOrigin);
    const validProject = !supabase || (/^[a-z0-9-]+\.supabase\.co$/.test(apiUrl.hostname) && /^sb_publishable_/.test(supabase.key));
    if (apiUrl.protocol === 'https:' && apiUrl.origin === configuredOrigin && validProject) serverOrigin = apiUrl.origin;
  } catch {
    // The access screen explains how to complete the configuration.
  }
}
let pagesToken = '';
let pagesLoginWindow;
let otpEmail = '';
let refreshToken = '';
let sessionExpires = 0;
let refreshingToken;
const photoLoads = new WeakMap();
const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
const compare = collator.compare;
let data;
let refreshId;
let notification;
let pending = false;
let countQueue = Promise.resolve();
let dialogRestore;
const ui = {
  page: 'sets', copy: '', box: '', item: '', focusPiece: '', query: '',
  color: '', status: 'all', setStatus: 'all', group: 'color', closedUsage: true,
};

const setStates = {
  complete: { label: 'Completo', plural: 'Completos', tone: 'good' },
  unreviewed: { label: 'Por revisar', plural: 'Por revisar', tone: '' },
  reviewing: { label: 'En revisión', plural: 'En revisión', tone: 'working' },
  incomplete: { label: 'Incompleto', plural: 'Incompletos', tone: 'need' },
};

function html(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function textKey(value) {
  return String(value).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

const pieceId = item => JSON.stringify([item.type, item.part, item.colorId]);
const catalogOf = copy => data.catalog.find(entry => entry.id === copy.catalogId);
const activeCopy = () => data.copies.find(copy => copy.id === ui.copy);
const activeBox = () => data.boxes.find(box => box.id === ui.box);
const format = new Intl.NumberFormat('es').format;
const quantityText = value => format(value) + (value === 1 ? ' unidad' : ' unidades');

function progress(copy, item) {
  const line = copy.lines[item.id];
  const direct = line?.direct ?? 0;
  const assigned = Object.values(line?.allocations ?? {}).reduce((sum, number) => sum + number, 0);
  const total = direct + assigned;
  const missing = Math.max(0, item.needed - total);
  return { direct, assigned, total, missing, reviewed: !missing || Boolean(line?.reviewed) };
}

function setSummary(copy) {
  const inventory = catalogOf(copy);
  let references = 0;
  let reviewed = 0;
  let required = 0;
  let recorded = 0;
  let missing = 0;

  for (const item of inventory.items) {
    if (item.spare) continue;
    const line = progress(copy, item);
    references++;
    required += item.needed;
    recorded += item.needed - line.missing;
    if (line.reviewed) {
      reviewed++;
      missing += line.missing;
    }
  }

  let state = 'unreviewed';
  if (references && !inventory.partial && reviewed === references) {
    state = missing ? 'incomplete' : 'complete';
  } else if (reviewed || recorded) {
    state = 'reviewing';
  }
  return { copy, inventory, references, reviewed, required, recorded, missing, state };
}

function allPieces() {
  const entries = new Map();
  const inventories = [...data.catalog].sort((a, b) => Number(a.partial) - Number(b.partial));
  for (const inventory of inventories) {
    for (const item of inventory.items) {
      const key = pieceId(item);
      const existing = entries.get(key);
      if (!existing) entries.set(key, item);
      else if (!existing.image && item.image) entries.set(key, { ...existing, image: item.image });
    }
  }
  for (const item of data.loosePieces ?? []) {
    const key = pieceId(item);
    const existing = entries.get(key);
    if (!existing) entries.set(key, item);
    else if (!existing.image && item.image) entries.set(key, { ...existing, image: item.image });
  }
  return [...entries].map(([key, item]) => ({ ...item, key }));
}

function matchingCopies(key) {
  return data.copies.flatMap(copy => catalogOf(copy).items
    .filter(item => !item.spare && pieceId(item) === key).map(item => ({ copy, item, ...progress(copy, item) })));
}

function missingEntries() {
  const entries = new Map();
  for (const copy of data.copies) {
    for (const item of catalogOf(copy).items) {
      if (item.spare) continue;
      const status = progress(copy, item);
      if (!status.reviewed || !status.missing) continue;
      const key = pieceId(item);
      if (!entries.has(key)) entries.set(key, { ...item, key, sum: 0, copies: [] });
      const found = entries.get(key);
      found.sum += status.missing;
      found.copies.push({ copy, item, ...status });
    }
  }
  return [...entries.values()];
}

function photo(item, extra = '') {
  const caption = item.image ? 'Ver imagen de ' + item.name : 'Imagen no disponible';
  return `<button class="photo ${extra}" type="button" data-action="photo" data-value="${html(pieceId(item))}" aria-label="${html(caption)}">
    <img src="${html(item.image || iconFallback)}" alt="${html(item.image ? item.name + ', ' + item.color : '')}" loading="lazy">
    ${item.image ? '' : '<small>Sin imagen</small>'}
  </button>`;
}

const colors = {
  negro: 'black', azul: 'blue', verde: 'green', rojo: 'red', blanco: 'white',
  amarillo: 'yellow', naranja: 'orange', gris: 'grey', marron: 'brown', beige: 'beige', rosa: 'pink',
};

function colorLabel(item) {
  const color = colors[textKey(item.color).split(' ')[0]] || 'neutral';
  return `<span class="color-label"><i class="swatch ${color}"></i>${html(item.color)}</span>`;
}

function colorOptions(items) {
  return [...new Map(items.map(item => [item.colorId, item.color])).entries()]
    .sort((a, b) => compare(a[1], b[1])).map(([id, name]) =>
      `<option value="${html(id)}"${id === ui.color ? ' selected' : ''}>${html(name)}</option>`).join('');
}

function searchMatches(item) {
  return (!ui.color || item.colorId === ui.color) &&
    textKey([item.name, item.part, item.color, item.element].join(' ')).includes(textKey(ui.query.trim()));
}

function searchBar(items, extra = '') {
  return `<div class="filters">
    <label class="search"><span aria-hidden="true">⌕</span><input type="search" id="search" data-filter="query" value="${html(ui.query)}" placeholder="Buscar pieza o código" aria-label="Buscar pieza o código"></label>
    <label class="select-label"><span>Color</span><select aria-label="Color" data-filter="color"><option value="">Todos</option>${colorOptions(items)}</select></label>${extra}
  </div>`;
}

const partTypes = [
  ['Technic', /^(technic|tecnic[ao])\b/],
  ['Ladrillos', /^(brick|ladrillo)\b/],
  ['Placas', /^(plate|placa|wedge plate)\b/],
  ['Baldosas', /^(tile|baldosa|loseta)\b/],
  ['Pendientes y cuñas', /^(slope|wedge|curved|pendiente|cuña)\b/],
  ['Soportes y bisagras', /^(bracket|support|hinge|clip|soporte|bisagra)\b/],
  ['Barras y ejes', /^(bar|axle|shaft|barra|eje)\b/],
  ['Ruedas y neumáticos', /^(wheel|tyre|tire|rueda|neumatico)\b/],
  ['Piezas de animales', /^(animal|garra|cuerno|diente)\b/],
  ['Piezas de minifiguras', /^(minifig|minifigure|minifigura)\b/],
];

function partType(item) {
  if (item.type === 'minifig') return 'Minifiguras';
  const name = textKey(item.name);
  return partTypes.find(([, pattern]) => pattern.test(name))?.[0] || 'Otras piezas';
}

function setListControls(items) {
  const types = [...new Set(items.map(partType))].sort(compare);
  return `<label class="select-label"><span>Tipo</span><select aria-label="Tipo de pieza" data-filter="partType">
    <option value="">Todos</option>${types.map(type =>
      `<option value="${html(type)}"${type === ui.partType ? ' selected' : ''}>${html(type)}</option>`).join('')}</select></label>
    <label class="select-label"><span>Ordenar por</span><select aria-label="Ordenar por" data-filter="partSort">
    ${[['color', 'Color'], ['name', 'Nombre'], ['type', 'Tipo']].map(([value, title]) =>
      `<option value="${value}"${value === ui.partSort ? ' selected' : ''}>${title}</option>`).join('')}</select></label>`;
}

function compareSetParts(a, b) {
  const name = compare(a.name, b.name);
  const color = compare(a.color, b.color);
  if (ui.partSort === 'type') return compare(partType(a), partType(b)) || name || color || compare(a.part, b.part);
  if (ui.partSort === 'name') return name || color || compare(a.part, b.part);
  return color || compare(a.colorId, b.colorId) || name || compare(a.part, b.part);
}

function showNotice(message, error = false) {
  if (error && dialog.open) {
    const local = dialogContent.querySelector('[data-dialog-error]');
    local.textContent = message;
    local.hidden = false;
    return;
  }
  clearTimeout(notification);
  notice.textContent = message;
  notice.classList.toggle('error', error);
  notice.hidden = false;
  notification = setTimeout(() => { notice.hidden = true; }, error ? 7500 : 3200);
}

function connection(offline) {
  const indicator = $('#connection');
  indicator.classList.toggle('offline', offline);
  indicator.innerHTML = '<i></i>' + (offline ? 'Sin conexión' : 'Guardado en servidor');
}

async function supabaseAuth(path, body) {
  const response = await fetch(serverOrigin + '/auth/v1/' + path, {
    method: 'POST', credentials: 'omit', redirect: 'error',
    headers: { apikey: supabase.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.msg || result.error_description || 'No se pudo completar el acceso.');
    error.status = response.status;
    throw error;
  }
  return result;
}

function useSupabaseSession(session) {
  pagesToken = session.access_token;
  refreshToken = session.refresh_token;
  sessionExpires = Date.now() + session.expires_in * 1000;
}

async function apiFetch(path, options = {}) {
  if (!pagesMode) return fetch(path, options);
  const headers = { ...options.headers };
  if (supabase && refreshToken && Date.now() + 60000 >= sessionExpires) {
    if (!refreshingToken) {
      const previous = refreshToken;
      refreshingToken = supabaseAuth('token?grant_type=refresh_token', { refresh_token: previous })
        .then(session => { if (refreshToken === previous) useSupabaseSession(session); }).catch(error => {
          if (error.status === 400 || error.status === 403) error.status = 401;
          throw error;
        }).finally(() => { refreshingToken = undefined; });
    }
    await refreshingToken;
  }
  if (pagesToken) headers.Authorization = 'Bearer ' + pagesToken;
  if (supabase) headers.apikey = supabase.key;
  const base = supabase ? serverOrigin + '/functions/v1/lego' : serverOrigin;
  return fetch(base + path, { ...options, headers, credentials: 'omit', redirect: 'error' });
}

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  };
  const response = await apiFetch(path, options);
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || 'Error al guardar.');
    error.status = response.status;
    throw error;
  }
  return result;
}

async function refresh(force = false) {
  if (pending && !force) return;
  if (pagesMode && (!serverOrigin || !pagesToken)) {
    if (!serverOrigin || !access.querySelector('form, [data-action="pages-login"]')) renderAccess(Boolean(serverOrigin));
    return;
  }
  try {
    const fresh = await api('/api/state');
    connection(false);
    if (force || !data || fresh.setPhotos !== data.setPhotos || fresh.setCreationDetails !== data.setCreationDetails ||
        (fresh.version !== data.version && !page.contains(document.activeElement?.closest('input, select')))) {
      if (data && fresh.version < data.version && !force) return;
      data = fresh;
      access.hidden = true;
      shell.hidden = false;
      render();
    }
  } catch (error) {
    if (error.status === 401) renderAccess(true);
    else if (supabase && error.status === 403) {
      renderAccess(true);
      showNotice(error.message, true);
    }
    else if (!data) renderAccess(false);
    else connection(true);
  }
}

function requestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

async function retryApi(path, body) {
  try {
    return await api(path, body);
  } catch (error) {
    if (error.status) throw error;
    return api(path, body);
  }
}

async function saveCountNone(path, body) {
  try {
    return await retryApi(path, body);
  } catch (error) {
    if (error.status !== 400 || error.message !== 'Acción no reconocida.') throw error;
  }

  // The previous server can still be running after its browser files have been updated.
  const { copyId, itemId, expected, expectedAllocated } = body;
  const conflict = Object.assign(new Error('El recuento cambió en otro dispositivo. Revisa la fila y vuelve a intentarlo.'), { status: 409 });
  const send = (action, fields) => retryApi(path, { action, copyId, itemId, ...fields, requestId: requestId() });
  let fresh = await api('/api/state');
  function readLine() {
    const copy = fresh.copies.find(entry => entry.id === copyId);
    const inventory = copy && fresh.catalog.find(entry => entry.id === copy.catalogId);
    const item = inventory?.items.find(entry => entry.id === itemId);
    if (!item) throw conflict;
    return { status: progress(copy, item), allocations: copy.lines[itemId]?.allocations ?? {} };
  }

  const { status, allocations } = readLine();
  if (status.total === 0 && status.reviewed) return fresh;
  if (status.direct !== expected || status.assigned !== expectedAllocated) throw conflict;
  for (const [boxId, count] of Object.entries(allocations)) {
    if (readLine().allocations[boxId] !== count) throw conflict;
    fresh = await send('allocate', { boxId, count, return: true });
  }
  if (readLine().status.direct !== expected) throw conflict;
  if (expected > 0) fresh = await send('count', { expected, count: 0 });
  if (readLine().status.total !== 0) throw conflict;
  fresh = await send('review', { expected: 0, reviewed: true });
  if (readLine().status.total !== 0) throw conflict;
  return fresh;
}

async function mutate(action, payload = {}, settings = {}) {
  if (pending) return;
  pending = true;
  const id = requestId();
  const body = { ...payload, action, requestId: id };
  const endpoint = settings.path || '/api/command';
  const dialogError = dialog.open && dialogContent.querySelector('[data-dialog-error]');
  if (dialogError) dialogError.hidden = true;
  try {
    const fresh = await (action === 'count-none' ? saveCountNone(endpoint, body) : retryApi(endpoint, body));
    data = fresh;
    takeAfterAction(action, settings);
    connection(false);
    if (settings.close) dialog.close();
    render();
    const message = typeof settings.message === 'function' ? settings.message(fresh) : settings.message;
    if (message) showNotice(message);
  } catch (error) {
    if (error.status === 401) renderAccess(true);
    else {
      showNotice(error.status ? error.message : 'No se pudo confirmar el guardado. Comprueba la conexión.', true);
      if (error.status === 409) await refresh(true);
      if (!error.status) connection(true);
    }
  } finally {
    pending = false;
  }
}

function takeAfterAction(action, settings) {
  if (action === 'add-copy') selectPage('sets', { copy: data.copies.at(-1).id });
  if (action === 'add-box') selectPage('boxes', { box: data.boxes.at(-1).id });
  if (action === 'remove-copy') selectPage('sets');
  if (settings.after) settings.after(data);
}

function htmlImportResult(fresh, code) {
  if (fresh.importedSet?.id) {
    const { id, outcome } = fresh.importedSet;
    if (outcome === 'created') return { id, message: `Set ${code} añadido a Mis sets.` };
    if (outcome === 'updated') return { id, message: `Set ${code} actualizado.` };
    return { id, message: `El set ${code} ya coincide con el HTML.` };
  }
  // Older servers import into the catalog without creating or updating the set.
  const inventory = fresh.catalog.find(entry => entry.id === fresh.importedCatalogId);
  if (inventory?.number.split('-')[0] === code) {
    const copy = fresh.copies.find(entry => entry.catalogId === inventory.id);
    if (copy) return { id: copy.id, message: `El set ${code} ya coincide con el HTML.` };
    return { message: `El inventario de ${code} está en el catálogo. Reinicia el servidor y vuelve a importar el HTML para aplicarlo en «Mis sets».` };
  }
  return { message: `El servidor no confirmó el set ${code}. Reinicia Inventario LEGO y vuelve a importar el HTML.` };
}

function renderAccess(login) {
  if (dialog.open) dialog.close();
  if (pagesMode && login) {
    pagesToken = '';
    refreshToken = '';
    data = undefined;
    photoLoads.get(page)?.abort();
    page.innerHTML = '';
  }
  shell.hidden = true;
  access.hidden = false;
  access.innerHTML = `<section class="access-card"><img src="./icon.svg" alt="" width="60" height="60">
    <h1>Inventario LEGO</h1>${login && supabase ? (otpEmail ?
    `<form data-form="supabase-otp"><p>Introduce el código enviado a ${html(otpEmail)}.</p>
      <label>Código de acceso<input name="token" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" required></label>
      <button class="primary">Entrar</button><button type="button" data-action="supabase-change-email">Volver</button></form>` :
    `<form data-form="supabase-email"><label>Correo de acceso<input type="email" name="email" autocomplete="email" required></label>
      <button class="primary">Enviar código</button></form>`) : login && pagesMode ?
    '<button class="primary" type="button" data-action="pages-login">Entrar a mi inventario</button>' : login ?
    `<form data-form="login"><label>Contraseña de la colección<input type="password" name="password" autocomplete="current-password" required></label><button class="primary">Entrar</button></form>` : pagesMode && !serverOrigin ?
    '<p>Completa la configuración de acceso en docs/config.js.</p>' :
    `<p>No se pudo conectar con el servidor del inventario.</p><button class="primary" type="button" data-action="retry">Reintentar</button>`}
  </section>`;
  if (login) access.querySelector(pagesMode && !supabase ? 'button' : 'input')?.focus();
}

function selectPage(name, detail = {}) {
  ui.page = name;
  Object.assign(ui, {
    copy: '', box: '', item: '', focusPiece: '', query: '', color: '',
    status: 'all', closedUsage: true, catalogPage: 0, partType: '', partSort: 'color',
    setDetailHidden: false, relationsOpen: {},
  }, detail);
}

function header(title, actions, context = '') {
  return `<header class="page-header">
    <div>${context}<h1>${html(title)}</h1></div>
    <div class="header-actions">${actions}</div>
  </header>`;
}

function blank(title, detail = '', actions = '') {
  return `<div class="empty"><strong>${html(title)}</strong>${detail ? `<p>${html(detail)}</p>` : ''}${actions}</div>`;
}

const setPhotoUrl = id => '/api/set-photos/' + encodeURIComponent(id);

function setPhotoSource(id) {
  return pagesMode ? `src="./icon.svg" data-set-photo="${html(id)}"` : `src="${setPhotoUrl(id)}"`;
}

function loadSetPhotoImages(container) {
  if (!pagesMode) return;
  photoLoads.get(container)?.abort();
  const images = container.querySelectorAll('img[data-set-photo]');
  if (!images.length) return;
  const controller = new AbortController();
  photoLoads.set(container, controller);
  const { signal } = controller;
  images.forEach(async image => {
    try {
      const response = await apiFetch(setPhotoUrl(image.dataset.setPhoto), { signal });
      if (!response.ok) return;
      const blob = await response.blob();
      if (signal.aborted) return;
      const source = URL.createObjectURL(blob);
      signal.addEventListener('abort', () => URL.revokeObjectURL(source), { once: true });
      image.src = source;
    } catch {
      // The placeholder stays visible when a photo cannot be loaded.
    }
  });
}

function setOverview() {
  const actions = '<button type="button" data-action="import-html">Importar HTML</button><button type="button" data-action="import">Importar CSV</button><button type="button" class="primary" data-action="open-add">Añadir set</button>';
  const title = header('Mis sets', actions);
  if (!data.copies.length) {
    return title + blank('Todavía no tienes sets en tu colección',
      'Añade un set nuevo desde el catálogo o importa su inventario de Rebrickable.');
  }

  const summaries = data.copies.map(setSummary);
  const filtered = summaries.filter(set => ui.setStatus === 'all' || set.state === ui.setStatus);
  const options = [['all', 'Todos'], ...Object.entries(setStates).map(([id, state]) => [id, state.plural])];
  const filters = `<div class="filters"><label class="select-label">Estado del set
    <select data-filter="setStatus">${options.map(([id, label]) =>
      `<option value="${id}"${id === ui.setStatus ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
    <span class="subheading set-results" role="status">${format(filtered.length)} de ${format(summaries.length)} sets</span></div>`;
  const cards = filtered.map(({ copy, inventory, references, reviewed, missing, state }) => {
    const cover = copy.coverPhotoId ? setPhotoSource(copy.coverPhotoId) :
      inventory.image ? `src="${html(inventory.image)}"` : '';
    const lead = cover ? `<img ${cover} alt="" loading="lazy">` :
      `<span class="set-mark" aria-hidden="true">${html(inventory.number.split('-')[0])}</span>`;
    return `<button type="button" class="set-card" data-action="copy" data-value="${html(copy.id)}">
      <span class="set-visual">${lead}</span>
      <span class="set-body"><span class="set-meta"><span>${html(inventory.number)}</span>${setStatePill(state)}</span>
      <strong>${html(copy.name)}</strong>${inventory.partial ? '<span>Inventario parcial</span>' : ''}
      <span>${format(reviewed)} de ${format(references)} referencias revisadas</span>
      <progress value="${reviewed}" max="${references || 1}" aria-label="Referencias revisadas"></progress>
      ${missing ? `<span class="negative">${quantityText(missing)} por reponer</span>` : ''}
      </span></button>`;
  }).join('');
  return title + filters + (cards ? `<div class="card-grid">${cards}</div>` :
    blank('No hay sets con este estado', 'Selecciona otro estado para ver más sets.'));
}

function setStatePill(state) {
  const { label, tone } = setStates[state];
  return `<span class="pill ${tone}">${label}</span>`;
}

function statisticsView() {
  const sets = data.copies.map(setSummary);
  const counts = { complete: 0, unreviewed: 0, reviewing: 0, incomplete: 0 };
  const totals = { references: 0, reviewed: 0, required: 0, recorded: 0, missing: 0, withMissing: 0 };
  for (const set of sets) {
    counts[set.state]++;
    totals.references += set.references;
    totals.reviewed += set.reviewed;
    totals.required += set.required;
    totals.recorded += set.recorded;
    totals.missing += set.missing;
    if (set.missing) totals.withMissing++;
  }

  const metric = (label, value) => `<span>${label}</span><strong>${format(value)}</strong>`;
  const statusMetric = (id, label, count) => `<button type="button" class="stats-card" data-action="show-set-status" data-value="${id}">${metric(label, count)}</button>`;
  const closest = sets.filter(set => set.state === 'incomplete').sort((a, b) =>
    a.missing - b.missing || compare(a.copy.name, b.copy.name)).slice(0, 5);
  const reviewPercent = totals.references ? Math.floor(totals.reviewed / totals.references * 100) : 0;
  return header('Estadísticas', '') + `
    <section class="stats-section" aria-labelledby="stats-sets"><h2 id="stats-sets">Mis sets</h2>
      <div class="stats-grid">${statusMetric('all', 'Total de sets', sets.length)}
      ${Object.entries(setStates).map(([id, state]) => statusMetric(id, state.plural, counts[id])).join('')}
      <div class="stats-card">${metric('Sets con faltantes confirmados', totals.withMissing)}</div></div>
    </section>
    <section class="stats-section" aria-labelledby="stats-pieces"><h2 id="stats-pieces">Piezas y revisión</h2>
      <div class="stats-grid">
        <div class="stats-card">${metric('Piezas necesarias', totals.required)}</div>
        <div class="stats-card">${metric('Piezas registradas', totals.recorded)}</div>
        <button type="button" class="stats-card" data-action="page" data-value="missing">${metric('Faltantes confirmados', totals.missing)}</button>
        <div class="stats-card">${metric('Referencias por revisar', totals.references - totals.reviewed)}</div>
      </div>
      <div class="panel stats-progress"><div><h3>Avance de revisión</h3><strong>${format(reviewPercent)} %</strong></div>
        <progress value="${totals.reviewed}" max="${totals.references || 1}" aria-label="Avance de revisión"></progress>
        <p class="subheading">${format(totals.reviewed)} de ${format(totals.references)} referencias revisadas</p>
        ${sets.some(set => set.inventory.partial) ? '<p class="subheading">Los inventarios parciales aportan solo las referencias cargadas.</p>' : ''}
      </div>
    </section>
    ${closest.length ? `<section class="stats-section" aria-labelledby="stats-closest"><h2 id="stats-closest">Sets más cerca de completar</h2>
      <div class="panel stats-list">${closest.map(({ copy, inventory, missing }) =>
        `<button type="button" data-action="copy" data-value="${html(copy.id)}"><span><strong>${html(copy.name)}</strong>
        <small>${html(inventory.number)}</small></span><span class="pill need">${missing === 1 ? 'Falta 1' : `Faltan ${format(missing)}`}</span></button>`).join('')}</div>
    </section>` : ''}`;
}

function linePill(status) {
  if (!status.missing) return '<span class="pill good">Completa</span>';
  if (!status.reviewed) return '<span class="pill">Por revisar</span>';
  return `<span class="pill need">Faltan ${format(status.missing)}</span>`;
}

function rowCountControls(item, status) {
  const key = html(item.id);
  const label = html(`${item.name}, ${item.color}`);
  return `<div class="row-counter" role="group" aria-label="Recuento de ${label}">
    <button type="button" aria-label="Restar una unidad de ${label}" data-action="count-step" data-item="${key}" data-value="-1"${status.direct ? '' : ' disabled'}>−</button>
    <button type="button" aria-label="Sumar una unidad de ${label}" data-action="count-step" data-item="${key}" data-value="1"${status.missing ? '' : ' disabled'}>+</button>
    <button type="button" aria-label="Marcar todas las unidades de ${label}" data-action="count-all" data-item="${key}"${status.missing ? '' : ' disabled'}>Todas</button>
    <button type="button" aria-label="Ninguna unidad de ${label}" data-action="count-none" data-item="${key}" title="${status.assigned ? 'Ninguna. Las unidades asignadas volverán a su caja' : 'Ninguna'}"${status.total || !status.reviewed ? '' : ' disabled'}>X</button>
  </div>`;
}

function setDetail(copy) {
  const inventory = catalogOf(copy);
  const regular = inventory.items.filter(item => !item.spare && item.type === 'part');
  const figures = inventory.items.filter(item => item.type === 'minifig' && !item.spare);
  const spares = inventory.items.filter(item => item.spare);
  const pool = ui.status === 'figures' ? figures : ui.status === 'spares' ? spares : regular;
  const rows = pool.filter(item => {
    const status = progress(copy, item);
    return searchMatches(item) && (!ui.partType || partType(item) === ui.partType) && (ui.status === 'review' ? !status.reviewed :
      ui.status === 'confirmed' ? status.reviewed && status.missing : true);
  }).sort(compareSetParts);
  const item = rows.find(entry => entry.id === ui.item) || rows[0];
  const tabs = [['all', 'Piezas'], ['review', 'Por revisar'], ['confirmed', 'Con faltantes']];
  if (figures.length) tabs.push(['figures', 'Minifiguras']);
  if (spares.length) tabs.push(['spares', 'Repuestos']);
  const back = '<button type="button" class="text-button" data-action="page" data-value="sets">← Mis sets</button>';
  const label = `<div class="set-meta"><p class="subheading">${html(inventory.number)} · ${html(inventory.source)} · ${html(inventory.version)}</p>${setStatePill(setSummary(copy).state)}</div>`;
  const showDetail = !ui.setDetailHidden;
  const side = showDetail ? (item ? setItemDetail(copy, item) : blank('Selecciona una pieza')) : '';
  const detailToggle = `<button type="button" data-action="toggle-set-detail" aria-controls="set-piece-detail" aria-expanded="${showDetail}">${showDetail ? 'Ocultar detalle' : 'Mostrar detalle'}</button>`;
  const photos = `<button type="button" data-action="set-photos" data-value="${html(copy.id)}">Fotos del set${copy.photos?.length ? ` (${copy.photos.length})` : ''}</button>`;
  return header(copy.name, photos + detailToggle + '<button type="button" data-action="remove-copy">Eliminar set</button>', back) + label +
    (inventory.partial ? '<p class="banner">Inventario de muestra · Solo incluye una selección de referencias.</p>' : '') +
    searchBar(pool, setListControls(pool)) +
    `<div class="tabs" aria-label="Vista del inventario">${tabs.map(([value, title]) =>
      `<button type="button" data-action="status" data-value="${value}" aria-pressed="${value === ui.status}">${title}</button>`).join('')}</div>` +
    `<div class="split${showDetail ? '' : ' single'}"><div class="panel list-panel set-list">${rows.length ? rows.map((entry, index) => {
      const status = progress(copy, entry);
      const startsColor = ui.partSort === 'color' && rows[index - 1]?.colorId !== entry.colorId;
      const heading = startsColor ? `<h2 class="group-title">${colorLabel(entry)}</h2>` : '';
      return `${heading}<div class="piece-row set-piece-row${entry.id === item.id ? ' selected' : ''}">
        ${photo(entry)}<button type="button" class="piece-name" data-action="item" data-value="${html(entry.id)}">
        <strong>${html(entry.name)}</strong><small>${html(entry.part)} · ${colorLabel(entry)} · ${html(partType(entry))}</small></button>
        ${rowCountControls(entry, status)}<div class="set-row-status"><span class="ratio" aria-label="${status.total} de ${entry.needed} unidades">${format(status.total)} / ${format(entry.needed)}</span>${linePill(status)}</div></div>`;
    }).join('') : blank('No hay piezas en esta vista', 'Prueba otro filtro o cambia el estado.')}</div>
    <aside id="set-piece-detail" class="panel detail-panel" aria-label="Detalle de pieza"${showDetail ? '' : ' hidden'}>${side}</aside></div>`;
}

function setItemDetail(copy, item) {
  const status = progress(copy, item);
  return `<div class="detail-inner">${photo(item, 'large')}
    <div><h2>${html(item.name)}</h2><p class="subheading">${html(item.part)} · ${colorLabel(item)}${item.element ? ` · LEGO ${html(item.element)}` : ''}</p></div>
    <div class="numbers">
      <div><small>Necesitas</small><strong>${format(item.needed)}</strong></div>
      <div><small>Tienes</small><strong>${format(status.total)}</strong></div>
      <div><small>${status.reviewed ? 'Faltan' : 'Por localizar'}</small><strong class="${status.missing ? 'negative' : ''}">${format(status.missing)}</strong></div>
    </div>
    <form data-form="count" data-item="${html(item.id)}" data-expected="${status.direct}" class="count-form">
      <label for="direct-count">Cantidad contada en el set</label>
      <div class="counter">
        <input id="direct-count" name="count" type="number" min="0" max="${item.needed - status.assigned}" required inputmode="numeric" value="${status.direct}">
        <button type="submit">Guardar</button>
      </div>
    </form>
    ${status.assigned ? `<p class="subheading">${quantityText(status.assigned)} asignadas desde cajas.</p>` : ''}
    <div class="detail-actions">
    ${status.missing ? `<button type="button" data-action="review" data-value="${!status.reviewed}">${status.reviewed ? 'Volver a revisar' : 'Confirmar faltantes'}</button>` : '<span class="pill good">Cantidad completa</span>'}
    </div>${setPieceRelations(item)}</div>`;
}

function setPieceRelations(item) {
  const matches = matchingCopies(pieceId(item));
  const missing = matches.filter(entry => entry.reviewed && entry.missing > 0);
  const uses = matches.filter(entry => entry.total > 0);
  const sections = [
    ['missing', 'En qué sets falta', missing, 'No hay faltantes confirmados para esta pieza.',
      entry => `Faltan ${quantityText(entry.missing)}`],
    ['usage', 'Dónde la estoy utilizando', uses, 'No hay unidades registradas para esta pieza.',
      entry => quantityText(entry.total)],
  ];
  return sections.map(([key, title, entries, empty, quantity]) => `<details data-set-relation="${key}"${ui.relationsOpen?.[key] ? ' open' : ''}>
    <summary>${title}</summary>
    ${entries.map(entry => `<div class="detail-line">
      <button type="button" class="text-button" data-action="copy" data-value="${entry.copy.id}" data-item="${html(entry.item.id)}">${html(entry.copy.name)}<small>${html(catalogOf(entry.copy).number)}</small></button>
      <strong>${quantity(entry)}</strong></div>`).join('') || `<p class="subheading">${empty}</p>`}
    </details>`).join('');
}

function boxesOverview() {
  return header('Cajas', '<button type="button" class="primary" data-action="add-box">Nueva caja</button>') +
    (data.boxes.length ? `<div class="card-grid">${data.boxes.map(box =>
      `<button type="button" class="box-card" data-action="box" data-value="${box.id}">
      <span aria-hidden="true" class="box-mark">▤</span><strong>${html(box.name)}</strong>
      <span>${Object.keys(box.pieces).length} referencias · ${quantityText(Object.values(box.pieces).reduce((a, b) => a + b, 0))}</span>
      </button>`).join('')}</div>` : blank('Aún no hay cajas', 'Crea una caja para registrar piezas mezcladas y repartirlas entre tus sets.'));
}

function boxStatus(box, item) {
  const uses = matchingCopies(pieceId(item));
  const used = uses.reduce((sum, entry) => sum + (entry.copy.lines[entry.item.id]?.allocations?.[box.id] ?? 0), 0);
  const total = box.pieces[pieceId(item)] ?? 0;
  return { uses, used, total, available: total - used };
}

function boxDetail(box) {
  const items = allPieces().filter(item => item.type === 'part' &&
    (Object.hasOwn(box.pieces, item.key) || ui.query.trim() || ui.color || ui.focusPiece === item.key));
  const rows = items.filter(searchMatches).sort((a, b) => compare(a.color, b.color) || compare(a.part, b.part));
  const chosen = rows.find(item => item.key === ui.focusPiece) || rows[0];
  const back = '<button type="button" class="text-button" data-action="page" data-value="boxes">← Cajas</button>';
  return header(box.name, '', back) + searchBar(allPieces().filter(item => item.type === 'part')) +
    `<div class="split"><div class="panel list-panel">${rows.length ? rows.map(item => {
      const status = boxStatus(box, item);
      return `<div class="piece-row${chosen?.key === item.key ? ' selected' : ''}">${photo(item)}
        <button type="button" class="piece-name" data-action="box-piece" data-value="${html(item.key)}"><strong>${html(item.name)}</strong><small>${html(item.part)} · ${colorLabel(item)}</small></button>
        <span class="pill">${format(status.available)} libres</span></div>`;
    }).join('') : blank('La caja está vacía o no coincide con la búsqueda', 'Busca por código, nombre o color para registrar una pieza del catálogo.')}</div>
    <aside class="panel detail-panel" aria-label="Detalle de caja">${chosen ? boxItemDetail(box, chosen) : blank('Selecciona una pieza')}</aside></div>`;
}

function boxItemDetail(box, item) {
  const status = boxStatus(box, item);
  return `<div class="detail-inner">${photo(item, 'large')}<div><h2>${html(item.name)}</h2>
    <p class="subheading">${html(item.part)} · ${colorLabel(item)}</p></div>
    <div class="numbers">
      <div><small>Total</small><strong>${format(status.total)}</strong></div>
      <div><small>Asignadas</small><strong>${format(status.used)}</strong></div>
      <div><small>Disponibles</small><strong>${format(status.available)}</strong></div>
    </div>
    <form data-form="box-count" class="count-form" data-piece="${html(item.key)}" data-expected="${status.total}">
      <label for="box-count">Unidades contadas en esta caja</label><div class="counter">
      <input id="box-count" name="count" type="number" min="${status.used}" max="999999" required inputmode="numeric" value="${status.total}">
      <button type="submit" class="primary">Guardar</button></div>
    </form>
    <h3>Asignar a un set</h3>
    ${status.uses.length ? status.uses.map(entry => {
      const assigned = entry.copy.lines[entry.item.id]?.allocations?.[box.id] ?? 0;
      const limit = Math.min(status.available, entry.missing);
      return `<div class="allocation"><div><strong>${html(entry.copy.name)}</strong><small>${html(catalogOf(entry.copy).number)} · ${entry.missing} por cubrir${assigned ? ` · ${assigned} de esta caja` : ''}</small></div>
        ${limit || assigned ? `<form data-form="allocate" data-copy="${entry.copy.id}" data-item="${html(entry.item.id)}" class="counter">
          <input name="count" aria-label="Unidades para ${html(entry.copy.name)}" type="number" value="1" min="1" max="${Math.max(limit, assigned)}" required inputmode="numeric">
          ${limit ? '<button type="submit" name="mode" value="assign">Asignar</button>' : ''}
          ${assigned ? '<button type="submit" name="mode" value="return">Devolver</button>' : ''}
        </form>` : ''}</div>`;
    }).join('') : '<p class="subheading">Ningún set de tu colección tiene esta referencia y color.</p>'}</div>`;
}

function missingView(all) {
  const items = all.filter(searchMatches).sort((a, b) => ui.group === 'piece' ?
    compare(a.part, b.part) || compare(a.color, b.color) :
    compare(a.color, b.color) || compare(a.part, b.part));
  const grouping = `<label class="select-label"><span>Ver por</span>
    <select aria-label="Ver faltantes por" data-filter="group">
      ${[['color', 'Color'], ['piece', 'Pieza'], ['set', 'Set']].map(([id, title]) =>
        `<option value="${id}"${ui.group === id ? ' selected' : ''}>${title}</option>`).join('')}
    </select></label>`;
  const entry = items.find(item => item.key === ui.focusPiece);
  const exportButton = items.length ? '<button type="button" data-action="export">Exportar CSV</button>' : '';
  return header('Faltantes', exportButton) +
    `<p class="subheading">${items.length ? items.length + ' referencias · ' + quantityText(items.reduce((sum, item) => sum + item.sum, 0)) : 'Faltantes confirmados de tu colección'}</p>` +
    searchBar(all, grouping) + `<div class="split${entry ? '' : ' single'}">
      <div class="panel list-panel">${items.length ? missingRows(items) :
    blank('No hay faltantes en esta vista', all.length ? 'Prueba con otro filtro.' : 'Aquí aparecerán las unidades que falten al guardar el recuento de una pieza.')}</div>
      ${entry ? `<aside class="panel detail-panel" aria-label="Detalle de faltantes">${missingDetail(entry)}</aside>` : ''}
    </div>`;
}

function missingRows(items) {
  const groups = new Map();
  function add(key, name, item, count) {
    if (!groups.has(key)) groups.set(key, { name, rows: [] });
    groups.get(key).rows.push({ item, count });
  }
  for (const item of items) {
    if (ui.group === 'set') {
      for (const { copy, missing } of item.copies) add(copy.id, copy.name + ' · ' + catalogOf(copy).number, item, missing);
    } else if (ui.group === 'color') add(item.colorId, item.color, item, item.sum);
    else add('', '', item, item.sum);
  }
  return [...groups.values()].sort((a, b) => compare(a.name, b.name)).map(({ name: group, rows }) =>
    `${group ? `<h2 class="group-title">${html(group)}</h2>` : ''}
    ${rows.map(({ item, count }) => `<div class="piece-row${item.key === ui.focusPiece ? ' selected' : ''}">
    ${photo(item)}<button class="piece-name" type="button" data-action="missing-piece" data-value="${html(item.key)}"><strong>${html(item.name)}</strong>
    <small>${html(item.part)} · ${colorLabel(item)}</small></button><span class="pill need">Faltan ${format(count)}</span></div>`).join('')}`).join('');
}

function missingDetail(item) {
  const uses = ui.closedUsage ? [] : matchingCopies(item.key).filter(entry => entry.total > 0);
  return `<div class="detail-inner">
    <button class="text-button" type="button" data-action="close-detail">Cerrar detalle ×</button>
    ${photo(item, 'large')}<div><h2>${html(item.name)}</h2>
    <p class="subheading">${html(item.part)} · ${colorLabel(item)}${item.element ? ` · LEGO ${html(item.element)}` : ''}</p></div>
    <div class="total-missing"><strong>${format(item.sum)}</strong> faltan en total</div>
    <h3>En qué sets falta</h3>${item.copies.map(entry =>
      `<div class="detail-line"><button type="button" class="text-button" data-action="copy" data-value="${entry.copy.id}" data-item="${html(entry.item.id)}">${html(entry.copy.name)}<small>${html(catalogOf(entry.copy).number)}</small></button>
      <span>Faltan <strong>${format(entry.missing)}</strong> de ${format(entry.item.needed)}</span></div>`).join('')}
    <details id="usage-panel"${ui.closedUsage ? '' : ' open'}><summary>Dónde la estoy usando</summary>
    ${uses.map(entry => `<div class="detail-line"><span>${html(entry.copy.name)} <small>${html(catalogOf(entry.copy).number)}</small></span><strong>${quantityText(entry.total)}</strong></div>`).join('') ||
      (ui.closedUsage ? '' : '<p class="subheading">No hay unidades registradas en tus sets.</p>')}</details>
  </div>`;
}

function piecesView() {
  const all = allPieces().filter(item => item.type === 'part');
  const matches = all.filter(searchMatches).sort((a, b) => compare(a.color, b.color) || compare(a.part, b.part));
  const pageSize = 60;
  const lastPage = Math.max(0, Math.ceil(matches.length / pageSize) - 1);
  const current = Math.min(ui.catalogPage, lastPage);
  const first = current * pageSize;
  const results = matches.slice(first, first + pageSize);
  const selected = matches.find(item => item.key === ui.focusPiece);
  const rows = results.map(item => `<div class="piece-row${selected?.key === item.key ? ' selected' : ''}">
    ${photo(item)}<button class="piece-name" type="button" data-action="catalog-piece" data-value="${html(item.key)}">
    <strong>${html(item.name)}</strong><small>${html(item.part)} · ${colorLabel(item)}</small></button></div>`).join('');
  const pagination = lastPage ? `<div class="catalog-pagination">
    <button type="button" data-action="catalog-page" data-value="${current - 1}"${current === 0 ? ' disabled' : ''}>Anterior</button>
    <span>${format(first + 1)}–${format(first + results.length)} de ${format(matches.length)}</span>
    <button type="button" data-action="catalog-page" data-value="${current + 1}"${current === lastPage ? ' disabled' : ''}>Siguiente</button>
  </div>` : '';
  return header('Piezas', '<button type="button" data-action="import-html">Importar HTML</button>') +
    `<p class="subheading">${format(all.length)} referencias por código y color</p>` +
    searchBar(all) + `<div class="split${selected ? '' : ' single'}"><div class="panel list-panel">
    ${rows || blank('No hay piezas en esta vista', 'Prueba otro filtro o importa un inventario.')}${pagination}</div>
    ${selected ? `<aside class="panel detail-panel" aria-label="Detalle de catálogo">${catalogPieceDetail(selected)}</aside>` : ''}
    </div>`;
}

function catalogPieceDetail(item) {
  const models = new Map();
  for (const inventory of data.catalog) {
    const part = inventory.items.find(entry => pieceId(entry) === item.key);
    if (!part) continue;
    const exists = models.get(inventory.number);
    if (!exists || (exists.partial && !inventory.partial)) models.set(inventory.number, inventory);
  }
  const copies = matchingCopies(item.key);
  return `<div class="detail-inner">
    <button class="text-button" type="button" data-action="close-detail">Cerrar detalle ×</button>
    ${photo(item, 'large')}<div><h2>${html(item.name)}</h2>
    <p class="subheading">${html(item.part)} · ${colorLabel(item)}${item.element ? ` · LEGO ${html(item.element)}` : ''}</p></div>
    ${models.size ? `<h3>Sets del catálogo que llevan esta pieza</h3>
    ${[...models.values()].sort((a, b) => compare(a.number, b.number)).map(inventory =>
      `<div class="detail-line"><span>${html(inventory.name)} <small>${html(inventory.number)}${inventory.partial ? ' · Muestra' : ''}</small></span></div>`).join('')}` : ''}
    ${copies.length ? `<h3>En Mis sets</h3>${copies.map(({ copy, item: line, total }) =>
      `<div class="detail-line"><button type="button" class="text-button" data-action="copy" data-value="${copy.id}" data-item="${html(line.id)}">${html(copy.name)}</button>
      <span>${format(total)} de ${format(line.needed)} registradas</span></div>`).join('')}` : ''}
  </div>`;
}

function render() {
  if (!data) return;
  const allMissing = missingEntries();
  const badge = $('#missing-badge');
  badge.hidden = !allMissing.length;
  badge.textContent = allMissing.length;
  $('#logout').hidden = !data.protected;
  document.querySelectorAll('nav [data-action="page"]').forEach(button => {
    if (ui.page === button.dataset.value) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const current = activeCopy();
  const box = activeBox();
  if (ui.page === 'sets') page.innerHTML = current ? setDetail(current) : setOverview();
  if (ui.page === 'boxes') page.innerHTML = box ? boxDetail(box) : boxesOverview();
  if (ui.page === 'missing') page.innerHTML = missingView(allMissing);
  if (ui.page === 'pieces') page.innerHTML = piecesView();
  if (ui.page === 'stats') page.innerHTML = statisticsView();
  loadSetPhotoImages(page);
  page.querySelectorAll('[data-set-relation]').forEach(section => {
    section.addEventListener('toggle', () => {
      if (section.isConnected) ui.relationsOpen[section.dataset.setRelation] = section.open;
    });
  });
  $('#usage-panel')?.addEventListener('toggle', event => {
    const open = event.target.open;
    if (ui.closedUsage === open) {
      ui.closedUsage = !open;
      render();
      $('#usage-panel summary')?.focus();
    }
  });
}

function renderDialog(title, body) {
  if (!dialog.open) dialogRestore = document.activeElement;
  dialogContent.innerHTML = `<div class="dialog-top"><h2 id="dialog-title">${html(title)}</h2>
    <button type="button" data-action="close-dialog" aria-label="Cerrar diálogo">×</button></div>
    <p class="dialog-error" data-dialog-error role="alert" hidden></p>${body}`;
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  if (!dialog.open) dialog.showModal();
  loadSetPhotoImages(dialogContent);
}

function confirmSetRemoval(set, final = false) {
  if (!set) return dialog.close();
  const name = html(set.name);
  const cancel = '<button type="button" data-action="close-dialog" data-remove-cancel>Cancelar</button>';
  renderDialog(final ? 'Última confirmación' : 'Eliminar set', final ?
    `<p>¿Confirmas que quieres borrar <strong>${name}</strong> definitivamente? Se eliminarán su listado, recuento y fotos. Las referencias seguirán en «Piezas» y las unidades asignadas volverán a estar disponibles en sus cajas.</p>
    <form data-form="remove-copy-confirmed" data-copy="${html(set.id)}"><div class="detail-actions">
      ${cancel}<button type="submit" class="danger">Sí, eliminar definitivamente</button></div></form>` :
    `<p>¿Quieres eliminar <strong>${name}</strong> de Mis sets?</p><div class="detail-actions">
      ${cancel}<button type="button" class="danger" data-action="confirm-set-removal" data-value="${html(set.id)}">Sí, continuar</button></div>`);
  dialogContent.querySelector('[data-remove-cancel]')?.focus();
}

function showSetPhotos(copyId, photoId) {
  const set = data.copies.find(copy => copy.id === copyId);
  if (!set) return;
  const photos = set.photos ?? [];
  const selected = photos.find(photo => photo.id === (photoId || set.coverPhotoId)) ?? photos[0];
  const title = 'Fotos de ' + set.name;
  if (!data.setPhotos) {
    renderDialog(title, '<p>Reinicia la aplicación para activar las fotos de los sets.</p>');
    return;
  }

  const setId = html(set.id);
  const photoPanel = selected ? `<figure class="zoom set-photo-large">
    <img ${setPhotoSource(selected.id)} alt="${html(selected.name)}">
    <figcaption>${html(selected.name)}${selected.id === set.coverPhotoId ? ' · Foto principal' : ''}</figcaption>
  </figure>${selected.id === set.coverPhotoId ? '' : `<button type="button" class="set-photo-cover" data-action="set-photo-cover"
    data-copy="${setId}" data-value="${html(selected.id)}">Marcar como principal</button>`}` :
    '<p class="subheading">La primera foto que añadas aparecerá en Mis sets.</p>';
  const thumbnails = photos.length > 1 ? `<div class="set-photo-gallery" role="group" aria-label="Galería">
    ${photos.map((photo, index) => `<button type="button" data-action="set-photos" data-value="${setId}" data-photo="${html(photo.id)}"
      aria-pressed="${photo.id === selected.id}" aria-label="${html(`Ver foto ${index + 1}: ${photo.name}`)}">
      <img ${setPhotoSource(photo.id)} alt="" loading="lazy">${photo.id === set.coverPhotoId ? '<small>Principal</small>' : ''}
    </button>`).join('')}</div>` : '';
  renderDialog(title, `<section class="set-photo-content" data-photo-set="${setId}">${photoPanel}${thumbnails}
    <form data-form="set-photos-upload" data-copy="${setId}">
      <label>Añadir fotos<input type="file" name="photos" accept="image/jpeg,image/png,image/webp,image/gif" multiple required></label>
      <p class="subheading">JPG, PNG, WebP o GIF. Hasta 10 MB por foto.</p>
      <button type="submit" class="primary">Subir fotos</button>
    </form></section>`);
}

function refreshSetPhotosDialog(copyId, photoId) {
  if (dialog.open && dialogContent.querySelector('[data-photo-set]')?.dataset.photoSet === copyId) {
    showSetPhotos(copyId, photoId);
  }
}

function readSetPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, data: reader.result.split(',', 2)[1] });
    reader.onerror = () => reject(new Error('No se pudo leer la foto ' + file.name + '.'));
    reader.readAsDataURL(file);
  });
}

async function uploadSetPhotos(form, files) {
  const mb = 1024 * 1024;
  const copyId = form.dataset.copy;
  if (files.length > 30 || files.reduce((total, file) => total + file.size, 0) > 24 * mb) {
    return showNotice('Selecciona hasta 30 fotos y 24 MB por carga.', true);
  }
  if (files.some(file => file.size > 10 * mb)) return showNotice('Cada foto puede pesar hasta 10 MB.', true);
  const submit = form.querySelector('button[type="submit"]');
  if (submit.disabled || pending) return;
  submit.disabled = true;
  try {
    const photos = await Promise.all(files.map(readSetPhoto));
    await mutate('upload-set-photos', { copyId, photos }, {
      path: '/api/set-photos',
      after: fresh => refreshSetPhotosDialog(copyId, fresh.copies.find(copy => copy.id === copyId)?.photos?.at(-1)?.id),
    });
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    if (submit.isConnected) submit.disabled = false;
  }
}

function setDetailsFields() {
  return `<label>Nombre del set (opcional)<input name="name" maxlength="90" placeholder="Ej. Grandes dinosaurios"></label>
    <label>Foto principal del set (opcional)<input type="file" name="photo" accept="image/jpeg,image/png,image/webp,image/gif"></label>
    <p class="subheading">JPG, PNG, WebP o GIF de hasta 10 MB.</p>`;
}

async function submitSet(form, input) {
  const submit = form.querySelector('button[type="submit"]');
  if (submit.disabled || pending) return;
  const htmlImport = form.dataset.form === 'import-html';
  const name = input.get('name').trim();
  const photo = input.get('photo');
  const hasPhoto = Boolean(photo?.name);
  if ((hasPhoto || (htmlImport && name)) && !data.setCreationDetails) {
    return showNotice('Reinicia el servidor de Inventario LEGO para guardar el nombre y la foto desde este formulario.', true);
  }
  const mb = 1024 * 1024;
  if (hasPhoto && photo.size > 10 * mb) return showNotice('La foto puede pesar hasta 10 MB.', true);
  const inventory = input.get('inventory');
  if (htmlImport) {
    if (!/\.html?$/i.test(inventory.name)) return showNotice('Selecciona un archivo .html o .htm.', true);
    if (inventory.size > 2 * mb) return showNotice('El HTML puede pesar hasta 2 MB.', true);
  }
  submit.disabled = true;
  try {
    const details = { name };
    if (hasPhoto) details.photo = await readSetPhoto(photo);
    if (!htmlImport) {
      await mutate('add-copy', { catalogId: input.get('catalogId'), ...details }, {
        path: hasPhoto ? '/api/sets' : undefined, close: true,
      });
      return;
    }
    const code = input.get('code').trim();
    let result;
    await mutate('html', { code, html: await inventory.text(), ...details }, {
      path: '/api/catalog/html', close: true,
      after: fresh => {
        result = htmlImportResult(fresh, code);
        selectPage('sets', { copy: result.id || '' });
      },
      message: () => result.message,
    });
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    if (submit.isConnected) submit.disabled = false;
  }
}

function addDialog() {
  const codeOf = entry => entry.number.split('-')[0];
  const taken = new Set(data.copies.map(set => codeOf(catalogOf(set))));
  const available = new Map();
  for (const entry of data.catalog) {
    const code = codeOf(entry);
    if (taken.has(code)) continue;
    const previous = available.get(code);
    if (!previous || previous.partial || !entry.partial) available.set(code, entry);
  }
  const catalog = [...available.values()].sort((a, b) => compare(a.number, b.number));
  const choices = catalog.length ? `<form data-form="add-copy">
    <label>Código del set<select name="catalogId" required>${catalog.map(entry =>
      `<option value="${html(entry.id)}">${html(entry.number)} · ${html(entry.name)} · ${html(entry.source)} · ${html(entry.version)}${entry.partial ? ' (parcial)' : ''}</option>`).join('')}</select></label>
    ${setDetailsFields()}
    <button type="submit" class="primary">Añadir a Mis sets</button></form>` :
    '<p class="subheading">Importa el inventario del set que quieres añadir.</p>';
  renderDialog('Añadir set', `${choices}<hr><form data-form="rebrickable">
    <label>Número de set en Rebrickable<input name="number" required placeholder="Ej. 60411"${data.liveCatalog ? '' : ' disabled'}></label>
    <button${data.liveCatalog ? '' : ' disabled'}>Cargar del catálogo</button>
    ${data.liveCatalog ? '' : '<p class="subheading">API pendiente de configuración. También puedes cargar un archivo de inventario.</p>'}
    </form><button type="button" data-action="import-html">Importar HTML de un set</button>`);
}

function csvCell(value) {
  const safe = String(value);
  return '"' + (/^\s*[=+@\-]/.test(safe) ? "'" : '') + safe.replaceAll('"', '""') + '"';
}

function exportMissing() {
  const entries = missingEntries().filter(searchMatches).sort((a, b) =>
    ui.group === 'piece' ? compare(a.part, b.part) || compare(a.color, b.color) :
      compare(a.color, b.color) || compare(a.part, b.part));
  const rows = entries.flatMap(item => item.copies.map(entry => [
    item.part, item.name, item.colorId, item.color, item.element, item.sum,
    catalogOf(entry.copy).number, entry.copy.name, entry.missing,
  ]));
  if (ui.group === 'set') rows.sort((a, b) => compare(a[7], b[7]) || compare(a[3], b[3]) || compare(a[0], b[0]));
  rows.unshift(['Código', 'Pieza', 'ID color', 'Color', 'ID elemento', 'Total faltante', 'Set', 'Nombre del set', 'Faltan en set']);
  const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(csvCell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'Faltantes_LEGO.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function selectedItem() {
  if (!activeCopy()) return null;
  const id = page.querySelector('[data-form="count"]')?.dataset.item;
  return catalogOf(activeCopy()).items.find(item => item.id === id);
}

function countFromRow(copyId, itemId, action, value) {
  countQueue = countQueue.then(async () => {
    const copy = data?.copies.find(entry => entry.id === copyId);
    const item = copy && catalogOf(copy).items.find(entry => entry.id === itemId);
    if (!item) return;
    const status = progress(copy, item);
    if (action === 'count-none') {
      if (status.total === 0 && status.reviewed) return;
      if (ui.copy === copy.id) ui.item = item.id;
      await mutate('count-none', { copyId, itemId, expected: status.direct, expectedAllocated: status.assigned },
        { message: `Faltante confirmado: ${quantityText(item.needed)}.` });
      return;
    }
    const all = action === 'count-all';
    const count = all ? undefined : status.direct + Number(value);
    if (all ? !status.missing : count < 0 || count > item.needed - status.assigned) return;
    if (ui.copy === copy.id) ui.item = item.id;
    await mutate('count', { copyId, itemId, expected: status.direct, count, all });
  });
  return countQueue;
}

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const { action, value, item: itemId } = target.dataset;
  if (action === 'retry') return refresh(true);
  if (action === 'close-dialog') return dialog.close();
  if (!data) return;
  switch (action) {
    case 'page': selectPage(value); render(); break;
    case 'show-set-status':
      selectPage('sets', { setStatus: value });
      render();
      page.querySelector('[data-filter="setStatus"]')?.focus();
      break;
    case 'copy': {
      const copy = data.copies.find(entry => entry.id === value);
      const item = catalogOf(copy).items.find(entry => entry.id === itemId);
      selectPage('sets', { copy: value, item: itemId || '', status: item?.type === 'minifig' ? 'figures' : 'all' });
      render();
      break;
    }
    case 'box': selectPage('boxes', { box: value }); render(); break;
    case 'set-photos': showSetPhotos(value, target.dataset.photo); break;
    case 'set-photo-cover': {
      const copyId = target.dataset.copy;
      await mutate('set-photo-cover', { copyId, photoId: value }, {
        after: () => refreshSetPhotosDialog(copyId, value),
      });
      break;
    }
    case 'item': ui.item = value; ui.setDetailHidden = false; render(); break;
    case 'toggle-set-detail':
      ui.setDetailHidden = !ui.setDetailHidden;
      render();
      page.querySelector('[data-action="toggle-set-detail"]')?.focus();
      break;
    case 'status': ui.status = value; ui.color = ''; ui.partType = ''; render(); break;
    case 'box-piece': ui.focusPiece = value; render(); break;
    case 'missing-piece': ui.focusPiece = value; ui.closedUsage = true; render(); break;
    case 'catalog-piece': ui.focusPiece = value; render(); break;
    case 'catalog-page': ui.catalogPage = Number(value); ui.focusPiece = ''; render(); break;
    case 'close-detail': ui.focusPiece = ''; render(); break;
    case 'open-add': addDialog(); break;
    case 'import-html': renderDialog('Importar HTML de Rebrickable', `<form data-form="import-html">
      <label>Código del set<input name="code" inputmode="numeric" pattern="[0-9]{3,12}" required placeholder="Ej. 31058" autofocus></label>
      <label>Archivo de inventario<input name="inventory" type="file" accept=".html,.htm,text/html" required></label>
      <p class="subheading">Usa el archivo de «Export Parts» → «HTML Table». El código indicado debe coincidir con el set del archivo.</p>
      ${setDetailsFields()}
      <button type="submit" class="primary">Importar HTML</button></form>`); break;
    case 'import': renderDialog('Importar inventario CSV', `<form data-form="import">
      <label>Archivo CSV separado por comas<input name="inventory" type="file" accept=".csv,text/csv" required></label>
      <p class="subheading">Clona la estructura de la muestra. Usa una versión distinta para un inventario revisado o completo.</p>
      <a href="./muestra.csv" download="Muestra-inventario.csv">Descargar CSV de muestra</a>
      <button class="primary">Importar catálogo</button></form>`); break;
    case 'add-box': renderDialog('Nueva caja', `<form data-form="add-box"><label>Nombre<input name="name" maxlength="90" required placeholder="Ej. Caja azul"></label><button class="primary">Crear caja</button></form>`); break;
    case 'remove-copy': confirmSetRemoval(activeCopy()); break;
    case 'confirm-set-removal': confirmSetRemoval(data.copies.find(set => set.id === value), true); break;
    case 'export': exportMissing(); break;
    case 'photo': {
      const item = allPieces().find(entry => entry.key === value);
      if (item) renderDialog(item.name, `<figure class="zoom"><img src="${html(item.image || iconFallback)}"
        alt="${html(item.image ? item.name + ', ' + item.color : 'Imagen no disponible')}"><figcaption>${html(item.part)} · ${html(item.color)}${item.image ? '' : ' · Imagen no disponible'}</figcaption></figure>`);
      break;
    }
    case 'count-step':
    case 'count-none':
    case 'count-all': await countFromRow(activeCopy()?.id, itemId, action, value); break;
    case 'review': {
      const copy = activeCopy();
      const item = selectedItem();
      const status = progress(copy, item);
      await mutate('review', { copyId: copy.id, itemId: item.id, expected: status.direct, reviewed: value === 'true' });
      break;
    }
    case 'pages-login':
      pagesLoginWindow = window.open(serverOrigin + '/pages-login', 'inventario-lego-acceso', 'popup,width=470,height=430');
      if (!pagesLoginWindow) showNotice('Permite la ventana de acceso para entrar al inventario.', true);
      break;
    case 'supabase-change-email':
      otpEmail = '';
      renderAccess(true);
      break;
    case 'logout':
      try {
        if (!pagesMode) await api('/api/logout', {});
        data = undefined;
        selectPage('sets');
        renderAccess(true);
      } catch {
        showNotice('No se pudo cerrar la sesión.', true);
      }
      break;
  }
});

document.addEventListener('submit', async event => {
  const form = event.target;
  if (!form.dataset.form) return;
  event.preventDefault();
  const input = new FormData(form);
  const mode = form.dataset.form;
  if (mode === 'supabase-email' || mode === 'supabase-otp') {
    const submit = form.querySelector('button');
    submit.disabled = true;
    try {
      if (mode === 'supabase-email') {
        const email = input.get('email').trim();
        await supabaseAuth('otp', { email, create_user: false });
        otpEmail = email;
        renderAccess(true);
      } else {
        useSupabaseSession(await supabaseAuth('verify', { email: otpEmail, token: input.get('token'), type: 'email' }));
        otpEmail = '';
        await refresh(true);
      }
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      submit.disabled = false;
    }
  }
  if (mode === 'login') {
    try {
      await api('/api/login', { password: input.get('password') });
      await refresh(true);
    } catch (error) {
      showNotice(error.message, true);
    }
  }
  if (mode === 'add-copy' || mode === 'import-html') await submitSet(form, input);
  if (mode === 'set-photos-upload') await uploadSetPhotos(form, input.getAll('photos'));
  if (mode === 'add-box') await mutate('add-box', { name: input.get('name') }, { close: true });
  if (mode === 'remove-copy-confirmed') await mutate('remove-copy', { copyId: form.dataset.copy }, { close: true });
  if (mode === 'count') await mutate('count', {
    copyId: activeCopy().id, itemId: form.dataset.item, expected: Number(form.dataset.expected), count: Number(input.get('count')),
  });
  if (mode === 'box-count') await mutate('box-count', {
    boxId: activeBox().id, pieceId: form.dataset.piece, expected: Number(form.dataset.expected), count: Number(input.get('count')),
  });
  if (mode === 'allocate') await mutate('allocate', {
    boxId: activeBox().id, copyId: form.dataset.copy, itemId: form.dataset.item,
    count: Number(input.get('count')), return: event.submitter?.value === 'return',
  });
  if (mode === 'import') {
    const file = input.get('inventory');
    if (file.size > 2 * 1024 * 1024) return showNotice('El CSV puede pesar hasta 2 MB.', true);
    await mutate('csv', { csv: await file.text() }, {
      path: '/api/catalog/csv', close: true, message: 'Inventario disponible en «Añadir set».',
    });
  }
  if (mode === 'rebrickable') await mutate('rebrickable', { number: input.get('number') }, {
    path: '/api/catalog/rebrickable', after: () => addDialog(), message: 'Inventario guardado en el catálogo.',
  });
});

document.addEventListener('input', event => {
  if (event.target.dataset.filter !== 'query') return;
  ui.query = event.target.value;
  ui.catalogPage = 0;
  const caret = event.target.selectionStart;
  render();
  $('#search')?.focus();
  if (caret !== null) $('#search')?.setSelectionRange(caret, caret);
});

document.addEventListener('change', event => {
  const property = event.target.dataset.filter;
  if (property && property !== 'query') {
    ui[property] = event.target.value;
    ui.catalogPage = 0;
    render();
    page.querySelector(`[data-filter="${property}"]`)?.focus();
  }
});

document.addEventListener('error', event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.closest('.photo, .zoom') ||
      image.getAttribute('src') === iconFallback) return;
  image.src = iconFallback;
  image.alt = 'Imagen no disponible';
  const holder = image.closest('.photo');
  if (holder && !holder.querySelector('small')) {
    const message = document.createElement('small');
    message.textContent = 'Sin imagen';
    holder.append(message);
  }
  if (image.closest('.zoom')) image.parentElement.querySelector('figcaption').append(' · Imagen no disponible');
}, true);

dialog.addEventListener('close', () => {
  if (!dialog.open) photoLoads.get(dialogContent)?.abort();
  if (dialogRestore?.isConnected) dialogRestore.focus();
  else page.querySelector('h1')?.scrollIntoView({ block: 'nearest' });
});

function startRefresh() {
  clearInterval(refreshId);
  if (document.visibilityState === 'visible') {
    refresh();
    refreshId = setInterval(() => { if (data) refresh(); }, supabase ? 15000 : 4500);
  }
}

document.addEventListener('visibilitychange', startRefresh);
window.addEventListener('message', event => {
  if (!pagesMode || !pagesLoginWindow || event.origin !== serverOrigin || event.source !== pagesLoginWindow ||
      event.data?.type !== 'inventario-lego:session' || typeof event.data.token !== 'string') return;
  pagesLoginWindow = undefined;
  pagesToken = event.data.token;
  refresh(true);
});
window.addEventListener('online', () => refresh(true));
window.addEventListener('offline', () => connection(true));
startRefresh();
