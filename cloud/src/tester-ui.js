const $ = id => document.getElementById(id);
const message = text => { $('message').textContent = text; };
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
const invite = location.pathname === '/invite';
let token = invite ? location.hash.slice(1) : '';
if (invite) history.replaceState(null, '', '/invite');
if (invite || location.pathname === '/sign-in') {
  $('access').hidden = false;
  if (invite) {
    $('access-title').textContent = 'Accept your invitation';
    $('auth-button').textContent = 'Create invited account';
    $('auth').elements.email.required = false;
    $('auth').elements.email.closest('label').hidden = true;
    $('auth').elements.password.autocomplete = 'new-password';
    message('Choose a password. Then sign in with the email your invitation was issued to.');
  }
} else {
  $('workspace').hidden = false;
  refresh(true).catch(error => message(error.message));
  setInterval(() => refresh(false).catch(error => message(error.message)), 10000);
}
$('auth').onsubmit = async event => {
  event.preventDefault();
  try {
    const form = event.target.elements;
    if (invite) {
      await api('/api/redeem', { token, password: form.password.value });
      token = '';
      location.assign('/sign-in');
    } else {
      await api('/api/sign-in', { email: form.email.value, password: form.password.value });
      location.assign('/workspace');
    }
  } catch (error) { message(error.message); }
};
$('sign-out').onclick = async () => {
  try { await api('/api/sign-out', {}); location.assign('/sign-in'); }
  catch (error) { message(error.message); }
};
$('profile').onsubmit = async event => {
  event.preventDefault();
  const fields = event.target.elements;
  const profile = {};
  for (const name of ['name', 'email', 'phone', 'location', 'workAuthorization', 'submissionMode']) profile[name] = fields[name].value;
  for (const name of ['skills', 'roleFamilies', 'seniority', 'targetLocations', 'workModes']) profile[name] = fields[name].value.split(',').map(x => x.trim()).filter(Boolean);
  profile.yearsExperience = Number(fields.yearsExperience.value);
  if (fields.linkedin.value) profile.linkedin = fields.linkedin.value;
  const extras = {};
  for (const name of ['motivationBlurb', 'authorizedWithoutSponsorship', 'needsSponsorship', 'willingToRelocate']) extras[name] = fields[name].value;
  try {
    await api('/api/onboard', { profile, extras });
    const file = fields.resume.files[0];
    if (file) {
      const response = await fetch('/api/resume', { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: file });
      if (!response.ok) throw new Error((await response.json()).error);
    }
    message('Saved.');
    await refresh(false);
  } catch (error) { message(error.message); }
};
$('round').onsubmit = async event => {
  event.preventDefault();
  try { await api('/api/rounds', { count: Number(event.target.elements.count.value) }); message('Round queued.'); }
  catch (error) { message(error.message); }
};
async function refresh(populate) {
  const status = await api('/api/status');
  $('identity').textContent = `Signed in as ${status.email}. Résumé ${status.profile.resume ? 'saved' : 'needed'}.`;
  if (populate) for (const [key, value] of Object.entries({ ...status.profile.values, ...status.profile.extras })) {
    const input = $('profile').elements.namedItem(key);
    if (input && input.type !== 'file') input.value = Array.isArray(value) ? value.join(', ') : value ?? '';
  }
  for (const [id, entries] of [['applications', status.applications], ['ledger', status.ledger]]) {
    $(id).replaceChildren(...entries.map(item => {
      const li = document.createElement('li');
      li.textContent = `${item.company} · ${item.role} · ${item.status}`;
      return li;
    }));
    if (!entries.length) $(id).textContent = 'Nothing yet.';
  }
}
