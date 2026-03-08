/**
 * DirectSend - Main Application Logic
 * Wires together the UI, peer management, and transfer engine.
 */

// ─── State ──────────────────────────────────────────────────────
let currentRoom = null;
let currentRoomPassword = '';
let lanTurboEnabled = false;
let lastNetworkPath = null;
let encryptionPassword = null;
let qrScanStream = null;
let qrScanDetector = null;
let qrScanActive = false;
let qrScanRafId = null;
let qrScanCanvas = null;
let qrScanCtx = null;

// ─── Initialization ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  lanTurboEnabled = localStorage.getItem('ds_lan_turbo') === '1';
  updateLanTurboUI();

  // Check if URL has a room path
  const pathMatch = location.pathname.match(/^\/room\/([A-Z0-9]+)$/i);
  if (pathMatch) {
    joinRoom(pathMatch[1].toUpperCase());
  }

  setupDragAndDrop();
  setupFileInput();
  setupTransferCallbacks();
  setupPeerCallbacks();
});

// ─── Navigation ─────────────────────────────────────────────────

function navigateHome() {
  showView('home-view');
  if (peerManager.ws) {
    peerManager.disconnect();
  }
  currentRoom = null;
  currentRoomPassword = '';
  lastNetworkPath = null;
  history.pushState(null, '', '/');
}

function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');
}

function toggleLanTurboMode() {
  lanTurboEnabled = !lanTurboEnabled;
  localStorage.setItem('ds_lan_turbo', lanTurboEnabled ? '1' : '0');
  updateLanTurboUI();

  if (currentRoom) {
    showToast(`LAN Turbo ${lanTurboEnabled ? 'enabled' : 'disabled'} — reconnecting...`, 'info');
    peerManager.disconnect();
    updateConnectionStatus('connecting');
    peerManager.connect(currentRoom, currentRoomPassword, { lanTurboEnabled });
  }
}

function updateLanTurboUI() {
  const button = document.getElementById('lan-turbo-btn');
  if (!button) return;

  button.classList.toggle('active', lanTurboEnabled);
  button.title = lanTurboEnabled ? 'LAN Turbo: On' : 'LAN Turbo: Off';
}

function updateNetworkPath(path) {
  const label = document.getElementById('network-path-label');
  if (!label) return;

  const normalizedPath = ['lan-direct', 'relay', 'direct'].includes(path) ? path : 'auto';

  if (lastNetworkPath !== normalizedPath) {
    if (normalizedPath === 'lan-direct') {
      showToast('LAN Direct path active ⚡', 'success');
    } else if (normalizedPath === 'relay') {
      showToast('Using relay path (internet route)', 'info');
    } else if (normalizedPath === 'direct') {
      showToast('Direct path active', 'success');
    }
    lastNetworkPath = normalizedPath;
  }

  if (path === 'lan-direct') {
    label.textContent = 'Path: LAN Direct';
    return;
  }
  if (path === 'relay') {
    label.textContent = 'Path: Relay';
    return;
  }
  if (path === 'direct') {
    label.textContent = 'Path: Direct';
    return;
  }
  label.textContent = 'Path: Auto';
}

// ─── Room Management ────────────────────────────────────────────

async function createRoom() {
  try {
    const passwordInput = window.prompt('Optional: Set a room password (leave empty for public room):', '');
    const roomPassword = (passwordInput || '').trim();
    const qs = roomPassword ? `?password=${encodeURIComponent(roomPassword)}` : '';
    const res = await fetch(`/api/create-room${qs}`);
    const data = await res.json();
    joinRoom(data.roomId, roomPassword);
  } catch (e) {
    showToast('Failed to create room', 'error');
  }
}

function showJoinDialog() {
  const dialog = document.getElementById('join-dialog');
  dialog.classList.toggle('hidden');
  if (!dialog.classList.contains('hidden')) {
    document.getElementById('join-room-input').focus();
  }
}

async function openQRScannerModal() {
  const modal = document.getElementById('qr-scan-modal');
  const video = document.getElementById('qr-scan-video');
  const status = document.getElementById('qr-scan-status');

  if (!modal || !video || !status) {
    showToast('QR scanner UI missing', 'error');
    return;
  }

  modal.classList.remove('hidden');
  status.textContent = 'Opening camera...';

  const hasNativeDetector = 'BarcodeDetector' in window;
  const hasJsQrFallback = typeof window.jsQR === 'function';

  if (!hasNativeDetector && !hasJsQrFallback) {
    status.textContent = 'QR scan not supported on this browser. Enter room code manually.';
    return;
  }

  try {
    if (hasNativeDetector && !qrScanDetector) {
      qrScanDetector = new BarcodeDetector({ formats: ['qr_code'] });
    }

    if (!qrScanCanvas) {
      qrScanCanvas = document.createElement('canvas');
      qrScanCtx = qrScanCanvas.getContext('2d', { willReadFrequently: true });
    }

    qrScanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });

    video.srcObject = qrScanStream;
    await video.play();
    qrScanActive = true;
    status.textContent = 'Point camera at a DirectSend QR code';
    _runQrScanLoop();
  } catch (error) {
    status.textContent = 'Camera permission denied or unavailable';
    showToast('Unable to access camera', 'error');
  }
}

function closeQRScannerModal() {
  const modal = document.getElementById('qr-scan-modal');
  const video = document.getElementById('qr-scan-video');

  qrScanActive = false;

  if (qrScanRafId) {
    cancelAnimationFrame(qrScanRafId);
    qrScanRafId = null;
  }

  if (qrScanStream) {
    for (const track of qrScanStream.getTracks()) {
      track.stop();
    }
    qrScanStream = null;
  }

  if (video) {
    video.srcObject = null;
  }

  if (modal) {
    modal.classList.add('hidden');
  }
}

async function _runQrScanLoop() {
  if (!qrScanActive) {
    return;
  }

  const video = document.getElementById('qr-scan-video');
  const status = document.getElementById('qr-scan-status');

  try {
    if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      let scannedValue = '';

      if (qrScanDetector) {
        const barcodes = await qrScanDetector.detect(video);
        if (barcodes.length > 0) {
          scannedValue = String(barcodes[0].rawValue || '').trim();
        }
      } else if (typeof window.jsQR === 'function' && qrScanCanvas && qrScanCtx) {
        const frameW = video.videoWidth;
        const frameH = video.videoHeight;
        if (frameW > 0 && frameH > 0) {
          qrScanCanvas.width = frameW;
          qrScanCanvas.height = frameH;
          qrScanCtx.drawImage(video, 0, 0, frameW, frameH);
          const imageData = qrScanCtx.getImageData(0, 0, frameW, frameH);
          const code = window.jsQR(imageData.data, frameW, frameH, { inversionAttempts: 'dontInvert' });
          if (code?.data) {
            scannedValue = String(code.data).trim();
          }
        }
      }

      if (scannedValue) {
        const roomId = _extractRoomIdFromQrValue(scannedValue);

        if (roomId) {
          if (status) {
            status.textContent = `Found room ${roomId}, joining...`;
          }
          closeQRScannerModal();
          joinRoom(roomId);
          return;
        }

        if (status) {
          status.textContent = 'Invalid QR code for DirectSend room';
        }
      }
    }
  } catch {
    if (status) {
      status.textContent = 'Scanning...';
    }
  }

  qrScanRafId = requestAnimationFrame(_runQrScanLoop);
}

function _extractRoomIdFromQrValue(value) {
  const directCode = value.match(/^[A-Z0-9]{4,12}$/i);
  if (directCode) {
    return directCode[0].toUpperCase();
  }

  try {
    const url = new URL(value);
    const pathMatch = url.pathname.match(/^\/room\/([A-Z0-9]+)$/i);
    if (pathMatch) {
      return pathMatch[1].toUpperCase();
    }
  } catch {
    return null;
  }

  return null;
}

function joinRoomFromInput() {
  const input = document.getElementById('join-room-input');
  const roomId = input.value.trim().toUpperCase();
  if (roomId.length >= 4) {
    const passwordInput = window.prompt('Enter room password (leave empty if none):', '');
    joinRoom(roomId, (passwordInput || '').trim());
  } else {
    showToast('Enter a valid room code', 'error');
  }
}

// Handle Enter key in join input
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.activeElement.id === 'join-room-input') {
    joinRoomFromInput();
  }

  if (e.key === 'Escape') {
    const scanModal = document.getElementById('qr-scan-modal');
    if (scanModal && !scanModal.classList.contains('hidden')) {
      closeQRScannerModal();
    }
  }
});

async function joinRoom(roomId, roomPassword = '') {
  currentRoom = roomId;
  currentRoomPassword = typeof roomPassword === 'string' ? roomPassword : '';
  lastNetworkPath = null;

  // Update UI
  document.getElementById('room-code').textContent = roomId;
  showView('room-view');
  history.pushState(null, '', `/room/${roomId}`);

  // Update connection status
  updateConnectionStatus('connecting');

  // Connect to signaling server
  peerManager.connect(roomId, currentRoomPassword, { lanTurboEnabled });

  showToast(`Joined room ${roomId}`, 'success');
}

// ─── Peer Callbacks ─────────────────────────────────────────────

function setupPeerCallbacks() {
  peerManager.onConnectionStateChange = (state) => {
    updateConnectionStatus(state);
  };

  peerManager.onJoinError = (error) => {
    if (error?.code === 'INVALID_ROOM_PASSWORD') {
      const nextPassword = window.prompt('Wrong room password. Please enter the correct password:', '');
      if (nextPassword === null) {
        showToast('Join cancelled', 'info');
        navigateHome();
        return;
      }
      showToast('Retrying with new password...', 'info');
      joinRoom(currentRoom, (nextPassword || '').trim());
      return;
    }

    showToast(error?.message || 'Failed to join room', 'error');
    navigateHome();
  };

  peerManager.onPeerConnected = (peerId) => {
    updatePeersList();
    showToast('A device connected!', 'success');
  };

  peerManager.onNetworkPathChange = (_peerId, path) => {
    updateNetworkPath(path);
  };

  peerManager.onPeerDisconnected = (peerId) => {
    updatePeersList();
    showToast('A device disconnected', 'info');
  };
}

function updateConnectionStatus(state) {
  const dot = document.getElementById('connection-status');
  const text = document.getElementById('connection-text');

  dot.className = 'status-dot';
  switch (state) {
    case 'connected':
      dot.classList.add('connected');
      text.textContent = 'Connected';
      break;
    case 'disconnected':
      dot.classList.add('disconnected');
      text.textContent = 'Reconnecting...';
      break;
    default:
      text.textContent = 'Connecting...';
  }
}

function updatePeersList() {
  const peers = peerManager.getConnectedPeers();
  const container = document.getElementById('peers-list');
  const countBadge = document.getElementById('peer-count');

  countBadge.textContent = peers.length;

  if (peers.length === 0) {
    container.innerHTML = `
      <div class="no-peers">
        <p>Waiting for others to join...</p>
        <p class="hint">Share the room link or QR code</p>
      </div>
    `;
    return;
  }

  container.innerHTML = peers.map((peerId, i) => `
    <div class="peer-chip">
      <span class="peer-dot"></span>
      Device ${i + 1}
      <span style="font-size: 0.7rem; color: var(--text-muted)">${peerId.substr(0, 8)}</span>
    </div>
  `).join('');
}

// ─── Copy & QR ──────────────────────────────────────────────────

async function copyRoomLink() {
  const url = `${location.origin}/room/${currentRoom}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast('Room link copied!', 'success');
  } catch {
    // Fallback
    const input = document.createElement('input');
    input.value = url;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
    showToast('Room link copied!', 'success');
  }
}

async function showQRCode() {
  const modal = document.getElementById('qr-modal');
  const img = document.getElementById('qr-image');
  const urlEl = document.getElementById('qr-url');

  try {
    const res = await fetch(`/api/qr/${currentRoom}`);
    const data = await res.json();
    img.src = data.qr;
    urlEl.textContent = data.url;
    modal.classList.remove('hidden');
  } catch {
    showToast('Failed to generate QR code', 'error');
  }
}

function closeQRModal() {
  document.getElementById('qr-modal').classList.add('hidden');
}

// Close modal on backdrop click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal')) {
    if (e.target.id === 'qr-scan-modal') {
      closeQRScannerModal();
    } else {
      e.target.classList.add('hidden');
    }
  }
});

// ─── Drag & Drop ────────────────────────────────────────────────

function setupDragAndDrop() {
  const dropZone = document.getElementById('drop-zone');

  ['dragenter', 'dragover'].forEach(event => {
    dropZone.addEventListener(event, (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach(event => {
    dropZone.addEventListener(event, (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFiles(files);
    }
  });

  // Prevent default drag behavior on the whole page
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
}

function setupFileInput() {
  document.getElementById('file-input').addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFiles(e.target.files);
      e.target.value = ''; // Reset
    }
  });
}

// ─── File Handling ──────────────────────────────────────────────

async function handleFiles(fileList) {
  const peers = peerManager.getConnectedPeers();
  if (peers.length === 0) {
    showToast('No devices connected. Share the room link first!', 'error');
    return;
  }

  for (const file of fileList) {
    try {
      const transferId = await transferEngine.sendFile(file);
      addTransferUI(transferId, {
        fileName: file.name,
        fileSize: file.size,
        direction: 'outgoing'
      });
    } catch (e) {
      showToast(`Failed to send ${file.name}: ${e.message}`, 'error');
    }
  }
}

// ─── Transfer Callbacks ─────────────────────────────────────────

function setupTransferCallbacks() {
  transferEngine.onTransferProgress = (transferId, progress) => {
    updateTransferUI(transferId, progress);
  };

  transferEngine.onTransferComplete = (transferId, info) => {
    if (info.direction === 'incoming') {
      addReceivedFileUI(transferId, info);
      showToast(`Received: ${info.fileName}`, 'success');
    } else {
      showToast(`Sent: ${info.fileName}`, 'success');
    }
    completeTransferUI(transferId);
  };

  transferEngine.onTransferError = (transferId, error) => {
    showToast(`Transfer error: ${error}`, 'error');
  };

  transferEngine.onIncomingFile = (transferId, meta) => {
    addTransferUI(transferId, {
      fileName: meta.fileName,
      fileSize: meta.fileSize,
      direction: 'incoming'
    });
    showToast(`Receiving: ${meta.fileName}`, 'info');
  };

  transferEngine.onTransferStateChange = (transferId, state) => {
    updateTransferStateUI(transferId, state);
  };
}

// ─── Transfer UI ────────────────────────────────────────────────

function addTransferUI(transferId, info) {
  const section = document.getElementById('transfers-section');
  section.classList.remove('hidden');

  const list = document.getElementById('transfers-list');
  const dirLabel = info.direction === 'outgoing' ? '↑ Sending' : '↓ Receiving';
  const dirColor = info.direction === 'outgoing' ? 'var(--accent)' : 'var(--success)';

  const el = document.createElement('div');
  el.className = 'transfer-item';
  el.id = `transfer-${transferId}`;
  el.innerHTML = `
    <div class="transfer-header">
      <span class="transfer-name" title="${escapeHtml(info.fileName)}">${escapeHtml(info.fileName)}</span>
      <span class="transfer-size">${formatSize(info.fileSize)}</span>
    </div>
    <div class="transfer-progress">
      <div class="progress-bar">
        <div class="progress-fill" id="progress-${transferId}" style="width: 0%"></div>
      </div>
    </div>
    <div class="transfer-stats">
      <span>
        <span style="color: ${dirColor}; font-weight: 600;">${dirLabel}</span>
        &nbsp;·&nbsp;
        <span id="speed-${transferId}">0 B/s</span>
        &nbsp;·&nbsp;
        <span id="eta-${transferId}">Calculating...</span>
        &nbsp;·&nbsp;
        <span id="percent-${transferId}">0%</span>
      </span>
      <span class="transfer-actions" id="actions-${transferId}">
        ${info.direction === 'outgoing' ? `
          <button class="btn-sm btn-pause" onclick="pauseTransfer('${transferId}')" id="pause-${transferId}">Pause</button>
          <button class="btn-sm btn-cancel" onclick="cancelTransfer('${transferId}')">Cancel</button>
        ` : ''}
      </span>
    </div>
  `;

  list.prepend(el);
}

function updateTransferUI(transferId, progress) {
  const fill = document.getElementById(`progress-${transferId}`);
  const speed = document.getElementById(`speed-${transferId}`);
  const eta = document.getElementById(`eta-${transferId}`);
  const percent = document.getElementById(`percent-${transferId}`);

  if (!fill) return;

  fill.style.width = `${progress.percent.toFixed(1)}%`;
  speed.textContent = `${formatSize(progress.speed)}/s`;
  eta.textContent = `ETA: ${formatETA(progress.eta)}`;
  percent.textContent = `${progress.percent.toFixed(1)}%`;
}

function completeTransferUI(transferId) {
  const fill = document.getElementById(`progress-${transferId}`);
  const speed = document.getElementById(`speed-${transferId}`);
  const eta = document.getElementById(`eta-${transferId}`);
  const percent = document.getElementById(`percent-${transferId}`);
  const actions = document.getElementById(`actions-${transferId}`);

  if (!fill) return;

  fill.style.width = '100%';
  fill.classList.add('complete');
  if (speed) speed.textContent = 'Complete';
  if (eta) eta.textContent = '';
  if (percent) percent.textContent = '100%';
  if (actions) actions.innerHTML = '<span style="color: var(--success); font-weight: 600;">✓ Done</span>';
}

function updateTransferStateUI(transferId, state) {
  const fill = document.getElementById(`progress-${transferId}`);
  const pauseBtn = document.getElementById(`pause-${transferId}`);

  if (fill) {
    fill.classList.remove('paused');
    if (state === 'paused') fill.classList.add('paused');
  }

  if (pauseBtn) {
    if (state === 'paused') {
      pauseBtn.className = 'btn-sm btn-resume';
      pauseBtn.textContent = 'Resume';
      pauseBtn.setAttribute('onclick', `resumeTransfer('${transferId}')`);
    } else if (state === 'sending') {
      pauseBtn.className = 'btn-sm btn-pause';
      pauseBtn.textContent = 'Pause';
      pauseBtn.setAttribute('onclick', `pauseTransfer('${transferId}')`);
    }
  }
}

// ─── Transfer Controls ──────────────────────────────────────────

function pauseTransfer(transferId) {
  transferEngine.pauseTransfer(transferId);
  showToast('Transfer paused', 'info');
}

function resumeTransfer(transferId) {
  transferEngine.resumeTransfer(transferId);
  showToast('Transfer resumed', 'info');
}

function cancelTransfer(transferId) {
  transferEngine.cancelTransfer(transferId);
  const el = document.getElementById(`transfer-${transferId}`);
  if (el) el.remove();
  showToast('Transfer cancelled', 'info');
}

// ─── Received Files UI ──────────────────────────────────────────

function addReceivedFileUI(transferId, info) {
  const section = document.getElementById('received-section');
  section.classList.remove('hidden');

  const list = document.getElementById('received-list');
  const el = document.createElement('div');
  el.className = 'received-item';
  el.innerHTML = `
    <div class="received-info">
      <div class="file-name" title="${escapeHtml(info.fileName)}">${escapeHtml(info.fileName)}</div>
      <div class="file-size">${formatSize(info.fileSize)}</div>
    </div>
    <button class="btn-sm btn-download" onclick="downloadFile('${info.url}', '${escapeHtml(info.fileName)}')">
      Download
    </button>
  `;
  list.prepend(el);
}

function downloadFile(url, fileName) {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ─── Toast Notifications ────────────────────────────────────────

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3000);
}

// ─── Utility Functions ──────────────────────────────────────────

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  if (!bytes || !isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatETA(seconds) {
  if (!seconds || !isFinite(seconds)) return '--';
  if (seconds < 1) return '< 1s';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Popstate for browser back/forward ──────────────────────────

window.addEventListener('popstate', () => {
  const pathMatch = location.pathname.match(/^\/room\/([A-Z0-9]+)$/i);
  if (pathMatch) {
    joinRoom(pathMatch[1].toUpperCase());
  } else {
    navigateHome();
  }
});
