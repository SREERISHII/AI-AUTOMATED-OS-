const assert = require('assert');
const { normalizeEmailText } = require('../src/planner');

const dirty = String.raw`Dear Dear Sir/Madam,\n\nPlease approve my leave.\n\nSincerely,\nUser\n\nSincerely,\nUser`;
const clean = normalizeEmailText(dirty);

assert.equal((clean.match(/Dear Sir\/Madam,/g) || []).length, 1);
assert.equal((clean.match(/Sincerely,/g) || []).length, 1);
assert(!clean.includes('\\n'));
assert(clean.includes('\n\nPlease approve my leave.'));
console.log('Planner email-format tests passed.');

const { isTaskHistoryRequest, buildPlan } = require('../src/planner');

assert(isTaskHistoryRequest('SHOW ME THE TASK HISTORY'));
assert(isTaskHistoryRequest('show task history'));
assert(isTaskHistoryRequest('task history'));
assert(isTaskHistoryRequest('show audit log'));
assert(isTaskHistoryRequest('view logs'));
assert(isTaskHistoryRequest('history'));
assert(!isTaskHistoryRequest('list files in history folder'));
assert(!isTaskHistoryRequest('create a folder called history'));

const { isCapabilityRequest, CAPABILITY_GUIDE } = require('../src/planner');

assert(isCapabilityRequest('what can yu do'));
assert(isCapabilityRequest('what can  yu do'));
assert(isCapabilityRequest('what can you do'));
assert(isCapabilityRequest('what do you do'));
assert(isCapabilityRequest('what u can do'));
assert(isCapabilityRequest('tell me what you can do'));
assert(isCapabilityRequest('what are your capabilities'));
assert(isCapabilityRequest('features'));
assert(isCapabilityRequest('help'));
assert(!isCapabilityRequest('delete what can you do.txt'));
console.log('Planner capability query tests passed.');

const {
  hasExplicitAttachmentRequest,
  extractExplicitAttachments,
  extractExplicitEmailBody,
  formatExplicitEmailBody,
  enforceEmailRequestConstraints,
} = require('../src/planner');

assert.strictEqual(hasExplicitAttachmentRequest("mail friend@example.com about thirukumaran's bday celebration"), false);
assert.strictEqual(hasExplicitAttachmentRequest('mail friend@example.com and attach resume.pdf'), true);
assert.deepStrictEqual(extractExplicitAttachments('attach SREERISHI_RESUME and mail to friend@example.com'), ['SREERISHI_RESUME']);
assert.deepStrictEqual(extractExplicitAttachments("mail friend@example.com about thirukumaran's bday celebration"), []);
assert.strictEqual(extractExplicitEmailBody('mail friend@example.com and genrate the body as, am inviting you to my dear friend thirukumaran\'s bday celebration'), "am inviting you to my dear friend thirukumaran's bday celebration");
assert(formatExplicitEmailBody("am inviting you to my dear friend thirukumaran's bday celebration").includes("thirukumaran's bday celebration"));
const constrainedDraft = enforceEmailRequestConstraints({
  type: 'send_email',
  to: ['friend@example.com'],
  subject: 'Birthday Celebration',
  body: 'And genrate the body as, am inviting you to my dear friend thirukumaran\'s bday celebration',
  attachments: ['s bday celebration']
}, 'mail friend@example.com and genrate the body as, am inviting you to my dear friend thirukumaran\'s bday celebration');
assert.deepStrictEqual(constrainedDraft.attachments, []);
assert(!/genrate the body as/i.test(constrainedDraft.body));
assert(constrainedDraft.body.includes("thirukumaran's bday celebration"));
const attachmentDraft = enforceEmailRequestConstraints({
  type: 'send_email',
  to: ['friend@example.com'],
  subject: 'Updated Resume',
  body: 'Please find my updated resume attached.',
  attachments: []
}, 'attach SREERISHI_RESUME and mail to friend@example.com and the body as updated resume');
assert.deepStrictEqual(attachmentDraft.attachments, ['SREERISHI_RESUME']);
console.log('Planner email intent guard tests passed.');

(async () => {
  const plan = await buildPlan('SHOW ME THE TASK HISTORY', 'C:\\dummy');
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, 'show_task_history');
  console.log('Planner task history tests passed.');

  const capPlan = await buildPlan('what can  yu do', 'C:\\dummy');
  assert.equal(capPlan.actions.length, 0);
  assert(capPlan.reply.includes('File Operations'));
  assert.equal(capPlan.planner, 'deterministic:capabilities');
  console.log('Planner capability plan tests passed.');

  // Test external drive path extraction & restriction
  const { checkPlan } = require('../src/permission-manager');
  const extPlan1 = await buildPlan('D:\\IPHONE 16\\CLG open rhis', 'C:\\dummy');
  assert.equal(extPlan1.actions.length, 1);
  assert.equal(extPlan1.actions[0].type, 'open');
  assert.equal(extPlan1.actions[0].path, 'D:\\IPHONE 16\\CLG');
  const perm1 = checkPlan(extPlan1, 'C:\\dummy');
  assert.strictEqual(perm1.allowed, false, 'External path must be disallowed');
  assert.ok(perm1.reasons.some(r => r.includes('outside the Documents safe area')));
  console.log('External path D:\\IPHONE 16\\CLG open rhis blocked as restricted access test passed.');

  const extPlan2 = await buildPlan('open D:\\IPHONE 16\\CLG', 'C:\\dummy');
  assert.equal(extPlan2.actions.length, 1);
  assert.equal(extPlan2.actions[0].type, 'open');
  assert.equal(extPlan2.actions[0].path, 'D:\\IPHONE 16\\CLG');
  const perm2 = checkPlan(extPlan2, 'C:\\dummy');
  assert.strictEqual(perm2.allowed, false);
  console.log('External path open D:\\IPHONE 16\\CLG blocked as restricted access test passed.');

  // Test suspended session graceful handling
  const fakeSuspendedMgr = {
    getState: () => 'SUSPENDED',
    sessionClosed: false
  };
  const suspendedPlan = await buildPlan('list files', 'C:\\dummy', fakeSuspendedMgr);
  assert.equal(suspendedPlan.summary, 'Session Suspended');
  assert.ok(suspendedPlan.reply.includes('currently suspended'));
  console.log('Suspended session graceful reply test passed.');
})();

