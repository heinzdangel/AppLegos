import { randomUUID } from 'node:crypto';
import { AppError, pieceId, setCode } from './catalog.mjs';

function retainPieces(state, inventories) {
  const retained = new Map((state.loosePieces ?? []).map(piece => [pieceId(piece), piece]));
  for (const inventory of inventories) {
    for (const item of inventory.items) {
      const key = pieceId(item);
      const previous = retained.get(key);
      if (!previous || (!previous.image && item.image)) {
        const { type, part, name, element, colorId, color, image } = item;
        retained.set(key, { type, part, name, element, colorId, color, image });
      }
    }
  }
  state.loosePieces = [...retained.values()];
}

export function removeUnusedInventories(state, ids) {
  const used = new Set(state.copies.map(copy => copy.catalogId));
  const removed = [];
  state.catalog = state.catalog.filter(inventory => {
    if (!ids.has(inventory.id) || used.has(inventory.id)) return true;
    removed.push(inventory);
    return false;
  });
  if (removed.length) retainPieces(state, removed);
}

function mergeProgress(inventory, previousCopies, catalogById) {
  const linesById = new Map();
  for (const copy of previousCopies) {
    for (const item of catalogById.get(copy.catalogId).items) {
      const line = copy.lines[item.id];
      if (!line) continue;
      if (!linesById.has(item.id)) linesById.set(item.id, []);
      linesById.get(item.id).push({ line, needed: item.needed });
    }
  }

  const lines = {};
  for (const item of inventory.items) {
    const recorded = linesById.get(item.id);
    if (!recorded) continue;
    // Duplicate set records may describe the same pieces, so direct counts are never added together.
    const direct = Math.min(item.needed, Math.max(...recorded.map(entry => entry.line.direct ?? 0)));
    let available = item.needed - direct;
    const allocations = {};
    for (const { line } of recorded) {
      for (const [boxId, count] of Object.entries(line.allocations ?? {})) {
        const retained = Math.min(available, count);
        if (retained) allocations[boxId] = (allocations[boxId] ?? 0) + retained;
        available -= retained;
      }
    }
    const reviewed = available === 0 || recorded.some(({ line, needed }) =>
      needed === item.needed && line.reviewed &&
      (line.direct ?? 0) + Object.values(line.allocations ?? {}).reduce((sum, count) => sum + count, 0) === item.needed - available);
    lines[item.id] = { direct, allocations, reviewed };
  }
  return lines;
}

export function consolidateSets(state) {
  const groups = new Map();
  const catalogById = new Map();
  for (const inventory of state.catalog) {
    const code = setCode(inventory.number);
    if (!groups.has(code)) groups.set(code, { inventory, copies: [] });
    const group = groups.get(code);
    if (!inventory.partial || group.inventory.partial) group.inventory = inventory;
    catalogById.set(inventory.id, inventory);
  }
  const copies = [];
  for (const copy of state.copies) {
    const code = setCode(catalogById.get(copy.catalogId).number);
    const group = groups.get(code);
    if (!group.copies.length) copies.push(copy);
    group.copies.push(copy);
  }
  if (groups.size === state.catalog.length && copies.length === state.copies.length) return false;

  const previousCatalog = state.catalog;
  for (const { inventory, copies: duplicates } of groups.values()) {
    if (!duplicates.length) continue;
    const [keep] = duplicates;
    if (duplicates.length === 1 && keep.catalogId === inventory.id) continue;
    keep.lines = mergeProgress(inventory, duplicates, catalogById);
    keep.catalogId = inventory.id;
  }
  state.catalog = [...groups.values()].map(group => group.inventory);
  state.copies = copies;
  const kept = new Set(state.catalog.map(inventory => inventory.id));
  retainPieces(state, previousCatalog.filter(inventory => !kept.has(inventory.id)));
  return true;
}

function imageKey(value) {
  if (!value) return '';
  const url = new URL(value);
  return url.host === 'cdn.rebrickable.com' ? url.origin + url.pathname : url.href;
}

function inventoryDetails(entry) {
  const items = [...entry.items].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify([entry.number, entry.name, entry.partial, imageKey(entry.image), items.map(item =>
    [item.id, item.name, item.element, item.color, item.needed, imageKey(item.image)])]);
}

function saveInventory(state, entry) {
  const code = setCode(entry.number);
  const index = state.catalog.findIndex(item => setCode(item.number) === code);
  const previous = state.catalog[index];
  if (!previous) {
    state.catalog.push(entry);
    return { inventory: entry, changed: true };
  }

  const inventory = {
    ...entry,
    image: entry.image || (previous.number === entry.number ? previous.image || '' : ''),
  };
  if ((entry.partial && !previous.partial) || inventoryDetails(previous) === inventoryDetails(inventory)) {
    return { inventory: previous, changed: false };
  }
  const set = state.copies.find(copy => copy.catalogId === previous.id);
  if (set) {
    set.lines = mergeProgress(inventory, [set], new Map([[previous.id, previous]]));
    set.catalogId = inventory.id;
  }
  state.catalog[index] = inventory;
  retainPieces(state, [previous]);
  return { inventory, changed: true };
}

export function addCatalog(state, inventories) {
  const codes = new Set();
  for (const inventory of inventories) {
    const code = setCode(inventory.number);
    if (codes.has(code)) throw new AppError('El archivo contiene más de un inventario para el set ' + code + '. Deja una sola versión por código.');
    codes.add(code);
  }
  for (const inventory of inventories) saveInventory(state, inventory);
}

function setTitle(value) {
  const title = String(value ?? '').trim();
  if (title.length > 90) throw new AppError('Introduce un nombre de hasta 90 caracteres.');
  return title;
}

export function addSet(state, catalogId, name) {
  const inventory = state.catalog.find(entry => entry.id === catalogId);
  if (!inventory) throw new AppError('Selecciona un inventario del catálogo.', 404);
  const code = setCode(inventory.number);
  const sameCode = new Set(state.catalog.filter(entry => setCode(entry.number) === code).map(entry => entry.id));
  if (state.copies.some(entry => sameCode.has(entry.catalogId))) {
    throw new AppError(code + ' ya está en tu colección.', 409);
  }
  const title = setTitle(name);
  const set = { id: randomUUID(), catalogId: inventory.id, name: title || inventory.name, lines: {} };
  state.copies.push(set);
  return set;
}

export function classifySet(state, copyId, value, expected) {
  const set = state.copies.find(copy => copy.id === copyId);
  if (!set) throw new AppError('El set ya no existe.', 404);
  const inventory = state.catalog.find(entry => entry.id === set.catalogId);
  if (setCode(inventory.number).startsWith('MOC-')) {
    throw new AppError('Esta clasificación se aplica a los sets oficiales.');
  }
  if (!['', 'complete', 'without-minifigures', 'partial'].includes(value)) {
    throw new AppError('Selecciona una clasificación válida.');
  }
  if (expected !== (set.classification ?? '')) {
    throw new AppError('La clasificación cambió en otro dispositivo. Revísala y vuelve a intentarlo.', 409);
  }
  set.classification = value;
}

export function removeSet(state, copyId) {
  const index = state.copies.findIndex(copy => copy.id === copyId);
  if (index === -1) throw new AppError('El set ya no existe.', 404);
  const [{ catalogId }] = state.copies.splice(index, 1);
  const code = setCode(state.catalog.find(entry => entry.id === catalogId).number);
  const ids = new Set(state.catalog.filter(entry => setCode(entry.number) === code).map(entry => entry.id));
  removeUnusedInventories(state, ids);
}

export function importSet(state, entry, name) {
  const title = setTitle(name);
  const { inventory, changed } = saveInventory(state, entry);
  const set = state.copies.find(copy => copy.catalogId === inventory.id);
  if (!set) return { set: addSet(state, inventory.id, name), outcome: 'created' };
  const renamed = Boolean(title && set.name !== title);
  if (renamed) set.name = title;
  return { set, outcome: changed || renamed ? 'updated' : 'unchanged' };
}
