/* Tokens are held only by the WordPress server. */
(() => {
  const status = document.getElementById('frameleaf-status');
  const request = async (method, data) => {
    const result = await wp.apiFetch({ path: '/frameleaf-connect/v1/connection', method, data });
    if (result.authorizeUrl) window.location.assign(result.authorizeUrl);
    else status.textContent = result.state === 'active' ? frameleafConnect.connected : result.state === 'disconnected' ? frameleafConnect.disconnected : frameleafConnect.reconnect;
  };
  const run = (method, data) => request(method, data).catch(() => { status.textContent = frameleafConnect.failed; });
  document.getElementById('frameleaf-connect').addEventListener('click', () => run('POST', { origin: document.getElementById('frameleaf-origin').value }));
  document.getElementById('frameleaf-disconnect').addEventListener('click', () => run('DELETE'));
  document.getElementById('frameleaf-reset').addEventListener('click', () => {
    if (!document.getElementById('frameleaf-revoked').checked) { document.getElementById('frameleaf-revoked').focus(); return; }
    run('POST', { resetAfterKeyChange: true, revokedInFrameleaf: true });
  });
  run('GET');
})();
