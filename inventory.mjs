import { randomUUID } from 'node:crypto';
import { AppError, pieceId } from './catalog.mjs';
import { addSet, removeSet } from './sets.mjs';

export function lineProgress(copy, item) {
  const line = copy.lines[item.id];
  const direct = line?.direct ?? 0;
  const allocated = Object.values(line?.allocations ?? {}).reduce((sum, count) => sum + count, 0);
  const have = direct + allocated;
  const missing = Math.max(0, item.needed - have);
  const reviewed = !missing || Boolean(line?.reviewed);
  return { direct, allocated, have, missing, reviewed };
}

function integer(value, min, max = 999999) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AppError('Introduce una cantidad entera entre ' + min + ' y ' + max + '.');
  }
  return value;
}

function label(value, fallback) {
  const name = String(value ?? '').trim() || fallback;
  if (!name || name.length > 90) throw new AppError('Introduce un nombre de hasta 90 caracteres.');
  return name;
}

function copyAndItem(state, command) {
  const copy = state.copies.find(entry => entry.id === command.copyId);
  if (!copy) throw new AppError('La copia de set ya no existe.', 404);
  const item = state.catalog.find(entry => entry.id === copy.catalogId)
    .items.find(entry => entry.id === command.itemId);
  if (!item) throw new AppError('La pieza no pertenece a esta copia de set.', 404);
  return { copy, item };
}

function boxById(state, id) {
  const box = state.boxes.find(entry => entry.id === id);
  if (!box) throw new AppError('La caja ya no existe.', 404);
  return box;
}

function usedInBox(state, boxId, matchingPiece) {
  let total = 0;
  for (const copy of state.copies) {
    const inventory = state.catalog.find(entry => entry.id === copy.catalogId);
    const matchingItem = inventory.items.find(item => !item.spare && pieceId(item) === matchingPiece);
    if (matchingItem) total += copy.lines[matchingItem.id]?.allocations?.[boxId] ?? 0;
  }
  return total;
}

function pieceInCatalog(state, id) {
  for (const inventory of state.catalog) {
    const item = inventory.items.find(entry => entry.type === 'part' && pieceId(entry) === id);
    if (item) return item;
  }
  const loose = state.loosePieces?.find(item => item.type === 'part' && pieceId(item) === id);
  if (loose) return loose;
  throw new AppError('Selecciona una pieza del catálogo.', 404);
}

export function applyCommand(state, command) {
  switch (command.action) {
    case 'add-copy':
      addSet(state, command.catalogId, command.name);
      break;
    case 'remove-copy':
      removeSet(state, command.copyId);
      break;
    case 'set-photo-cover': {
      const set = state.copies.find(entry => entry.id === command.copyId);
      if (!set?.photos?.some(photo => photo.id === command.photoId)) {
        throw new AppError('No se encontró esa foto en el set.', 404);
      }
      set.coverPhotoId = command.photoId;
      break;
    }
    case 'add-box':
      state.boxes.push({ id: randomUUID(), name: label(command.name), pieces: {} });
      break;
    case 'box-count': {
      const box = boxById(state, command.boxId);
      pieceInCatalog(state, command.pieceId);
      const current = box.pieces[command.pieceId] ?? 0;
      if (command.expected !== current) throw new AppError('La cantidad de la caja cambió. Revísala y vuelve a intentarlo.', 409);
      const count = integer(command.count, 0);
      const used = usedInBox(state, box.id, command.pieceId);
      if (count < used) throw new AppError('Ya hay ' + used + ' unidades asignadas. Devuélvelas antes de bajar el total.', 409);
      if (count) box.pieces[command.pieceId] = count;
      else delete box.pieces[command.pieceId];
      break;
    }
    case 'count':
    case 'review': {
      const { copy, item } = copyAndItem(state, command);
      const current = lineProgress(copy, item);
      const line = copy.lines[item.id] ?? { direct: 0, reviewed: false, allocations: {} };
      if (command.action === 'count') {
        if (command.expected !== current.direct) throw new AppError('El recuento cambió en otro dispositivo.', 409);
        line.direct = command.all ? item.needed - current.allocated :
          integer(command.count, 0, item.needed - current.allocated);
        line.reviewed = true;
      } else {
        if (typeof command.reviewed !== 'boolean') throw new AppError('Estado de revisión incorrecto.');
        if (!current.missing && !command.reviewed) throw new AppError('Ajusta la cantidad para reabrir una pieza completa.');
        line.reviewed = command.reviewed;
      }
      copy.lines[item.id] = line;
      break;
    }
    case 'count-none': {
      const { copy, item } = copyAndItem(state, command);
      const current = lineProgress(copy, item);
      if (command.expected !== current.direct || command.expectedAllocated !== current.allocated) {
        throw new AppError('El recuento o las asignaciones cambiaron en otro dispositivo.', 409);
      }
      copy.lines[item.id] = { direct: 0, reviewed: true, allocations: {} };
      break;
    }
    case 'allocate': {
      const { copy, item } = copyAndItem(state, command);
      if (item.spare || item.type !== 'part') throw new AppError('La caja solo se asigna a piezas requeridas.');
      const box = boxById(state, command.boxId);
      const key = pieceId(item);
      const line = copy.lines[item.id] ?? { direct: 0, reviewed: false, allocations: {} };
      const already = line.allocations[box.id] ?? 0;
      const count = integer(command.count, 1);
      if (command.return === true) {
        if (count > already) throw new AppError('Esta copia tiene asignadas menos unidades de esa caja.', 409);
        if (count === already) delete line.allocations[box.id];
        else line.allocations[box.id] = already - count;
      } else {
        const available = (box.pieces[key] ?? 0) - usedInBox(state, box.id, key);
        const progress = lineProgress(copy, item);
        if (count > available || count > progress.missing) {
          throw new AppError('La cantidad disponible o necesaria cambió. Revisa el recuento.', 409);
        }
        line.allocations[box.id] = already + count;
        if (count === progress.missing) line.reviewed = true;
      }
      copy.lines[item.id] = line;
      break;
    }
    default:
      throw new AppError('Acción no reconocida.');
  }
}
