// Durable worker permission requests, separate from tasks because a worker can ask before it has one.
import { writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionDecision, PermissionRequest } from '../../shared/src/types.ts';
import { AGENTIX_HOME } from './store.ts';
import { isJsonRecord, readJsonFile, quarantineJsonFile } from './json-files.ts';

const file = () => join(AGENTIX_HOME, 'approvals.json');
const MAX_REQUEST_TEXT = 4_000;
let cache: PermissionRequest[] | undefined;
let nextId = 1;

export class ApprovalError extends Error {}

function load(): PermissionRequest[] {
  if (cache) return cache;
  const data = readJsonFile(file(), 'permission requests');
  const valid = data === undefined || (isJsonRecord(data) && Array.isArray(data.requests) && data.requests.every((r: any) =>
    r && typeof r.id === 'string' && /^p\d+$/.test(r.id) && typeof r.workerId === 'string'
    && typeof r.request === 'string' && ['pending', 'approved', 'declined'].includes(r.status)
    && Number.isFinite(r.createdAt)));
  if (!valid) {
    quarantineJsonFile(file(), 'permission request file has an invalid structure');
    cache = []; nextId = 1;
  } else {
    const requests: PermissionRequest[] = data?.requests ?? [];
    nextId = Math.max(Number(data?.nextId) || 1, ...requests.map(r => Number(r.id.slice(1)) + 1 || 1));
    cache = requests;
  }
  return cache;
}

function save(requests: PermissionRequest[]): void {
  mkdirSync(AGENTIX_HOME, { recursive: true });
  writeFileSync(file() + '.tmp', JSON.stringify({ requests, nextId }, null, 2));
  renameSync(file() + '.tmp', file());
  cache = requests;
}

export function listPermissionRequests(): PermissionRequest[] {
  return load().map(r => ({ ...r })).sort((a, b) =>
    Number(a.status !== 'pending') - Number(b.status !== 'pending') || b.createdAt - a.createdAt);
}

export function getPermissionRequest(id: string): PermissionRequest | undefined {
  const found = load().find(r => r.id === id);
  return found ? { ...found } : undefined;
}

export function createPermissionRequest(fields: { workerId: string; taskId?: string; request: string }): PermissionRequest {
  const request = String(fields.request ?? '').trim().slice(0, MAX_REQUEST_TEXT);
  if (!request) throw new ApprovalError('a permission request needs a description');
  const normalized = request.toLowerCase();
  const duplicate = load().find(r => r.status === 'pending' && r.workerId === fields.workerId
    && r.taskId === fields.taskId && r.request.toLowerCase() === normalized);
  if (duplicate) return { ...duplicate };
  const saved: PermissionRequest = {
    id: `p${nextId++}`, workerId: fields.workerId, request, status: 'pending', createdAt: Date.now(),
    ...(fields.taskId ? { taskId: fields.taskId } : {}),
  };
  save([...load(), saved]);
  return { ...saved };
}

export function decidePermissionRequest(id: string, decision: PermissionDecision, decidedBy: string, note = ''): PermissionRequest {
  if (decision !== 'approved' && decision !== 'declined') throw new ApprovalError('decision must be approved or declined');
  const requests = load();
  const request = requests.find(r => r.id === id);
  if (!request) throw new ApprovalError(`no permission request ${id}`);
  if (request.status !== 'pending') throw new ApprovalError(`permission request ${id} is already ${request.status}`);
  request.status = decision;
  request.decidedAt = Date.now();
  request.decidedBy = decidedBy;
  request.decision = String(note).trim().slice(0, 2_000);
  save(requests);
  return { ...request };
}

export function markPermissionRequestApplied(id: string): void {
  const requests = load();
  const request = requests.find(r => r.id === id);
  if (!request || request.status !== 'approved' || request.appliedAt) return;
  request.appliedAt = Date.now();
  save(requests);
}

export function clearPermissionRequests(): void {
  cache = [];
  nextId = 1;
  try { rmSync(file(), { force: true }); } catch { /* best effort */ }
}
