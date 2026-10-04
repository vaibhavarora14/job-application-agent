const $ = id => document.getElementById(id);
const message = text => { $('message').textContent = text; };
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
const joining = location.pathname === '/join';
if (joining || location.pathname === '/sign-in') {
  $('access').hidden = false;
  if (joining) {
    $('access-title').textContent = 'Join the first 25 testers';
    $('auth-button').textContent = 'Create account';
    $('auth').elements.password.autocomplete = 'new-password';
    message('The first 25 completed sign-ups get a workspace. Choose your email and password, then sign in.');
    $('auth-button').disabled = true;
    api('/api/join').then(status => {
      if (status.open) $('auth-button').disabled = false;
      else { $('auth').hidden = true; message(status.closedMessage); }
    }).catch(error => message(error.message));
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
    if (joining) {
      await api('/api/join', { email: form.email.value, password: form.password.value });
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
