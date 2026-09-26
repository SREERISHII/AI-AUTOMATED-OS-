const assert = require('assert');
const path = require('path');
const { checkPlan } = require('../src/permission-manager');
const { normalizeDocumentsPath } = require('../src/planner');
const root = path.resolve('C:/Users/test/Documents');

assert.equal(checkPlan({ actions: [{ type: 'create_file', path: 'notes/todo.txt', content: 'Hi' }] }, root).allowed, true);
const listPermission = checkPlan({ actions: [{ type: 'list_directory', path: '.', startsWith: 's' }] }, root);
assert.equal(listPermission.allowed, true);
assert.equal(listPermission.requiresConfirmation, false);
assert.equal(checkPlan({ actions: [{ type: 'delete', path: '../../Windows/System32/a.dll' }] }, root).allowed, false);
assert.equal(checkPlan({ actions: [{ type: 'open', path: 'C:/Windows/notepad.exe' }] }, root).allowed, false);
assert.equal(checkPlan({ actions: [{ type: 'send_email', to: ['user@example.com'], subject: 'Hello', body: 'Hi', attachments: ['invoice.pdf'] }] }, root).allowed, true);
assert.equal(checkPlan({ actions: [{ type: 'send_email', to: ['user@example.com'], subject: 'Hello', body: 'Hi', attachments: ['.env'] }] }, root).allowed, false);
const searchPermission = checkPlan({ actions: [{ type: 'search_files', path: '.', query: 'invoice' }] }, root);
assert.equal(searchPermission.allowed, true);
assert.equal(searchPermission.requiresConfirmation, false);
assert.equal(normalizeDocumentsPath('Documents'), '.');
assert.equal(normalizeDocumentsPath('Documents/invoice.pdf'), 'invoice.pdf');
console.log('Permission-manager tests passed.');

