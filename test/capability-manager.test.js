const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { CapabilityManager } = require('../src/capability-manager');
const { executePlan } = require('../src/executor');

async function readLog(file) {
  return (await fs.readFile(file, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'private-os-capability-'));
  const logPath = path.join(root, 'capabilities.jsonl');
  const manager = new CapabilityManager(logPath, path.join(root, 'secret.key'), 5000);
  const plan = { summary: 'test', actions: [{ type: 'list_directory', path: '.', startsWith: 's' }] };

  // Every incoming task receives a unique ID and an expiry time.
  const firstTask = await manager.startTask();
  const secondTask = await manager.startTask();
  assert.notEqual(firstTask.taskId, secondTask.taskId);
  assert.equal(firstTask.status, 'ACTIVE');
  assert(Date.parse(firstTask.expiresAt) > Date.parse(firstTask.issuedAt));

  // A valid capability executes once and cannot be replayed.
  const firstCapability = await manager.issue(firstTask, plan);
  assert.equal(firstCapability.agent, 'AuditAgent');
  assert.deepEqual(firstCapability.operation, ['list_directory']);
  assert.deepEqual(firstCapability.resources, ['.']);
  assert.deepEqual(firstCapability.recipients, []);
  assert.deepEqual(firstCapability.attachments, []);
  assert.equal(firstCapability.status, 'ACTIVE');
  assert.equal(typeof firstCapability.planHash, 'string');
  assert.equal(typeof firstCapability.signature, 'string');
  await manager.consume(firstCapability, plan);
  await assert.rejects(() => manager.consume(firstCapability, plan), /cannot be replayed/i);

  // A capability is bound to the exact plan it was issued for.
  const changedPlan = { ...plan, actions: [{ type: 'list_directory', path: '.', startsWith: 'x' }] };
  const secondCapability = await manager.issue(secondTask, plan);
  await assert.rejects(() => manager.consume(secondCapability, changedPlan), /does not match this plan/i);

  // A short-lived capability expires and is recorded as EXPIRED.
  const expiryLogPath = path.join(root, 'expiry-capabilities.jsonl');
  const expiryManager = new CapabilityManager(expiryLogPath, path.join(root, 'expiry-secret.key'), 25);
  const expiringTask = await expiryManager.startTask();
  const expiringCapability = await expiryManager.issue(expiringTask, plan);
  await new Promise((resolve) => setTimeout(resolve, 40));
  await assert.rejects(() => expiryManager.consume(expiringCapability, plan), /expired/i);

  // Rejected requests are recorded separately.
  const rejectedTask = await manager.startTask();
  await manager.reject(rejectedTask, 'Unsafe path');

  const lines = [...await readLog(logPath), ...await readLog(expiryLogPath)];
  const statuses = new Set(lines.map((line) => line.status));
  assert(statuses.has('ACTIVE'));
  assert(statuses.has('USED'));
  assert(statuses.has('EXPIRED'));
  assert(statuses.has('REJECTED'));

  const auditPath = path.join(root, 'audit.jsonl');
  await fs.appendFile(auditPath, `${JSON.stringify({ time: new Date().toISOString(), event: 'plan-executed', detail: { taskId: firstTask.taskId, results: ['Listed files'] } })}\n`);
  const history = await executePlan({ actions: [{ type: 'show_task_history' }] }, { capabilityLogPath: logPath, auditPath });
  assert(history.some((line) => line.includes(firstTask.taskId) && line.includes('Status: USED')));
  console.log('Capability-manager tests passed: unique IDs, expiry, replay protection, plan binding, and rejection logging.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
