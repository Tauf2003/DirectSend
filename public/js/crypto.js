/**
 * DirectSend - Encryption Module
 * AES-256-GCM encryption/decryption for file chunks using Web Crypto API.
 */

class DirectSendCrypto {
  constructor() {
    this.enabled = false;
    this.key = null;
  }

  /**
   * Derive an AES-256-GCM key from a password using PBKDF2
   */
  async deriveKey(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Initialize encryption with a password
   */
  async init(password) {
    if (!password) {
      this.enabled = false;
      this.key = null;
      return;
    }
    // Use a fixed salt derived from the room context
    // In production you'd exchange a random salt via signaling
    this.salt = new TextEncoder().encode('DirectSend-Salt-2026-v1');
    this.key = await this.deriveKey(password, this.salt);
    this.enabled = true;
  }

  /**
   * Encrypt a chunk (ArrayBuffer) → { iv, encrypted }
   */
  async encrypt(data) {
    if (!this.enabled) return data;

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.key,
      data
    );

    // Pack iv + encrypted data into a single buffer
    const packed = new Uint8Array(12 + encrypted.byteLength);
    packed.set(iv, 0);
    packed.set(new Uint8Array(encrypted), 12);
    return packed.buffer;
  }

  /**
   * Decrypt a packed buffer (iv + ciphertext) → ArrayBuffer
   */
  async decrypt(packed) {
    if (!this.enabled) return packed;

    const data = new Uint8Array(packed);
    const iv = data.slice(0, 12);
    const ciphertext = data.slice(12);

    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.key,
      ciphertext
    );
  }

  /**
   * Generate a random room encryption key (for display)
   */
  static generatePassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let pw = '';
    const values = crypto.getRandomValues(new Uint8Array(16));
    for (const v of values) {
      pw += chars[v % chars.length];
    }
    return pw;
  }
}

// Global instance
window.dsCrypto = new DirectSendCrypto();
