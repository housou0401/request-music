let audioContext = null;
let gainNode = null;
let previewAudio = null;

function initPreview() {
  if (!previewAudio) {
    previewAudio = document.createElement("audio");
    previewAudio.style.display = "none";
    previewAudio.muted = true;
    document.body.appendChild(previewAudio);
    if (window.AudioContext || window.webkitAudioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioContext.createMediaElementSource(previewAudio);
      gainNode = audioContext.createGain();
      src.connect(gainNode).connect(audioContext.destination);
    }
  }
}

function playPreview(url) {
  initPreview();
  previewAudio.src = url;
  previewAudio.load();
  previewAudio.onloadedmetadata = () => {
    previewAudio.currentTime = previewAudio.duration > 15 ? 15 : 0;
    previewAudio.play().then(() => { previewAudio.muted = false; }).catch(console.error);
  };
  previewAudio.loop = true;
}

function setPreviewVolume(pct) {
  const v = pct / 100;
  if (gainNode) gainNode.gain.value = v;
  else previewAudio.volume = v;
}

function pausePreview() {
  previewAudio?.pause();
}

function mutePreview(flag) {
  previewAudio.muted = flag;
}
