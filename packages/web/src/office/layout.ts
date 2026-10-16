// Where everything sits. X runs left-right, Z towards the camera.
import type { Agent } from '../../../shared/src/types.ts';

export type Vec3 = [number, number, number];

export const COLS = 4;
export const MIN_ROWS = 3;
const COL_X = (c: number) => -2 + c * 4.5;
const ROW_Z = (r: number) => -5 + r * 4;

/** The coordinator's glass office on the left, the CEO's raised corner in front of it. */
export const COORDINATOR_ROOM = { x0: -15, x1: -6.5, z0: -7.5, z1: 0.5 };
export const COORDINATOR_DESK: Vec3 = [-10.75, 0, -4];
export const CEO_AREA = { x0: -15, x1: -6.5, z0: 2.5, z1: 9.5 };
export const CEO_DESK: Vec3 = [-10.75, 0.3, 5.5];

export function workerDesk(i: number): Vec3 {
  return [COL_X(i % COLS), 0, ROW_Z(Math.floor(i / COLS))];
}

export function rowsFor(workers: number): number {
  return Math.max(MIN_ROWS, Math.ceil(workers / COLS));
}

export function roomBounds(workers: number) {
  const rows = rowsFor(workers);
  return { x0: -16, x1: COL_X(COLS - 1) + 3.5, z0: -8, z1: Math.max(10, ROW_Z(rows - 1) + 3.5) };
}

/** Seat for every agent: coordinator and CEO have their own rooms, workers fill desks in creation order. */
export function seatAgents(agents: Agent[]): Map<string, Vec3> {
  const seats = new Map<string, Vec3>();
  const workers = agents.filter(a => a.role === 'worker').sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  workers.forEach((a, i) => seats.set(a.id, workerDesk(i)));
  for (const a of agents) {
    if (a.role === 'coordinator') seats.set(a.id, COORDINATOR_DESK);
    if (a.role === 'ceo') seats.set(a.id, CEO_DESK);
  }
  return seats;
}
