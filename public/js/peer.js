/**
 * DirectSend - WebRTC Peer Connection Manager
 * Manages WebSocket signaling and WebRTC peer connections.
 */

class PeerManager {
  constructor() {
    this.ws = null;
    this.myPeerId = null;
    this.roomId = null;
    this.peers = new Map();
    this.onPeerConnected = null;
    this.onPeerDisconnected = null;
    this.onDataChannel = null;
    this.onFileOffer = null;
    this.onConnectionStateChange = null;

    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;

    this.iceConfigLoaded = false;
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

  connect(roomId) {
    this.roomId = roomId;
    this._ensureIceConfig().finally(() => {
      this._connectWebSocket(roomId);
    });
  }

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
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[WS] Connected to signaling server');
      this.reconnectAttempts = 0;
      this.ws.send(JSON.stringify({ type: 'join', roomId }));
    };

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
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

  async _handleSignal(msg) {
    switch (msg.type) {
      case 'room-joined': {
        this.myPeerId = msg.peerId;
        console.log(`[Room] Joined as ${msg.peerId}, existing peers: ${msg.peers.length}`);

        if (this.onConnectionStateChange) {
          this.onConnectionStateChange('connected');
        }

        for (const peerId of msg.peers) {
          await this._createPeerConnection(peerId, true);
        }
        break;
      }

      case 'peer-joined': {
        console.log(`[Room] Peer joined: ${msg.peerId}`);
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
          if (peer.pc.signalingState !== 'have-local-offer') {
            console.warn(
              `[RTC] Ignoring stale answer from ${fromPeerId} in state ${peer.pc.signalingState}`
            );
            break;
          }

          try {
            await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
          } catch (error) {
            console.warn(`[RTC] Failed to apply answer from ${fromPeerId}:`, error);
          }
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

  async _createPeerConnection(peerId, isInitiator) {
    if (this.peers.has(peerId)) {
      this._closePeerConnection(peerId);
    }

    const pc = new RTCPeerConnection(this.rtcConfig);
    const peerInfo = { pc, dataChannel: null, state: 'connecting', isInitiator };
    this.peers.set(peerId, peerInfo);

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
        setTimeout(() => {
          if (
            this.peers.has(peerId) &&
            this.peers.get(peerId).state === 'disconnected' &&
            this._shouldInitiateConnection(peerId)
          ) {
            console.log(`[RTC] Attempting to reconnect with ${peerId}`);
            this._createPeerConnection(peerId, true);
          }
        }, 2000);
      }
    };

    if (isInitiator) {
      const dc = pc.createDataChannel('file-transfer', { ordered: true });
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

  _setupDataChannel(dc, peerId) {
    dc.binaryType = 'arraybuffer';
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

  _shouldInitiateConnection(peerId) {
    if (!this.myPeerId) {
      return true;
    }

    return String(this.myPeerId) < String(peerId);
  }

  async sendToPeer(peerId, data) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== 'open') {
      throw new Error(`No open data channel with peer ${peerId}`);
    }

    const dc = peer.dataChannel;
    await this._waitForWritableBuffer(dc, 32 * 1024 * 1024);
    dc.send(data);
  }

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

  async broadcast(data) {
    const promises = [];
    for (const [peerId, peer] of this.peers) {
      if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
        promises.push(this.sendToPeer(peerId, data));
      }
    }
    await Promise.all(promises);
  }

  _signal(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

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

  getConnectedPeers() {
    const connected = [];
    for (const [peerId, peer] of this.peers) {
      if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
        connected.push(peerId);
      }
    }
    return connected;
  }

  disconnect() {
    for (const [peerId] of this.peers) {
      this._closePeerConnection(peerId);
    }
    if (this.ws) {
      this.ws.close();
    }
  }
}

window.peerManager = new PeerManager();
