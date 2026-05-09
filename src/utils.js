// AES-256-GCM encryption helpers + small validators.
// Master key comes from MASTER_KEY env (32-byte hex). Generated once at deploy.
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function masterKey() {
  const k = process.env.MASTER_KEY;
  if (!k || k.length !== 64) {
    throw new Error('MASTER_KEY env var missing or not 64 hex chars (32 bytes)');
  }
  return Buffer.from(k, 'hex');
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(blob) {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const dec = crypto.createDecipheriv(ALGO, masterKey(), iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(enc), dec.final()]).toString('utf8');
}

function isValidEthAddress(s) {
  return typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/.test(s);
}

function isValidPrivateKey(s) {
  if (typeof s !== 'string') return false;
  const k = s.startsWith('0x') ? s.slice(2) : s;
  return /^[a-fA-F0-9]{64}$/.test(k);
}

function shortAddr(a) {
  if (!a) return '';
  return a.slice(0, 6) + '…' + a.slice(-4);
}

module.exports = { encrypt, decrypt, isValidEthAddress, isValidPrivateKey, shortAddr };
