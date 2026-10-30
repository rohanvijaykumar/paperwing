(() => {
  const form = document.querySelector('#print-controls');
  const select = document.querySelector('#printer');
  const status = document.querySelector('#status');
  let submitting = false;
  window.printPreview
    .settings()
    .then((settings) => {
      for (const printer of settings.printers) {
        const option = document.createElement('option');
        option.value = printer.name;
        option.textContent = printer.displayName || printer.name;
        select.append(option);
      }
      select.value = settings.selected;
      status.textContent = settings.printers.length
        ? `${settings.printers.length} installed printers · ${settings.pages} page${settings.pages === 1 ? '' : 's'}`
        : 'No installed printers found.';
      document.querySelector('#print').disabled = !settings.printers.length;
      document.querySelector('#advanced').disabled = !settings.printers.length;
    })
    .catch((error) => {
      status.textContent = String(error);
    });
  async function submit(advanced = false, savePdf = false) {
    if (submitting) return;
    submitting = true;
    for (const field of form.elements) field.disabled = true;
    status.textContent = advanced
      ? 'Opening Windows print settings…'
      : 'Sending print job…';
    try {
      const result = await window.printPreview.submit({
        printer: select.value,
        copies: Number(document.querySelector('#copies').value),
        color: document.querySelector('#color').value === 'color',
        duplex: document.querySelector('#duplex').value,
        advanced,
        savePdf,
      });
      if (!result.success)
        status.textContent =
          result.reason || 'Printing did not complete. Please try again.';
    } catch (error) {
      status.textContent = String(error);
    } finally {
      submitting = false;
      for (const field of form.elements) field.disabled = false;
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  document
    .querySelector('#save-pdf')
    .addEventListener('click', () => submit(false, true));
  document
    .querySelector('#advanced')
    .addEventListener('click', () => submit(true));
  document
    .querySelector('#cancel')
    .addEventListener('click', () => window.printPreview.cancel());
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !submitting) window.printPreview.cancel();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      submit();
    }
  });
})();
