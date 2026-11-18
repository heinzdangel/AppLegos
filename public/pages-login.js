const form = document.querySelector('#pages-login');
const notice = document.querySelector('#login-error');

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

if (!window.opener) {
  form.hidden = true;
  notice.textContent = 'Abre el acceso desde la página de tu inventario.';
  notice.hidden = false;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = form.querySelector('button');
  submit.disabled = true;
  notice.hidden = true;
  try {
    await post('/api/login', { password: new FormData(form).get('password') });
    const { origin, token } = await post('/api/pages-session', {});
    window.opener.postMessage({ type: 'inventario-lego:session', token }, origin);
    window.close();
  } catch (error) {
    notice.textContent = error.message;
    notice.hidden = false;
  } finally {
    submit.disabled = false;
  }
});
