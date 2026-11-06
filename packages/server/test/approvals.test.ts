import { waitFor } from './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/bus.ts';
import { SessionManager } from '../src/sessions.ts';
import { parseCommands } from '../src/commands.ts';
import { getTask } from '../src/tasks.ts';
import { createPermissionRequest, decidePermissionRequest } from '../src/approvals.ts';
import { startServer } from '../src/index.ts';
import { createTask, updateTask } from '../src/tasks.ts';
import { HttpError } from '../src/sessions.ts';

test('worker permission requests persist, notify the coordinator, and require an explicit decision', async () => {
  const sm = new SessionManager(new EventBus());
  try {
    const coordinator = await sm.createAgent('mock', { role: 'coordinator', name: 'Coordinator' });
    const worker = await sm.createAgent('mock', { name: 'Builder' });
    const first = sm.addTask({ title: 'prepare release', owner: worker.id });
    await waitFor(() => sm.isRunning(worker.id), 2000, 'worker started');
    await sm.steerAgent(worker.id, 'say: @@tell coordinator :: PERMISSION REQUEST: publish the production release');
    const pending = await waitFor(() => sm.getPermissionRequests().find(r => r.workerId === worker.id && r.status === 'pending'), 3000, 'request saved');
    assert.equal(pending.taskId, first.id);
    assert.equal(getTask(first.id)?.status, 'blocked');
    await waitFor(() => sm.getAgentEvents(coordinator.id).some(e => e.type === 'message' && e.text?.includes(`[PERMISSION REQUEST ${pending.id}]`)), 3000, 'coordinator notified');

    await sm.steerAgent(coordinator.id, `say: @@decline ${pending.id} :: Wait for release approval`);
    await waitFor(() => sm.getPermissionRequests().find(r => r.id === pending.id)?.status === 'declined', 3000, 'coordinator declined');
    assert.equal(sm.getPermissionRequests().find(r => r.id === pending.id)?.status, 'declined');
    assert.equal(getTask(first.id)?.status, 'blocked');
    assert.ok(sm.getAgentEvents(worker.id).some(e => e.type === 'message' && e.text?.includes('DECLINED')));

    const second = sm.addTask({ title: 'prepare staging release', owner: worker.id });
    await waitFor(() => sm.isRunning(worker.id) && getTask(second.id)?.status === 'doing', 3000, 'second task started');
    await sm.steerAgent(worker.id, 'say: @@tell coordinator :: PERMISSION REQUEST: publish the approved staging build');
    const secondRequest = await waitFor(() => sm.getPermissionRequests().find(r => r.taskId === second.id && r.status === 'pending'), 3000, 'second request saved');
    await sm.steerAgent(coordinator.id, `say: @@approve ${secondRequest.id} :: Publish only the staging build`);
    await waitFor(() => getTask(second.id)?.status === 'review', 5000, 'approved task resumed and finished');
    assert.equal(sm.getPermissionRequests().find(r => r.id === secondRequest.id)?.status, 'approved');
    assert.equal(getTask(first.id)?.status, 'blocked', 'completing another task does not alter the declined task');
    assert.ok(sm.getAgentEvents(worker.id).some(e => e.type === 'output' && e.text?.includes('Publish only the staging build')));

    const third = sm.addTask({ title: 'build release notes', owner: worker.id });
    await waitFor(() => sm.isRunning(worker.id) && getTask(third.id)?.status === 'doing', 3000, 'third task started');
    const fourth = sm.addTask({ title: 'check release notes', owner: worker.id });
    await waitFor(() => getTask(third.id)?.status === 'review' && getTask(fourth.id)?.status === 'doing', 5000, 'tasks run in order');
    assert.equal(getTask(third.id)?.status, 'review');
    const canceled = sm.addTask({ title: 'canceled queued work', owner: worker.id });
    sm.removeTask(canceled.id);
    await waitFor(() => getTask(fourth.id)?.status === 'review', 5000, 'fourth task finished');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.ok(!sm.getAgentEvents(worker.id).some(e => e.type === 'output' && e.text?.includes('canceled queued work')));
  } finally {
    await sm.shutdown();
  }
});

test('coordinator approval commands parse with stable permission request IDs', () => {
  const result = parseCommands('@@approve p14 :: deploy to staging only\n@@decline p15 :: production is out of scope');
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.commands.map(c => [c.op, 'id' in c ? c.id : '', 'text' in c ? c.text : '']), [
    ['approve', 'p14', 'deploy to staging only'],
    ['decline', 'p15', 'production is out of scope'],
  ]);
});

test('the approvals API lists saved requests and records a human decision', async () => {
  const request = createPermissionRequest({ workerId: 'worker-gone', request: 'delete generated preview files' });
  const { server, sessionManager, port } = await startServer(0);
  try {
    const listed = await fetch(`http://127.0.0.1:${port}/api/approvals`).then(r => r.json() as Promise<any>);
    assert.ok(listed.approvals.some((item: any) => item.id === request.id && item.status === 'pending'));
    const response = await fetch(`http://127.0.0.1:${port}/api/approvals/${request.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'declined', note: 'keep the previews' }),
    });
    assert.equal(response.status, 200);
    const decided = await response.json() as any;
    assert.equal(decided.approval.status, 'declined');
    assert.equal(decided.approval.decision, 'keep the previews');
  } finally {
    await sessionManager.shutdown();
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a stale approval cannot restart work after its task is removed', async () => {
  const sm = new SessionManager(new EventBus());
  try {
    const worker = await sm.createAgent('mock', { name: 'Stale worker' });
    const task = createTask({ title: 'obsolete publish', owner: worker.id, by: 'user' });
    updateTask(task.id, { status: 'blocked' });
    const request = createPermissionRequest({ workerId: worker.id, taskId: task.id, request: 'publish the build' });
    sm.removeTask(task.id);
    assert.throws(() => sm.decidePermission(request.id, 'approved', 'user', 'staging only'), (error: any) =>
      error instanceof HttpError && error.status === 409);
    assert.equal(sm.getPermissionRequests().find(item => item.id === request.id)?.status, 'pending');
    assert.equal(sm.isRunning(worker.id), false);
  } finally { await sm.shutdown(); }
});

test('an approval for an archived worker stays pending instead of being reported as declined', async () => {
  const sm = new SessionManager(new EventBus());
  try {
    const worker = await sm.createAgent('mock', { name: 'Archived worker' });
    const request = createPermissionRequest({ workerId: worker.id, request: 'upload the preview' });
    await sm.removeAgent(worker.id);
    assert.throws(() => sm.decidePermission(request.id, 'approved', 'user', 'preview only'), (error: any) =>
      error instanceof HttpError && error.status === 409);
    assert.equal(sm.getPermissionRequests().find(item => item.id === request.id)?.status, 'pending');
    assert.ok(!sm.getAgentEvents(worker.id).some(event => event.type === 'message' && event.text?.includes('DECLINED')));
  } finally { await sm.shutdown(); }
});

test('approved work left between decision and queueing is recovered', async () => {
  const sm = new SessionManager(new EventBus());
  try {
    const worker = await sm.createAgent('mock', { name: 'Recovery worker' });
    const task = createTask({ title: 'resume approved publish', owner: worker.id, by: 'user' });
    updateTask(task.id, { status: 'blocked' });
    const request = createPermissionRequest({ workerId: worker.id, taskId: task.id, request: 'publish the staging build' });
    decidePermissionRequest(request.id, 'approved', 'user', 'staging only'); // simulate crash before SessionManager resumes it
    assert.equal(sm.recoverApprovedPermissions(), 1);
    await waitFor(() => getTask(task.id)?.status === 'review', 5000, 'recovered task finished');
    assert.ok(sm.getPermissionRequests().find(item => item.id === request.id)?.appliedAt);
    assert.equal(sm.recoverApprovedPermissions(), 0);
  } finally { await sm.shutdown(); }
});
