document.getElementById('allow').onclick = async () => {
  const msg = document.getElementById('msg');
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
    msg.className = 'note';
    msg.textContent = 'Done — microphone allowed. You can close this tab.';
    document.getElementById('allow').hidden = true;
  } catch (e) {
    msg.className = 'note err';
    msg.textContent = e.name === 'NotAllowedError'
      ? 'Blocked. Click the icon at the left of the address bar, set Microphone to Allow, then try again.'
      : `Could not open the microphone: ${e.message || e.name}`;
  }
};
