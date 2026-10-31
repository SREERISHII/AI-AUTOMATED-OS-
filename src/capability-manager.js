const crypto = require('crypto');
const fs = require('fs/promises');

const TTL_MS = 5 * 60 * 1000;

class CapabilityManager {
  constructor(logPath, secretPath, ttlMs = TTL_MS) {
    this.logPath = logPath;
    this.secretPath = secretPath;
    this.ttlMs = ttlMs;
    this.secret = null;
    this.records = new Map();
    this.ready = this.initialize();
  }

  async initialize() {
    await fs.mkdir(require('path').dirname(this.logPath), { recursive: true });
    try { this.secret = await fs.readFile(this.secretPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.secret = crypto.randomBytes(32);
      await fs.writeFile(this.secretPath, this.secret, { mode: 0o600 });
    }
    try {
      const contents = await fs.readFile(this.logPath, 'utf8');
      for (const line of contents.split(/\r?\n/).filter(Boolean)) {
        try { const record = JSON.parse(line); if (record.taskId) this.records.set(record.taskId, record); } catch { /* ignore malformed historical lines */ }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async append(record) {
    await this.ready;
    await fs.appendFile(this.logPath, `${JSON.stringify(record)}\n`, 'utf8');
    this.records.set(record.taskId, record);
  }

  async startTask(request = '') {
    await this.ready;
    const now = Date.now();
    for (const record of this.records.values()) {
      if (record.status === 'ACTIVE' && Date.parse(record.expiresAt) <= now) {
        await this.append({ ...record, status: 'EXPIRED', updatedAt: new Date(now).toISOString() });
      }
    }
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + this.ttlMs);
    const task = { taskId: `task-${crypto.randomUUID()}`, request: String(request || ''), issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString(), status: 'ACTIVE' };
    await this.append(task);
    return task;
  }

  planHash(plan) {
    return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  }

  scopeForPlan(plan) {
    const actions = Array.isArray(plan?.actions) ? plan.actions : [];
    const types = [...new Set(actions.map((action) => action.type))];
    const agent = types.every((type) => type === 'send_email') ? 'EmailAgent'
      : types.every((type) => ['list_directory', 'search_files', 'show_task_history'].includes(type)) ? 'AuditAgent'
      : types.every((type) => type !== 'send_email') ? 'FileAgent' : 'DesktopAgent';
    return {
      agent,
      operation: types,
      resources: [...new Set(actions.flatMap((action) => [action.path, action.destination]).filter(Boolean))],
      recipients: [...new Set(actions.flatMap((action) => Array.isArray(action.to) ? action.to : []).filter(Boolean))],
      attachments: [...new Set(actions.flatMap((action) => Array.isArray(action.attachments) ? action.attachments : []).filter(Boolean))]
    };
  }

  sign(payload) {
    return crypto.createHmac('sha256', this.secret).update(JSON.stringify(payload)).digest('base64url');
  }

  async issue(task, plan) {
    await this.ready;
    const payload = { taskId: task.taskId, issuedAt: task.issuedAt, expiresAt: task.expiresAt, status: 'ACTIVE', ...this.scopeForPlan(plan), planHash: this.planHash(plan) };
    await this.append({ ...task, ...this.scopeForPlan(plan), planHash: payload.planHash, status: 'ACTIVE', updatedAt: new Date().toISOString() });
    return { ...payload, signature: this.sign(payload) };
  }

  async reject(task, reason) {
    await this.append({ ...task, status: 'REJECTED', reason, updatedAt: new Date().toISOString() });
  }

  async consume(capability, plan) {
    await this.ready;
    if (!capability || typeof capability !== 'object') throw new Error('Missing task capability. Create a new plan.');
    const payload = { taskId: capability.taskId, issuedAt: capability.issuedAt, expiresAt: capability.expiresAt, status: capability.status, agent: capability.agent, operation: capability.operation, resources: capability.resources, recipients: capability.recipients, attachments: capability.attachments, planHash: capability.planHash };
    const expected = this.sign(payload);
    const supplied = Buffer.from(String(capability.signature || ''));
    const expectedBuffer = Buffer.from(expected);
    if (supplied.length !== expectedBuffer.length || !crypto.timingSafeEqual(supplied, expectedBuffer)) throw new Error('Invalid task capability signature.');
    const record = this.records.get(capability.taskId);
    if (!record) throw new Error('Unknown task capability.');
    if (record.status !== 'ACTIVE') throw new Error(`Task capability cannot be replayed; current status is ${record.status}.`);
    if (Date.now() >= Date.parse(capability.expiresAt)) {
      await this.append({ ...record, status: 'EXPIRED', updatedAt: new Date().toISOString() });
      throw new Error('Task capability has expired. Create a new plan.');
    }
    if (capability.planHash !== this.planHash(plan)) throw new Error('Task capability does not match this plan.');
    await this.append({ ...record, status: 'USED', usedAt: new Date().toISOString() });
  }
}

module.exports = { CapabilityManager };
