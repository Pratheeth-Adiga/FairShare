export interface SignalingData {
  sdp: string;
  ice: RTCIceCandidateInit[];
  peerId: string;
  groupId: string;
  type: 'offer' | 'answer';
}

// FS2/FS3 compact the SDP fields and candidates into a QR-sized binary payload.
// FS3 adds the fingerprint algorithm marker; all fields use little-endian lengths.

const PREFIX_V2 = 'FS2:';
const PREFIX_V3 = 'FS3:';

export function isSignalingBlob(blob: string): boolean {
  return blob.startsWith(PREFIX_V3) || blob.startsWith(PREFIX_V2);
}

// algo marker constants
const ALGO_TO_ID: Record<string, number> = { 'sha-256': 0, 'sha-384': 1, 'sha-512': 2 };
const ID_TO_ALGO = ['sha-256', 'sha-384', 'sha-512'];
const ALGO_TO_BYTES = [32, 48, 64];

function toBase64Url(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str: string): Uint8Array {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function parseSDP(sdp: string) {
  let ufrag = '', pwd = '', fpHex = '', setup = 'actpass', fpAlgo = 'sha-256';
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('a=ice-ufrag:')) ufrag = line.slice(12).trim();
    else if (line.startsWith('a=ice-pwd:')) pwd = line.slice(10).trim();
    else if (line.startsWith('a=fingerprint:')) {
      const parts = line.slice('a=fingerprint:'.length).trim().split(' ');
      // reject malformed fingerprint lines instead of silently defaulting
      if (parts.length !== 2) throw new Error('Malformed a=fingerprint in SDP');
      // capture the algorithm label so we can preserve it in FS3 encoding
      const algo = parts[0].toLowerCase();
      if (algo in ALGO_TO_ID) fpAlgo = algo;
      fpHex = parts[1];
    }
    else if (line.startsWith('a=setup:')) setup = line.slice(8).trim();
  }
  return { ufrag, pwd, fpHex, setup, fpAlgo };
}

function reconstructSDP(ufrag: string, pwd: string, fpHex: string, setup: string, fpAlgo: string = 'sha-256'): string {
  return [
    'v=0', 'o=- 1234567890 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
    'a=group:BUNDLE 0', 'a=extmap-allow-mixed',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:${fpAlgo} ${fpHex}`,
    `a=setup:${setup}`,
    'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144',
  ].join('\r\n') + '\r\n';
}

const MDNS_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.local$/i;
// these go straight into the rebuilt SDP, so a CR/LF here would inject lines.
// RFC 8839 ice-char is ALPHA / DIGIT / "+" / "/".
const ICE_CHARS_RE = /^[A-Za-z0-9+/]+$/;
// old 16-hex-char ids or new 64-hex-char ids, e.g. peer-a1b2c3...
const PEER_ID_RE = /^peer-(?:[0-9a-f]{16}|[0-9a-f]{64})$/i;
const MAX_CANDIDATES = 8;

// encode a compressed IPv6 address to 16 raw bytes.
function ipv6ToBytes(addr: string): Uint8Array {
  const out = new Uint8Array(16);
  const sides = addr.split('::');
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides.length > 1 && sides[1] ? sides[1].split(':') : [];
  const fill = 8 - left.length - right.length;
  const groups = [...left, ...Array(fill).fill('0'), ...right];
  for (let j = 0; j < 8; j++) {
    const val = parseInt(groups[j] || '0', 16);
    out[j * 2] = (val >> 8) & 0xff;
    out[j * 2 + 1] = val & 0xff;
  }
  return out;
}

// F-IPv6: decode 16 raw bytes back to a compressed IPv6 string.
function bytesToIPv6(buf: Uint8Array, offset: number): string {
  const groups: number[] = [];
  for (let j = 0; j < 8; j++) groups.push((buf[offset + j * 2] << 8) | buf[offset + j * 2 + 1]);
  // Find the longest run of consecutive zeros for :: compression.
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let j = 0; j <= 8; j++) {
    if (j < 8 && groups[j] === 0) {
      if (curStart === -1) { curStart = j; curLen = 1; } else curLen++;
    } else {
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
      curStart = -1; curLen = 0;
    }
  }
  if (bestLen < 2) return groups.map(g => g.toString(16)).join(':');
  const left = groups.slice(0, bestStart).map(g => g.toString(16)).join(':');
  const right = groups.slice(bestStart + bestLen).map(g => g.toString(16)).join(':');
  return `${left}::${right}`;
}

function parseCandidate(c: RTCIceCandidateInit): { addr: string; isMdns: boolean; isIPv6: boolean; port: number; proto: number; ctype: number } | null {
  if (!c.candidate) return null;
  const p = c.candidate.replace(/^candidate:/, '').split(' ');
  if (p.length < 8) return null;
  const addr = p[4];
  const isMdns = MDNS_RE.test(addr);
  const isIPv4 = /^\d+\.\d+\.\d+\.\d+$/.test(addr);
  // Accept IPv4, mDNS, or IPv6 (contains colon); drop anything else.
  const isIPv6 = !isMdns && !isIPv4 && addr.includes(':');
  if (!isMdns && !isIPv4 && !isIPv6) return null;
  return {
    addr, isMdns, isIPv6, port: parseInt(p[5]),
    proto: p[2].toUpperCase() === 'UDP' ? 0 : 1,
    ctype: p[7] === 'srflx' ? 1 : p[7] === 'relay' ? 2 : 0,
  };
}

type EncodedCandidate = NonNullable<ReturnType<typeof parseCandidate>>;

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToUuid(b: Uint8Array, offset: number): string {
  const h = Array.from(b.slice(offset, offset + 16)).map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

export function encodeSignaling(data: SignalingData): string {
  const { ufrag, pwd, fpHex, setup, fpAlgo } = parseSDP(data.sdp);
  const candidates = data.ice
    .map(parseCandidate)
    .filter((candidate): candidate is EncodedCandidate => candidate !== null);

  // use algorithm-aware byte length for the fingerprint
  const algoId = ALGO_TO_ID[fpAlgo] ?? 0;
  const expectedFpBytes = ALGO_TO_BYTES[algoId];

  // Convert fingerprint "AB:CD:..." → binary bytes
  const fpBytes = new Uint8Array(fpHex.split(':').map(h => parseInt(h, 16)));

  const ufragBytes = new TextEncoder().encode(ufrag);
  const pwdBytes = new TextEncoder().encode(pwd);
  const peerIdBytes = new TextEncoder().encode(data.peerId);
  const groupIdBytes = uuidToBytes(data.groupId);

  const candidatesSize = candidates.reduce(
    (sum, candidate) => sum + 1 + (candidate.isMdns || candidate.isIPv6 ? 16 : 4) + 2,
    0
  );
  // FS3 layout: flags(1) + algoId(1) + ufragLen(1)+ufrag + pwdLen(1)+pwd + fpBytes + peerIdLen(1)+peerId + groupId(16) + nCandidates(1) + candidates
  const size = 1 + 1 + 1 + ufragBytes.length + 1 + pwdBytes.length + expectedFpBytes + 1 + peerIdBytes.length + 16 + 1 + candidatesSize;
  const buf = new Uint8Array(size);
  let i = 0;

  const setupBit = setup === 'actpass' ? 0 : 1;
  buf[i++] = (data.type === 'answer' ? 1 : 0) | (setupBit << 1);

  // write algorithm id byte
  buf[i++] = algoId;

  buf[i++] = ufragBytes.length; buf.set(ufragBytes, i); i += ufragBytes.length;
  buf[i++] = pwdBytes.length;   buf.set(pwdBytes, i);   i += pwdBytes.length;
  buf.set(fpBytes.slice(0, expectedFpBytes), i); i += expectedFpBytes;
  buf[i++] = peerIdBytes.length; buf.set(peerIdBytes, i); i += peerIdBytes.length;
  buf.set(groupIdBytes, i); i += 16;

  buf[i++] = candidates.length;
  for (const candidate of candidates) {
    buf[i++] = candidate.ctype
      | (candidate.isMdns ? 0x04 : 0)
      | (candidate.isIPv6 ? 0x08 : 0)
      | (candidate.proto << 4);
    if (candidate.isMdns) {
      buf.set(uuidToBytes(candidate.addr.slice(0, 36)), i); i += 16;
    } else if (candidate.isIPv6) {
      buf.set(ipv6ToBytes(candidate.addr), i); i += 16;
    } else {
      const parts = candidate.addr.split('.').map(Number);
      buf[i++] = parts[0]; buf[i++] = parts[1]; buf[i++] = parts[2]; buf[i++] = parts[3];
    }
    buf[i++] = (candidate.port >> 8) & 0xff;
    buf[i++] = candidate.port & 0xff;
  }

  return PREFIX_V3 + toBase64Url(buf);
}

export function decodeSignaling(blob: string): SignalingData {
  const isV3 = blob.startsWith(PREFIX_V3);
  const isV2 = blob.startsWith(PREFIX_V2);
  if (!isV3 && !isV2) {
    throw new Error(`Unknown signaling format (expected ${PREFIX_V3} or ${PREFIX_V2})`);
  }

  const prefix = isV3 ? PREFIX_V3 : PREFIX_V2;
  const buf = fromBase64Url(blob.slice(prefix.length));
  let i = 0;

  // bounds-check helper to report truncated blobs
  const need = (n: number, field: string): void => {
    if (i + n > buf.length) throw new Error(`Truncated signaling blob (${field})`);
  };

  need(1, 'flags');
  const flags = buf[i++];
  const type: 'offer' | 'answer' = (flags & 1) ? 'answer' : 'offer';
  const setup = (flags >> 1) & 1 ? 'active' : 'actpass';

  // read algoId only for FS3; FS2 blobs default to sha-256
  let algoId = 0;
  if (isV3) {
    need(1, 'algoId');
    algoId = buf[i++];
  }
  const fpAlgo = ID_TO_ALGO[algoId] ?? 'sha-256';
  const fpByteLen = ALGO_TO_BYTES[algoId] ?? 32;

  need(1, 'ufragLen');
  const ufragLen = buf[i++];
  need(ufragLen, 'ufrag');
  const ufrag = new TextDecoder().decode(buf.slice(i, i + ufragLen)); i += ufragLen;
  if (ufrag.length < 4 || !ICE_CHARS_RE.test(ufrag)) throw new Error('Invalid ICE ufrag in signaling blob');

  need(1, 'pwdLen');
  const pwdLen = buf[i++];
  need(pwdLen, 'pwd');
  const pwd = new TextDecoder().decode(buf.slice(i, i + pwdLen)); i += pwdLen;
  if (pwd.length < 22 || !ICE_CHARS_RE.test(pwd)) throw new Error('Invalid ICE password in signaling blob');

  need(fpByteLen, 'fingerprint');
  const fpBytes = buf.slice(i, i + fpByteLen); i += fpByteLen;
  const fpHex = Array.from(fpBytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');

  need(1, 'peerIdLen');
  const peerIdLen = buf[i++];
  need(peerIdLen, 'peerId');
  const peerId = new TextDecoder().decode(buf.slice(i, i + peerIdLen)); i += peerIdLen;
  if (!PEER_ID_RE.test(peerId)) throw new Error('Invalid peer id in signaling blob');

  need(16, 'groupId');
  const groupId = bytesToUuid(buf, i); i += 16;

  need(1, 'nCandidates');
  const nCandidates = buf[i++];
  if (nCandidates > MAX_CANDIDATES) throw new Error(`Too many ICE candidates in signaling blob (${nCandidates})`);
  const ice: RTCIceCandidateInit[] = [];
  const typeNames = ['host', 'srflx', 'relay'];

  for (let n = 0; n < nCandidates; n++) {
    need(1, `candidate[${n}].packed`);
    const packed = buf[i++];
    const ctype = packed & 0x03;
    const isMdns = (packed & 0x04) !== 0;
    const isIPv6 = (packed & 0x08) !== 0;
    const proto = (packed >> 4) & 0x0f;
    let addr: string;
    if (isMdns) {
      need(16, `candidate[${n}].mdnsUuid`);
      addr = `${bytesToUuid(buf, i)}.local`; i += 16;
    } else if (isIPv6) {
      need(16, `candidate[${n}].ipv6`);
      addr = bytesToIPv6(buf, i); i += 16;
    } else {
      need(4, `candidate[${n}].ipv4`);
      addr = `${buf[i]}.${buf[i+1]}.${buf[i+2]}.${buf[i+3]}`; i += 4;
    }
    need(2, `candidate[${n}].port`);
    const port = (buf[i] << 8) | buf[i+1]; i += 2;
    const protoStr = proto === 0 ? 'UDP' : 'TCP';
    const ctypeStr = typeNames[ctype] ?? 'host';
    const priority = ctype === 1 ? 1686052863 : ctype === 2 ? 16777215 : 2122252543;
    ice.push({
      candidate: `candidate:1 1 ${protoStr} ${priority} ${addr} ${port} typ ${ctypeStr}`,
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
  }

  const sdp = reconstructSDP(ufrag, pwd, fpHex, type === 'offer' ? setup : 'active', fpAlgo);
  return { sdp, ice, peerId, groupId, type };
}

export function estimateBlobSize(blob: string): { bytes: number; fitsQR: boolean } {
  const bytes = new TextEncoder().encode(blob).length;
  // >400 bytes produces a QR too dense for most phone cameras to scan reliably
  return { bytes, fitsQR: bytes <= 400 };
}
