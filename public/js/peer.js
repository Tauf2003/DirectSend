/**
 * DirectSend - WebRTC Peer Connection Manager
 * Manages WebSocket signaling and WebRTC peer connections.
 */

class PeerManager {
  constructor() {
    this.ws = null;
    this.myPeerId = null;
    this.roomId = null;
    this.peers = new Map(); // peerId -> { pc, dataChannel, state }
    this.onPeerConnected = null;
    this.onPeerDisconnected = null;
    this.onDataChannel = null;
    this.onFileOffer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;

    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
      ]
    };
  }

  /**
      this.iceConfigLoaded = false;
      this.rtcConfig = {
   */
  connect(roomId) {
    this.roomId = roomId;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[WS] Connected to signaling server');
      this.reconnectAttempts = 0;
      this.ws.send(JSON.stringify({ type: 'join', roomId }));
    };

    this.ws.onmessage = (event) => {
      this._ensureIceConfig().finally(() => {
        this._connectWebSocket(roomId);
      });
      const msg = JSON.parse(event.data);

    async _ensureIceConfig() {
      if (this.iceConfigLoaded) {
        return;
      }

      try {
        const res = await fetch('/api/ice-config', { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`ICE config request failed: ${res.status}`);
        }
        const data = await res.json();
        if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
          this.rtcConfig = { iceServers: data.iceServers };
          console.log('[RTC] Loaded ICE config from server');
        }
        this.iceConfigLoaded = true;
      } catch (error) {
        console.warn('[RTC] Using default STUN config:', error);
      }
    }

    _connectWebSocket(roomId) {
      this._handleSignal(msg);
    };

    this.ws.onclose = () => {
      console.log('[WS] Disconnected');
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange('disconnected');
      }
      this._tryReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[WS] Error:', err);
    };
  }

  /**
   * Auto-reconnect with exponential backoff
   */
  _tryReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[WS] Max reconnection attempts reached');
      return;
    }
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
    console.log(`[WS] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        this.connect(this.roomId);
      }
    }, delay);
  }

  /**
   * Handle incoming signaling messages
   */
  async _handleSignal(msg) {
    switch (msg.type) {
      case 'room-joined': {
        this.myPeerId = msg.peerId;
        console.log(`[Room] Joined as ${msg.peerId}, existing peers: ${msg.peers.length}`);
        if (this.onConnectionStateChange) {
          this.onConnectionStateChange('connected');
        }
        // Initiate connection to each existing peer
        for (const peerId of msg.peers) {
          await this._createPeerConnection(peerId, true);
        }
        break;
      }

      case 'peer-joined': {
        console.log(`[Room] Peer joined: ${msg.peerId}`);
        // The new peer will initiate the offer, but we prepare
        // Connection will be established when we receive their offer
        break;
      }

      case 'peer-left': {
        console.log(`[Room] Peer left: ${msg.peerId}`);
        this._closePeerConnection(msg.peerId);
        if (this.onPeerDisconnected) {
          this.onPeerDisconnected(msg.peerId);
        }
        break;
      }

      case 'offer': {
        const { fromPeerId, sdp } = msg;
        console.log(`[RTC] Received offer from ${fromPeerId}`);
        await this._createPeerConnection(fromPeerId, false);
        const pc = this.peers.get(fromPeerId).pc;
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._signal({ type: 'answer', targetPeerId: fromPeerId, sdp: answer.sdp });
        break;
      }

      case 'answer': {
        const { fromPeerId, sdp } = msg;
        console.log(`[RTC] Received answer from ${fromPeerId}`);
        const peer = this.peers.get(fromPeerId);
        if (peer) {
          await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
        }
        break;
      }

      case 'ice-candidate': {
        const { fromPeerId, candidate } = msg;
        const peer = this.peers.get(fromPeerId);
        if (peer && candidate) {
          try {
            await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.warn('[RTC] ICE candidate error:', e);
          }
        }
        break;
      }
    }
  }

  /**
   * Create a WebRTC peer connection
   */
  async _createPeerConnection(peerId, isInitiator) {
    // Close existing connection if any
    if (this.peers.has(peerId)) {
      this._closePeerConnection(peerId);
    }

    const pc = new RTCPeerConnection(this.rtcConfig);
    const peerInfo = { pc, dataChannel: null, state: 'connecting', isInitiator };
    this.peers.set(peerId, peerInfo);

    // ICE candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this._signal({
          type: 'ice-candidate',
          targetPeerId: peerId,
          candidate: event.candidate.toJSON()
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[RTC] Connection state with ${peerId}: ${pc.connectionState}`);
      if (pc.connectionState === 'connected') {
        peerInfo.state = 'connected';
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        peerInfo.state = 'disconnected';
        // Try to reconnect after a short delay
        setTimeout(() => {
          if (this.peers.has(peerId) && this.peers.get(peerId).state === 'disconnected') {
            console.log(`[RTC] Attempting to reconnect with ${peerId}`);
            this._createPeerConnection(peerId, true);
          }
        }, 2000);
      }
    };

    // Data channel handling
    if (isInitiator) {
      const dc = pc.createDataChannel('file-transfer', {
        ordered: true
      });
      this._setupDataChannel(dc, peerId);
      peerInfo.dataChannel = dc;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this._signal({ type: 'offer', targetPeerId: peerId, sdp: offer.sdp });
    } else {
      pc.ondatachannel = (event) => {
        const dc = event.channel;
        this._setupDataChannel(dc, peerId);
        peerInfo.dataChannel = dc;
      };
    }
  }

  /**
   * Set up data channel event handlers
   */
  _setupDataChannel(dc, peerId) {
    dc.binaryType = 'arraybuffer';

    // Set buffer threshold for flow control (4MB)
    dc.bufferedAmountLowThreshold = 4 * 1024 * 1024;

    dc.onopen = () => {
      console.log(`[DC] Data channel open with ${peerId}`);
      if (this.onPeerConnected) {
        this.onPeerConnected(peerId);
      }
    };

    dc.onclose = () => {
      console.log(`[DC] Data channel closed with ${peerId}`);
    };

    dc.onmessage = (event) => {
      if (this.onDataChannel) {
        this.onDataChannel(peerId, event.data);
      }
    };

    dc.onerror = (error) => {
      console.error(`[DC] Data channel error with ${peerId}:`, error);
    };
  }

  /**
   * Send data to a specific peer
   */
  async sendToPeer(peerId, data) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== 'open') {
      throw new Error(`No open data channel with peer ${peerId}`);
    }

    const dc = peer.dataChannel;

    // Flow control: wait if buffer is too full
    await this._waitForWritableBuffer(dc, 32 * 1024 * 1024); // 32MB threshold

    dc.send(data);
  }

  /**
   * Send multiple frames to a peer with a single flow-control gate.
   */
  async sendFramesToPeer(peerId, frames) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== 'open') {
      throw new Error(`No open data channel with peer ${peerId}`);
    }

    const dc = peer.dataChannel;
    await this._waitForWritableBuffer(dc, 32 * 1024 * 1024);

    for (const frame of frames) {
      dc.send(frame);
    }
  }

  async _waitForWritableBuffer(dc, highWatermark) {
    if (dc.bufferedAmount <= highWatermark) {
      return;
    }

    await new Promise((resolve) => {
      dc.onbufferedamountlow = () => {
        dc.onbufferedamountlow = null;
        resolve();
      };
    });
  }

  /**
   * Send data to all connected peers
   */
  async broadcast(data) {
    const promises = [];
    for (const [peerId, peer] of this.peers) {
      if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
        promises.push(this.sendToPeer(peerId, data));
      }
    }
    await Promise.all(promises);
  }

  /**
   * Send a signaling message via WebSocket
   */
  _signal(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Close a specific peer connection
   */
  _closePeerConnection(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      if (peer.dataChannel) {
        peer.dataChannel.close();
      }
      peer.pc.close();
      this.peers.delete(peerId);
    }
  }

  /**
   * Get list of connected peer IDs
   */
  getConnectedPeers() {
    const connected = [];
    for (const [peerId, peer] of this.peers) {
      if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
        connected.push(peerId);
      }
    }
    return connected;
  }

  /**
   * Disconnect from everything
   */
  disconnect() {
    for (const [peerId] of this.peers) {
      this._closePeerConnection(peerId);
    }
    if (this.ws) {
      this.ws.close();
    }
  }
}

// Global instance
window.peerManager = new PeerManager();
