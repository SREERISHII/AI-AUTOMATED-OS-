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
})();

