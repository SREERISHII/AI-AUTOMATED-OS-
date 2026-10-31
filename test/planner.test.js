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

(async () => {
  const plan = await buildPlan('SHOW ME THE TASK HISTORY', 'C:\\dummy');
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, 'show_task_history');
  console.log('Planner task history tests passed.');
})();
