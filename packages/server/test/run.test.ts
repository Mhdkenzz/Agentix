// Agentix — tests
import test from 'node:test';
import assert from 'node:assert/strict';

test('store: create and get agent', async () => {
  const { store } = await import('../src/store.ts');
  const agent = {
    id: 'test_001',
    name: 'TestAgent',
    kind: 'mock' as const,
    role: 'worker' as const,
    avatarId: 0,
    cwd: '/tmp',
    status: 'idle' as const,
    activity: 'idle',
    createdAt: Date.now(),
  };

  // Clean up first
  const existing = store.getAgent('test_001');
  if (existing) store.removeAgent('test_001');

  store.createAgent(agent);
  const got = store.getAgent('test_001');

  assert.ok(got, 'agent should exist');
  assert.strictEqual(got!.id, 'test_001');
  assert.strictEqual(got!.name, 'TestAgent');
  assert.strictEqual(got!.kind, 'mock');
  assert.strictEqual(got!.role, 'worker');

  // Cleanup
  store.removeAgent('test_001');
});

test('store: update agent', async () => {
  const { store } = await import('../src/store.ts');
  const agent = {
    id: 'test_002',
    name: 'Updater',
    kind: 'mock' as const,
    role: 'worker' as const,
    avatarId: 1,
    cwd: '/tmp',
    status: 'idle' as const,
    activity: 'idle',
    createdAt: Date.now(),
  };

  store.createAgent(agent);
  agent.name = 'UpdatedName';
  agent.status = 'working';
  store.updateAgent(agent);

  const got = store.getAgent('test_002');
  assert.strictEqual(got!.name, 'UpdatedName');
  assert.strictEqual(got!.status, 'working');

  store.removeAgent('test_002');
});

test('store: remove agent', async () => {
  const { store } = await import('../src/store.ts');
  const agent = {
    id: 'test_003',
    name: 'Remover',
    kind: 'mock' as const,
    role: 'worker' as const,
    avatarId: 2,
    cwd: '/tmp',
    status: 'idle' as const,
    activity: 'idle',
    createdAt: Date.now(),
  };

  store.createAgent(agent);
  assert.ok(store.getAgent('test_003'));

  store.removeAgent('test_003');
  assert.strictEqual(store.getAgent('test_003'), undefined);
});

test('store: append and get events', async () => {
  const { store } = await import('../src/store.ts');
  const agent = {
    id: 'test_004',
    name: 'EventAgent',
    kind: 'mock' as const,
    role: 'worker' as const,
    avatarId: 3,
    cwd: '/tmp',
    status: 'idle' as const,
    activity: 'idle',
    createdAt: Date.now(),
  };

  store.createAgent(agent);

  const e1 = store.appendEvent({ type: 'output', text: 'hello' }, 'test_004');
  const e2 = store.appendEvent({ type: 'tool', text: 'editing file' }, 'test_004');

  assert.ok(e1.id > 0);
  assert.ok(e2.id > e1.id, 'event IDs should be monotonic');

  const events = store.getAgentEvents('test_004');
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].text, 'hello');
  assert.strictEqual(events[1].text, 'editing file');

  // Test after filter
  const filtered = store.getAgentEvents('test_004', e1.id);
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].text, 'editing file');

  store.removeAgent('test_004');
});

test('store: list agents', async () => {
  const { store } = await import('../src/store.ts');

  // Clean up test agents
  for (const id of ['test_005', 'test_006']) {
    const existing = store.getAgent(id);
    if (existing) store.removeAgent(id);
  }

  const a1 = { id: 'test_005', name: 'Agent1', kind: 'mock' as const, role: 'worker' as const, avatarId: 0, cwd: '/tmp', status: 'idle' as const, activity: 'idle', createdAt: Date.now() };
  const a2 = { id: 'test_006', name: 'Agent2', kind: 'mock' as const, role: 'worker' as const, avatarId: 1, cwd: '/tmp', status: 'idle' as const, activity: 'idle', createdAt: Date.now() };

  store.createAgent(a1);
  store.createAgent(a2);

  const agents = store.getAgents();
  assert.ok(agents.length >= 2, `should have at least 2 agents, got ${agents.length}`);

  // Cleanup
  store.removeAgent('test_005');
  store.removeAgent('test_006');
});

test('event bus: subscribe and publish', async () => {
  const { EventBus } = await import('../src/bus.ts');
  const bus = new EventBus();

  const received: any[] = [];
  const unsub = bus.subscribe((e) => { received.push(e); });

  const { store } = await import('../src/store.ts');
  const agent = { id: 'test_bus', name: 'BusAgent', kind: 'mock' as const, role: 'worker' as const, avatarId: 0, cwd: '/tmp', status: 'idle' as const, activity: 'idle', createdAt: Date.now() };
  store.createAgent(agent);

  bus.publish(store.appendEvent({ type: 'output', text: 'test1' }, 'test_bus'));
  bus.publish(store.appendEvent({ type: 'output', text: 'test2' }, 'test_bus'));

  assert.strictEqual(received.length, 2);
  assert.strictEqual(received[0].text, 'test1');
  assert.strictEqual(received[1].text, 'test2');

  unsub();

  // After unsubscribing, new events shouldn't be received
  const before = received.length;
  bus.publish(store.appendEvent({ type: 'output', text: 'test3' }, 'test_bus'));
  assert.strictEqual(received.length, before, 'should not receive after unsubscribe');

  store.removeAgent('test_bus');
});

test('event bus: new subscriber gets history', async () => {
  const { EventBus } = await import('../src/bus.ts');
  const bus = new EventBus();

  const { store } = await import('../src/store.ts');
  const agent = { id: 'test_hist', name: 'HistAgent', kind: 'mock' as const, role: 'worker' as const, avatarId: 0, cwd: '/tmp', status: 'idle' as const, activity: 'idle', createdAt: Date.now() };
  store.createAgent(agent);

  bus.publish(store.appendEvent({ type: 'output', text: 'old1' }, 'test_hist'));
  bus.publish(store.appendEvent({ type: 'output', text: 'old2' }, 'test_hist'));

  const received: any[] = [];
  bus.subscribe((e) => { received.push(e); });

  assert.strictEqual(received.length, 2, 'new subscriber should get recent history');
  assert.strictEqual(received[0].text, 'old1');
  assert.strictEqual(received[1].text, 'old2');

  store.removeAgent('test_hist');
});

test('store: store type detection', async () => {
  const { store } = await import('../src/store.ts');
  const type = store.getStoreType();
  assert.ok(type === 'sqlite' || type === 'json', `store type should be sqlite or json, got ${type}`);
});
