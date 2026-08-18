// ============================================================
// 1. LOCK OVERLAY (Unlock logic)
// ============================================================
(function() {
  const WHATSAPP_CHANNEL_LINK = "https://whatsapp.com/channel/0029Vb7ISSJDeON39wZx6s2M";

  const lockOverlay = document.getElementById('lockOverlay');
  const body = document.body;
  const followStepBtn = document.getElementById('followStepBtn');
  const followCheck = document.getElementById('followCheck');
  const followBtnLabel = document.getElementById('followBtnLabel');
  const alreadyFollowBtn = document.getElementById('alreadyFollowBtn');

  let followDone = false;

  function unlock() {
    lockOverlay.classList.add('unlocked');
    body.classList.remove('is-locked');
    setTimeout(() => { lockOverlay.style.display = 'none'; }, 500);
  }

  function tryUnlock() {
    if (followDone) {
      unlock();
    }
  }

  followStepBtn.addEventListener('click', function() {
    window.open(WHATSAPP_CHANNEL_LINK, '_blank');
    followDone = true;
    followStepBtn.classList.add('done');
    followCheck.textContent = '✓';
    followBtnLabel.textContent = 'Saya sudah mengikuti';
    tryUnlock();
  });

  alreadyFollowBtn.addEventListener('click', function() {
    alreadyFollowBtn.classList.add('done');
    unlock();
  });
})();

// ============================================================
// 2. APP LOGIC (Preview, Upload, Download)
// ============================================================
(function() {
  // --- DOM refs ---
  const nameInput = document.getElementById('nameInput');
  const jamInput = document.getElementById('jamInput');
  const minInput = document.getElementById('minInput');
  const detikInput = document.getElementById('detikInput');
  const photoInput = document.getElementById('photoInput');
  const photoUploadBtn = document.getElementById('photoUploadBtn');

  const nameLabel = document.getElementById('nameLabel');
  const durLabel = document.getElementById('durLabel');
  const avatarContainer = document.getElementById('avatarContainer');
  const avatarPlaceholder = document.getElementById('avatarPlaceholder');
  const photoPreview = document.getElementById('photoPreview');
  const photoPlaceholder = document.getElementById('photoPlaceholder');

  const previewBtn = document.getElementById('previewBtn');
  const previewWrapper = document.getElementById('previewWrapper');
  const downloadBtn = document.getElementById('downloadBtn');

  // --- helpers ---
  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function updateDisplay() {
    nameLabel.textContent = nameInput.value || 'Nama Kontak';

    const j = Math.max(0, Math.min(99, parseInt(jamInput.value) || 0));
    const m = Math.max(0, Math.min(59, parseInt(minInput.value) || 0));
    const d = Math.max(0, Math.min(59, parseInt(detikInput.value) || 0));

    durLabel.textContent = pad(j) + ':' + pad(m) + ':' + pad(d);
  }

  function updateAvatar(src) {
    if (src) {
      avatarContainer.style.backgroundImage = 'url(' + src + ')';
      avatarContainer.style.backgroundColor = 'transparent';
      avatarPlaceholder.style.display = 'none';

      photoPreview.src = src;
      photoPreview.style.display = 'block';
      photoPlaceholder.style.display = 'none';
    } else {
      avatarContainer.style.backgroundImage = 'none';
      avatarContainer.style.backgroundColor = '#1f3a3a';
      avatarPlaceholder.style.display = 'flex';

      photoPreview.style.display = 'none';
      photoPlaceholder.style.display = 'flex';
    }
  }

  // --- event listeners ---
  [nameInput, jamInput, minInput, detikInput].forEach(el => el.addEventListener('input', updateDisplay));

  photoUploadBtn.addEventListener('click', function(e) {
    e.preventDefault();
    photoInput.click();
  });

  photoInput.addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(ev) {
      updateAvatar(ev.target.result);
    };
    reader.readAsDataURL(file);
  });

  previewBtn.addEventListener('click', function() {
    updateDisplay();
    previewWrapper.classList.add('show');
    previewBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 6L9 17l-5-5" />
      </svg>
      Preview Ditampilkan
    `;
    setTimeout(() => {
      previewWrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  });

  // --- download ---
  downloadBtn.addEventListener('click', function() {
    const target = document.getElementById('captureTarget');
    downloadBtn.disabled = true;
    downloadBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4l2 2" />
      </svg>
      Memproses...
    `;

    setTimeout(() => {
      html2canvas(target, {
        scale: 2.5,
        backgroundColor: null,
        useCORS: true,
        allowTaint: true,
        logging: false,
      }).then(function(canvas) {
        const link = document.createElement('a');
        link.download = 'call-screen.png';
        link.href = canvas.toDataURL('image/png');
        link.click();
        downloadBtn.disabled = false;
        downloadBtn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Unduh Gambar
        `;
      }).catch(function(err) {
        console.warn('Gagal mengunduh:', err);
        downloadBtn.disabled = false;
        downloadBtn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Unduh Gambar
        `;
        alert('Gagal membuat gambar. Pastikan gambar latar sudah dimuat sepenuhnya, lalu coba lagi.');
      });
    }, 300);
  });

  // --- init ---
  updateDisplay();
})();