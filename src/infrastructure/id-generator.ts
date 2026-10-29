import { randomUUID } from 'node:crypto';
import type { IdGenerator } from '../application/ports';

/** Ids de entidades e eventos (ARQUITETURA §3). */
export class RandomUuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

/** Gera UUIDv7 padrão RFC 9562 (ARQUITETURA §6.1). */
export function generateUuidV7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const now = Date.now();

  bytes[0] = (now >> 40) & 0xff;
  bytes[1] = (now >> 32) & 0xff;
  bytes[2] = (now >> 24) & 0xff;
  bytes[3] = (now >> 16) & 0xff;
  bytes[4] = (now >> 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
