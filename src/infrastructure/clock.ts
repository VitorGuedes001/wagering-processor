import type { Clock } from '../application/ports';

/** Relógio do sistema. Testes injetam um relógio controlado. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
