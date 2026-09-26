const prompt = document.querySelector('#prompt');
const planButton = document.querySelector('#planButton');
const status = document.querySelector('#status');
const review = document.querySelector('#review');
const result = document.querySelector('#result');
let currentPlan;

function describe(action) {
  const label = (value) => value === '.' ? 'Documents' : value;
  const text = { create_folder: `Create folder “${label(action.path)}”`, create_file: `Create file “${label(action.path)}”`, rename: `Rename “${label(action.path)}” to “${label(action.destination)}”`, move: `Move “${label(action.path)}” to “${label(action.destination)}”`, delete: `Move “${label(action.path)}” to the Recycle Bin`, open: `Open “${label(action.path)}”`, send_email: `Send email to ${action.to?.join(', ')} — ${action.subject}${action.attachments?.length ? ` (attachments: ${action.attachments.map(label).join(', ')})` : ''}` };
  return text[action.type] || action.type;
}

planButton.addEventListener('click', async () => {
  planButton.disabled = true; review.hidden = true; result.hidden = true; status.textContent = 'Creating a local plan…';
  try {
    const data = await window.agent.plan(prompt.value);
    currentPlan = data.plan;
    document.querySelector('#safeRoot').textContent = data.documentsRoot;
    document.querySelector('#summary').textContent = data.plan.summary;
    document.querySelector('#plannerBadge').textContent = data.plan.planner;
    const permission = document.querySelector('#permission');
    permission.className = data.permission.allowed ? 'allowed' : 'blocked';
    permission.textContent = data.permission.allowed ? 'Permission manager: approved for review' : `Blocked: ${data.permission.reasons.join(' ')}`;
    document.querySelector('#actions').replaceChildren(...data.plan.actions.map((action) => { const item = document.createElement('li'); item.textContent = describe(action); return item; }));
    document.querySelector('#executeButton').disabled = !data.permission.allowed;
    review.hidden = false; status.textContent = data.permission.allowed ? 'Review the proposed actions and confirm only if they are correct.' : 'No action can be executed.';
  } catch (error) { status.textContent = `Could not create a plan: ${error.message}`; }
  finally { planButton.disabled = false; }
});

document.querySelector('#cancelButton').addEventListener('click', () => { review.hidden = true; currentPlan = undefined; status.textContent = 'Plan cancelled. Nothing was changed.'; });
document.querySelector('#executeButton').addEventListener('click', async () => {
  if (!currentPlan || !confirm('Execute these reviewed actions now?')) return;
  document.querySelector('#executeButton').disabled = true; status.textContent = 'Executing approved actions…';
  try { const entries = await window.agent.execute(currentPlan); document.querySelector('#results').replaceChildren(...entries.map((entry) => { const item = document.createElement('li'); item.textContent = entry; return item; })); result.hidden = false; review.hidden = true; status.textContent = 'Done.'; } catch (error) { status.textContent = `Execution stopped: ${error.message}`; document.querySelector('#executeButton').disabled = false; }
});
