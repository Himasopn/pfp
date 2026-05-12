/* ── State ──────────────────────────────────────────────────────────────── */
let sessionId = null;
let selectedFile = null;
let pendingMethod = null;   // 'qr' | 'pair'

/* ── Socket ─────────────────────────────────────────────────────────────── */
const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect', () => console.log('[socket] connected'));
socket.on('disconnect', () => console.log('[socket] disconnected'));

/* ── Socket events from server ───────────────────────────────────────────── */
socket.on('qr', ({ qr }) => {
  const img = document.getElementById('qrImage');
  const skeleton = document.getElementById('qrSkeleton');
  img.src = qr;
  img.style.display = 'block';
  skeleton.style.display = 'none';
  showStep('step-qr');
});

socket.on('pairing_code', ({ code }) => {
  const display = document.getElementById('codeDisplay');
  const val = document.getElementById('pairingCodeValue');
  val.textContent = code;
  display.classList.remove('hidden');

  // Stop the "generating..." spinner on button
  const btn = document.getElementById('getPairCodeBtn');
  btn.disabled = false;
  btn.textContent = 'Code Generated ✓';
  btn.style.background = 'var(--success)';
});

socket.on('status', ({ message }) => {
  const msg = document.getElementById('connectingMsg');
  if (msg) msg.textContent = message;
  showStep('step-connecting');
});

socket.on('connected', ({ message }) => {
  const msg = document.getElementById('connectingMsg');
  if (msg) msg.textContent = message || 'Setting your profile picture…';
  showStep('step-connecting');
});

socket.on('success', () => {
  showStep('step-success');
});

socket.on('error', ({ message }) => {
  document.getElementById('errorMsgBox').textContent = message || 'An unknown error occurred.';
  showStep('step-error');
});

/* ── Step navigation ─────────────────────────────────────────────────────── */
function showStep(id) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

/* ── File Upload ─────────────────────────────────────────────────────────── */
const fileInput    = document.getElementById('fileInput');
const uploadZone   = document.getElementById('uploadZone');
const previewWrap  = document.getElementById('previewWrap');
const previewImg   = document.getElementById('previewImg');
const placeholder  = document.getElementById('uploadPlaceholder');
const continueBtn  = document.getElementById('continueBtn');
const removeBtn    = document.getElementById('removeBtn');

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleFileSelect(file);
});

// Drag & drop
uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (file && file.type.startsWith('image/')) handleFileSelect(file);
});

function handleFileSelect(file) {
  if (file.size > 10 * 1024 * 1024) {
    alert('Image must be under 10 MB.');
    return;
  }
  selectedFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    previewImg.src = e.target.result;
    placeholder.style.display = 'none';
    previewWrap.classList.add('visible');
    fileInput.style.display = 'none';          // hide input so click doesn't re-open
    continueBtn.disabled = false;
  };
  reader.readAsDataURL(file);
}

removeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  selectedFile = null;
  previewImg.src = '';
  previewWrap.classList.remove('visible');
  placeholder.style.display = '';
  fileInput.style.display = '';
  fileInput.value = '';
  continueBtn.disabled = true;
});

/* ── Continue → upload image, go to method select ───────────────────────── */
continueBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  continueBtn.disabled = true;
  continueBtn.textContent = 'Uploading…';

  try {
    const formData = new FormData();
    formData.append('image', selectedFile);

    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Upload failed');

    sessionId = data.sessionId;
    showStep('step-method');
  } catch (err) {
    alert('Upload error: ' + err.message);
  } finally {
    continueBtn.disabled = false;
    continueBtn.textContent = 'Continue';
  }
});

/* ── Method selection ────────────────────────────────────────────────────── */
document.getElementById('qrMethodBtn').addEventListener('click', () => {
  pendingMethod = 'qr';
  // Reset QR display
  const img = document.getElementById('qrImage');
  const skel = document.getElementById('qrSkeleton');
  img.src = ''; img.style.display = 'none';
  skel.style.display = '';
  showStep('step-qr');
  startConnection('qr');
});

document.getElementById('pairMethodBtn').addEventListener('click', () => {
  pendingMethod = 'pair';
  // Reset pair UI
  document.getElementById('phoneInput').value = '';
  document.getElementById('codeDisplay').classList.add('hidden');
  document.getElementById('pairingCodeValue').textContent = '—';
  const btn = document.getElementById('getPairCodeBtn');
  btn.disabled = false;
  btn.textContent = 'Get Pairing Code';
  btn.style.background = '';
  showStep('step-pair');
});

/* ── Get pairing code ────────────────────────────────────────────────────── */
document.getElementById('getPairCodeBtn').addEventListener('click', async () => {
  const phone = document.getElementById('phoneInput').value.trim().replace(/[^0-9]/g, '');
  const country = document.getElementById('countrySelect').value;

  if (!phone) {
    shakeEl(document.getElementById('phoneInput'));
    return;
  }

  const fullPhone = country + phone;

  const btn = document.getElementById('getPairCodeBtn');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  await startConnection('pair', fullPhone);
});

/* ── Start connection (join room then call API) ──────────────────────────── */
function startConnection(method, phoneNumber = null) {
  return new Promise((resolve) => {
    if (!sessionId) {
      showStep('step-error');
      document.getElementById('errorMsgBox').textContent = 'Session lost. Please re-upload your image.';
      return resolve();
    }

    // Join socket room FIRST, then call API
    socket.emit('join', sessionId);

    socket.once('joined', async () => {
      try {
        const body = { sessionId, method };
        if (phoneNumber) body.phoneNumber = phoneNumber;

        const res = await fetch('/api/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || 'Connection failed');
      } catch (err) {
        document.getElementById('errorMsgBox').textContent = err.message;
        showStep('step-error');
      }
      resolve();
    });

    // Timeout if joined never fires
    setTimeout(() => resolve(), 5000);
  });
}

/* ── Back buttons ────────────────────────────────────────────────────────── */
document.querySelectorAll('.btn-back').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.back;
    if (target) showStep(target);
  });
});

/* ── Retry / Start over ──────────────────────────────────────────────────── */
document.getElementById('retryBtn').addEventListener('click', () => {
  if (pendingMethod === 'pair') {
    showStep('step-pair');
    const pairBtn = document.getElementById('getPairCodeBtn');
    pairBtn.disabled = false;
    pairBtn.textContent = 'Get Pairing Code';
    pairBtn.style.background = '';
    document.getElementById('codeDisplay').classList.add('hidden');
  } else {
    showStep('step-method');
  }
});

document.getElementById('startOverBtn').addEventListener('click', () => {
  // Full reset
  sessionId = null;
  selectedFile = null;
  pendingMethod = null;
  previewImg.src = '';
  previewWrap.classList.remove('visible');
  placeholder.style.display = '';
  fileInput.style.display = '';
  fileInput.value = '';
  continueBtn.disabled = true;
  continueBtn.textContent = 'Continue';
  showStep('step-upload');
});

/* ── Utility: shake animation for invalid input ──────────────────────────── */
function shakeEl(el) {
  el.style.animation = 'none';
  el.getBoundingClientRect(); // reflow
  el.style.animation = 'shake 0.4s ease';
  el.addEventListener('animationend', () => { el.style.animation = ''; }, { once: true });
}

// Inject shake keyframes
const style = document.createElement('style');
style.textContent = `
  @keyframes shake {
    0%,100% { transform: translateX(0); }
    20% { transform: translateX(-6px); }
    40% { transform: translateX(6px); }
    60% { transform: translateX(-4px); }
    80% { transform: translateX(4px); }
  }
`;
document.head.appendChild(style);
