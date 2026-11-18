import { Buffer } from 'node:buffer';
import { AppError } from './catalog.mjs';

const MiB = 1024 * 1024;
const maxPhotoBytes = 10 * MiB;
const maxBatchBytes = 24 * MiB;
export const photoRequestLimit = 33;

function imageType(bytes) {
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (bytes.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

export function decodeSetPhotos(photos) {
  if (!Array.isArray(photos) || photos.length === 0 || photos.length > 30) {
    throw new AppError('Selecciona entre 1 y 30 fotos.');
  }
  let batchBytes = 0;
  return photos.map(photo => {
    const encoded = photo?.data;
    if (typeof encoded !== 'string' || encoded.length > 4 * Math.ceil(maxPhotoBytes / 3)) {
      throw new AppError('Cada foto puede pesar hasta 10 MB.', 413);
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.toString('base64') !== encoded) throw new AppError('Una de las fotos no se pudo leer.');
    if (bytes.length > maxPhotoBytes) throw new AppError('Cada foto puede pesar hasta 10 MB.', 413);
    batchBytes += bytes.length;
    if (batchBytes > maxBatchBytes) throw new AppError('Selecciona hasta 24 MB de fotos por carga.', 413);
    const mime = imageType(bytes);
    if (!mime) throw new AppError('Las fotos deben ser JPG, PNG, WebP o GIF.');
    const name = typeof photo.name === 'string' ? photo.name.trim().slice(0, 160) : '';
    return { name: name || 'Foto', mime, bytes };
  });
}
