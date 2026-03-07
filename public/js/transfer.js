/**
 * DirectSend - File Transfer Engine
 * Handles chunked file streaming over WebRTC DataChannel.
 * Supports: large files, progress tracking, pause/resume, encryption.
 */

class TransferEngine {
  constructor() {
    // Chunk size: 256KB for higher throughput with modern browsers
    this.CHUNK_SIZE = 256 * 1024;
    this.PROGRESS_UPDATE_INTERVAL_MS = 200;

    // Active outgoing transfers: transferId -> { file, state, ... }
    this.outgoing = new Map();

    // Active incoming transfers: transferId -> { meta, chunks, state, ... }
    this.incoming = new Map();
    this.pendingChunkByPeer = new Map(); // peerId -> { transferId, index }

    // Callbacks
    this.onTransferProgress = null;   // (transferId, progress) => void
    this.onTransferComplete = null;   // (transferId, file) => void
    this.onTransferError = null;      // (transferId, error) => void
    this.onIncomingFile = null;       // (transferId, meta) => void
    this.onTransferStateChange = null; // (transferId, state) => void

    // Set up data channel message handler
    peerManager.onDataChannel = (peerId, data) => {
      this._handleIncoming(peerId, data);
    };
  }

  /**
   * Generate a unique transfer ID
   */
  _generateTransferId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Send a file to specific peers (or all connected peers)
   */
  async sendFile(file, targetPeerIds = null) {
    const peers = targetPeerIds || peerManager.getConnectedPeers();
    if (peers.length === 0) {
      throw new Error('No connected peers');
    }

    const transferId = this._generateTransferId();
    const totalChunks = Math.ceil(file.size / this.CHUNK_SIZE);

    const transfer = {
      id: transferId,
      file,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || 'application/octet-stream',
      totalChunks,
      currentChunk: 0,
      state: 'sending', // sending, paused, completed, cancelled, error
      peers: new Set(peers),
      startTime: Date.now(),
      bytesSent: 0,
      speedSamples: [],
      lastProgressAt: 0,
      direction: 'outgoing'
    };

    this.outgoing.set(transferId, transfer);

    // Send file metadata to each peer
    const meta = {
      type: 'file-meta',
      transferId,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || 'application/octet-stream',
      totalChunks,
      encrypted: window.dsCrypto.enabled,
    };

    for (const peerId of peers) {
      try {
        await peerManager.sendToPeer(peerId, JSON.stringify(meta));
      } catch (e) {
        console.error(`Failed to send meta to ${peerId}:`, e);
      }
    }

    // Start streaming chunks
    this._streamFile(transferId);

    return transferId;
  }

  /**
   * Stream file chunks to peers
   */
  async _streamFile(transferId) {
    const transfer = this.outgoing.get(transferId);
    if (!transfer) return;

    while (transfer.currentChunk < transfer.totalChunks) {
      // Check state
      if (transfer.state === 'paused') {
        return; // Will be resumed later
      }
      if (transfer.state === 'cancelled') {
        this.outgoing.delete(transferId);
        return;
      }

      const start = transfer.currentChunk * this.CHUNK_SIZE;
      const end = Math.min(start + this.CHUNK_SIZE, transfer.file.size);
      const blob = transfer.file.slice(start, end);
      let chunkData = await blob.arrayBuffer();

      // Encrypt if enabled
      if (window.dsCrypto.enabled) {
        chunkData = await window.dsCrypto.encrypt(chunkData);
      }

      // Build chunk header (transferId + chunkIndex as JSON prefix)
      const header = JSON.stringify({
        type: 'chunk',
        transferId,
        index: transfer.currentChunk,
        size: chunkData.byteLength
      });

      // Send header + chunk in one batched operation per peer
      const failedPeers = [];
      await Promise.all(
        [...transfer.peers].map(async (peerId) => {
          try {
            await peerManager.sendFramesToPeer(peerId, [header, chunkData]);
          } catch (e) {
            console.error(`Error sending chunk to ${peerId}:`, e);
            failedPeers.push(peerId);
          }
        })
      );

      for (const peerId of failedPeers) {
        transfer.peers.delete(peerId);
      }

      if (transfer.peers.size === 0) {
        transfer.state = 'error';
        if (this.onTransferError) {
          this.onTransferError(transferId, 'All peers disconnected');
        }
        return;
      }

      transfer.currentChunk++;
      transfer.bytesSent = Math.min(end, transfer.file.size);

      // Track speed
      const now = Date.now();
      transfer.speedSamples.push({ time: now, bytes: transfer.bytesSent });
      // Keep only last 20 samples for speed calculation
      if (transfer.speedSamples.length > 20) {
        transfer.speedSamples.shift();
      }

      // Report progress
      if (this.onTransferProgress && this._shouldEmitProgress(transfer, now)) {
        this.onTransferProgress(transferId, {
          percent: (transfer.currentChunk / transfer.totalChunks) * 100,
          bytesSent: transfer.bytesSent,
          totalBytes: transfer.fileSize,
          speed: this._calculateSpeed(transfer),
          eta: this._calculateETA(transfer),
          direction: 'outgoing'
        });
      }

      // Small yield to prevent blocking
      if (transfer.currentChunk % 200 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Transfer complete
    transfer.state = 'completed';

    // Send completion message
    const doneMsg = JSON.stringify({
      type: 'transfer-done',
      transferId
    });
    for (const peerId of transfer.peers) {
      try {
        await peerManager.sendToPeer(peerId, doneMsg);
      } catch (e) { /* ignore */ }
    }

    if (this.onTransferComplete) {
      this.onTransferComplete(transferId, { direction: 'outgoing', fileName: transfer.fileName });
    }
    if (this.onTransferStateChange) {
      this.onTransferStateChange(transferId, 'completed');
    }
  }

  /**
   * Handle incoming data from peers
   */
  _handleIncoming(peerId, data) {
    // String messages are control/meta, ArrayBuffer is chunk data
    if (typeof data === 'string') {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'file-meta':
          this._handleFileMeta(peerId, msg);
          break;
        case 'chunk':
          this._prepareForChunk(peerId, msg);
          break;
        case 'transfer-done':
          this._handleTransferDone(msg.transferId);
          break;
        case 'transfer-control':
          this._handleTransferControl(peerId, msg);
          break;
      }
    } else if (data instanceof ArrayBuffer) {
      this._handleChunkData(peerId, data);
    }
  }

  /**
   * Handle incoming file metadata
   */
  _handleFileMeta(peerId, meta) {
    const transfer = {
      id: meta.transferId,
      fileName: meta.fileName,
      fileSize: meta.fileSize,
      fileType: meta.fileType,
      totalChunks: meta.totalChunks,
      encrypted: meta.encrypted,
      chunks: new Array(meta.totalChunks),
      receivedChunks: 0,
      state: 'receiving',
      fromPeerId: peerId,
      startTime: Date.now(),
      bytesReceived: 0,
      speedSamples: [],
      lastProgressAt: 0,
      direction: 'incoming'
    };

    this.incoming.set(meta.transferId, transfer);

    if (this.onIncomingFile) {
      this.onIncomingFile(meta.transferId, {
        fileName: meta.fileName,
        fileSize: meta.fileSize,
        fileType: meta.fileType,
        fromPeerId: peerId
      });
    }
  }

  /**
   * Prepare to receive chunk data (set pending metadata)
   */
  _prepareForChunk(peerId, chunkMeta) {
    const transfer = this.incoming.get(chunkMeta.transferId);
    if (!transfer) {
      return;
    }

    this.pendingChunkByPeer.set(peerId, {
      transferId: chunkMeta.transferId,
      index: chunkMeta.index,
    });
  }

  /**
   * Handle incoming binary chunk data
   */
  async _handleChunkData(peerId, data) {
    const pending = this.pendingChunkByPeer.get(peerId);
    if (!pending) {
      console.warn('[Transfer] Received chunk data without pending meta');
      return;
    }

    const transfer = this.incoming.get(pending.transferId);
    this.pendingChunkByPeer.delete(peerId);

    if (!transfer) {
      return;
    }

    const chunkIndex = pending.index;

    if (transfer.state === 'cancelled') return;

    let chunkData = data;

    // Decrypt if encrypted
    if (transfer.encrypted && window.dsCrypto.enabled) {
      try {
        chunkData = await window.dsCrypto.decrypt(chunkData);
      } catch (e) {
        console.error('[Transfer] Decryption failed:', e);
        if (this.onTransferError) {
          this.onTransferError(transfer.id, 'Decryption failed - wrong password?');
        }
        return;
      }
    }

    transfer.chunks[chunkIndex] = chunkData;
    transfer.receivedChunks++;
    transfer.bytesReceived += chunkData.byteLength;

    // Track speed
    const now = Date.now();
    transfer.speedSamples.push({ time: now, bytes: transfer.bytesReceived });
    if (transfer.speedSamples.length > 20) {
      transfer.speedSamples.shift();
    }

    // Report progress
    if (this.onTransferProgress && this._shouldEmitProgress(transfer, now)) {
      this.onTransferProgress(transfer.id, {
        percent: (transfer.receivedChunks / transfer.totalChunks) * 100,
        bytesSent: transfer.bytesReceived,
        totalBytes: transfer.fileSize,
        speed: this._calculateSpeed(transfer),
        eta: this._calculateETA(transfer),
        direction: 'incoming'
      });
    }
  }

  /**
   * Handle transfer completion
   */
  _handleTransferDone(transferId) {
    const transfer = this.incoming.get(transferId);
    if (!transfer) return;

    transfer.state = 'completed';

    // Assemble file from chunks
    const blob = new Blob(transfer.chunks, { type: transfer.fileType });
    const url = URL.createObjectURL(blob);

    if (this.onTransferComplete) {
      this.onTransferComplete(transferId, {
        direction: 'incoming',
        fileName: transfer.fileName,
        fileSize: transfer.fileSize,
        fileType: transfer.fileType,
        url,
        blob
      });
    }
    if (this.onTransferStateChange) {
      this.onTransferStateChange(transferId, 'completed');
    }

    // Clean up chunks to free memory (keep blob URL)
    transfer.chunks = null;
  }

  /**
   * Pause an outgoing transfer
   */
  pauseTransfer(transferId) {
    const transfer = this.outgoing.get(transferId);
    if (transfer && transfer.state === 'sending') {
      transfer.state = 'paused';
      if (this.onTransferStateChange) {
        this.onTransferStateChange(transferId, 'paused');
      }
    }
  }

  /**
   * Resume a paused outgoing transfer
   */
  resumeTransfer(transferId) {
    const transfer = this.outgoing.get(transferId);
    if (transfer && transfer.state === 'paused') {
      transfer.state = 'sending';
      if (this.onTransferStateChange) {
        this.onTransferStateChange(transferId, 'sending');
      }
      this._streamFile(transferId);
    }
  }

  /**
   * Cancel a transfer (outgoing or incoming)
   */
  cancelTransfer(transferId) {
    const outgoing = this.outgoing.get(transferId);
    if (outgoing) {
      outgoing.state = 'cancelled';
      this.outgoing.delete(transferId);
    }

    const incoming = this.incoming.get(transferId);
    if (incoming) {
      incoming.state = 'cancelled';
      incoming.chunks = null;
      this.incoming.delete(transferId);

      for (const [peerId, pending] of this.pendingChunkByPeer) {
        if (pending.transferId === transferId) {
          this.pendingChunkByPeer.delete(peerId);
        }
      }
    }

    if (this.onTransferStateChange) {
      this.onTransferStateChange(transferId, 'cancelled');
    }
  }

  /**
   * Handle transfer control messages (pause/resume/cancel from peer)
   */
  _handleTransferControl(peerId, msg) {
    const { transferId, action } = msg;
    switch (action) {
      case 'pause':
        this.pauseTransfer(transferId);
        break;
      case 'resume':
        this.resumeTransfer(transferId);
        break;
      case 'cancel':
        this.cancelTransfer(transferId);
        break;
    }
  }

  /**
   * Calculate current transfer speed (bytes/sec)
   */
  _calculateSpeed(transfer) {
    const samples = transfer.speedSamples;
    if (samples.length < 2) return 0;

    const first = samples[0];
    const last = samples[samples.length - 1];
    const timeDiff = (last.time - first.time) / 1000;
    if (timeDiff === 0) return 0;

    return (last.bytes - first.bytes) / timeDiff;
  }

  /**
   * Calculate ETA in seconds
   */
  _calculateETA(transfer) {
    const speed = this._calculateSpeed(transfer);
    if (speed === 0) return Infinity;

    const remaining = transfer.fileSize - (transfer.bytesSent || transfer.bytesReceived || 0);
    return remaining / speed;
  }

  _shouldEmitProgress(transfer, now) {
    const isComplete =
      (transfer.direction === 'outgoing' && transfer.currentChunk >= transfer.totalChunks) ||
      (transfer.direction === 'incoming' && transfer.receivedChunks >= transfer.totalChunks);

    if (isComplete || now - transfer.lastProgressAt >= this.PROGRESS_UPDATE_INTERVAL_MS) {
      transfer.lastProgressAt = now;
      return true;
    }

    return false;
  }

  /**
   * Get transfer info
   */
  getTransfer(transferId) {
    return this.outgoing.get(transferId) || this.incoming.get(transferId);
  }
}

// Global instance
window.transferEngine = new TransferEngine();
