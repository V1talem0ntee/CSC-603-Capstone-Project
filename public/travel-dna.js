const promptText = document.querySelector('#travel-dna-prompt');
const copyButton = document.querySelector('#copy-prompt');
const copyStatus = document.querySelector('#copy-status');

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(promptText.value);
  } catch {
    promptText.focus();
    promptText.select();
    if (!document.execCommand('copy')) {
      copyStatus.textContent = 'Copy was blocked. Select the prompt and copy it manually.';
      return;
    }
  }
  copyStatus.textContent = 'Prompt copied. Paste it into the AI that knows you best.';
  copyButton.textContent = 'Copied';
  setTimeout(() => { copyButton.textContent = 'Copy prompt'; }, 1800);
});
