const form = document.getElementById('login-form');
const errorEl = document.getElementById('login-error');
const submitButton = form.querySelector('button[type="submit"]');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.hidden = true;
  submitButton.disabled = true;
  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: form.password.value }),
    });
    if (res.ok) {
      location.href = '/';
      return;
    }
    const data = await res.json().catch(() => ({}));
    errorEl.textContent = data.error || `ログインに失敗しました (HTTP ${res.status})`;
  } catch {
    errorEl.textContent = 'サーバーに接続できません';
  } finally {
    submitButton.disabled = false;
  }
  errorEl.hidden = false;
  form.password.select();
});
