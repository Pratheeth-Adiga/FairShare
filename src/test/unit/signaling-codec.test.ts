import { describe, it, expect } from 'vitest';
import { encodeSignaling, decodeSignaling, estimateBlobSize, isSignalingBlob } from '@/lib/p2p/signaling-codec';
import type { SignalingData } from '@/lib/p2p/signaling-codec';

const SDP_TEMPLATE = (ufrag: string, pwd: string, fp: string, setup: string) =>
  [
    'v=0', 'o=- 1234567890 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
    'a=group:BUNDLE 0', 'a=extmap-allow-mixed',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${fp}`,
    `a=setup:${setup}`,
    'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144',
  ].join('\r\n') + '\r\n';

const FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i * 7 % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');

function makeData(overrides: Partial<SignalingData> = {}): SignalingData {
  return {
    sdp: SDP_TEMPLATE('4zPa', 'pwd12345678901234567890', FINGERPRINT, 'actpass'),
    ice: [
      {
        candidate: 'candidate:1 1 UDP 2122252543 192.168.1.10 54321 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    ],
    peerId: 'peer-a1b2c3d4e5f6a7b8',
    groupId: '12345678-1234-5678-1234-567812345678',
    type: 'offer',
    ...overrides,
  };
}

describe('encodeSignaling / decodeSignaling round trip', () => {
  it('recognizes only supported signaling formats', () => {
    expect(isSignalingBlob('FS3:payload')).toBe(true);
    expect(isSignalingBlob('FS2:payload')).toBe(true);
    expect(isSignalingBlob('FSID1:identity')).toBe(false);
    expect(isSignalingBlob('FS1:legacy')).toBe(false);
  });

  it('round-trips ufrag, pwd, peerId, groupId, and type for an IPv4 host candidate', () => {
    const data = makeData();
    const blob = encodeSignaling(data);
    expect(blob.startsWith('FS3:')).toBe(true);

    const decoded = decodeSignaling(blob);
    expect(decoded.peerId).toBe(data.peerId);
    expect(decoded.groupId).toBe(data.groupId);
    expect(decoded.type).toBe('offer');
    expect(decoded.sdp).toContain('a=ice-ufrag:4zPa');
    expect(decoded.sdp).toContain('a=ice-pwd:pwd12345678901234567890');
    expect(decoded.sdp).toContain(`a=fingerprint:sha-256 ${FINGERPRINT}`);
    expect(decoded.ice).toHaveLength(1);
    expect(decoded.ice[0].candidate).toContain('192.168.1.10');
    expect(decoded.ice[0].candidate).toContain('54321');
    expect(decoded.ice[0].candidate).toContain('typ host');
  });

  it('round-trips an "answer" with active setup', () => {
    const data = makeData({
      type: 'answer',
      sdp: SDP_TEMPLATE('4zPa', 'pwd12345678901234567890', FINGERPRINT, 'active'),
    });
    const decoded = decodeSignaling(encodeSignaling(data));
    expect(decoded.type).toBe('answer');
    expect(decoded.sdp).toContain('a=setup:active');
  });

  it('round-trips a server-reflexive (srflx) candidate', () => {
    const data = makeData({
      ice: [
        {
          candidate: 'candidate:1 1 UDP 1686052863 203.0.113.5 33333 typ srflx',
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
      ],
    });
    const decoded = decodeSignaling(encodeSignaling(data));
    expect(decoded.ice[0].candidate).toContain('203.0.113.5');
    expect(decoded.ice[0].candidate).toContain('typ srflx');
  });

  it('round-trips an IPv6 candidate without truncating the address', () => {
    const data = makeData({
      ice: [
        {
          candidate: 'candidate:1 1 UDP 2122252543 fe80::1234:5678:9abc:def0 12345 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
      ],
    });
    const decoded = decodeSignaling(encodeSignaling(data));
    expect(decoded.ice[0].candidate).toContain('fe80::1234:5678:9abc:def0');
  });

  it('round-trips an mDNS-obfuscated LAN candidate by its UUID', () => {
    const mdnsHost = 'a1b2c3d4-e5f6-4789-a012-3456789abcde.local';
    const data = makeData({
      ice: [
        {
          candidate: `candidate:1 1 UDP 2122252543 ${mdnsHost} 40000 typ host`,
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
      ],
    });
    const decoded = decodeSignaling(encodeSignaling(data));
    expect(decoded.ice[0].candidate).toContain(mdnsHost);
  });

  it('round-trips multiple candidates in order', () => {
    const data = makeData({
      ice: [
        { candidate: 'candidate:1 1 UDP 2122252543 192.168.1.10 1111 typ host', sdpMid: '0', sdpMLineIndex: 0 },
        { candidate: 'candidate:2 1 UDP 1686052863 203.0.113.5 2222 typ srflx', sdpMid: '0', sdpMLineIndex: 0 },
      ],
    });
    const decoded = decodeSignaling(encodeSignaling(data));
    expect(decoded.ice).toHaveLength(2);
    expect(decoded.ice[0].candidate).toContain('192.168.1.10');
    expect(decoded.ice[1].candidate).toContain('203.0.113.5');
  });

  it('drops candidates decodeSignaling cannot parse, without throwing', () => {
    const data = makeData({
      ice: [
        { candidate: 'not a valid candidate string', sdpMid: '0', sdpMLineIndex: 0 },
      ],
    });
    const decoded = decodeSignaling(encodeSignaling(data));
    expect(decoded.ice).toHaveLength(0);
  });

  it('throws for an unrecognized blob prefix', () => {
    expect(() => decodeSignaling('FS1:abc')).toThrow('Unknown signaling format');
  });

  it('throws a descriptive error when the blob is truncated mid-field', () => {
    // Encode a valid blob, then chop it to simulate a truncated transmission.
    const blob = encodeSignaling(makeData());
    const prefix = 'FS3:';
    // Slice off the last 20 base64 characters so candidate fields are incomplete.
    const truncated = prefix + blob.slice(prefix.length, -20);
    expect(() => decodeSignaling(truncated)).toThrow('Truncated signaling blob');
  });

  it('preserves sha-384 fingerprint (48 bytes) across a round-trip', () => {
    const FP384 = Array.from({ length: 48 }, (_, i) => (i * 11 % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
    const data = makeData({
      sdp: SDP_TEMPLATE('4zPa', 'pwd12345678901234567890', FP384, 'actpass').replace('sha-256', 'sha-384'),
    });
    const decoded = decodeSignaling(encodeSignaling(data));
    expect(decoded.sdp).toContain(`a=fingerprint:sha-384 ${FP384}`);
  });

  it('preserves sha-512 fingerprint (64 bytes) across a round-trip', () => {
    const FP512 = Array.from({ length: 64 }, (_, i) => (i * 13 % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
    const data = makeData({
      sdp: SDP_TEMPLATE('4zPa', 'pwd12345678901234567890', FP512, 'actpass').replace('sha-256', 'sha-512'),
    });
    const decoded = decodeSignaling(encodeSignaling(data));
    expect(decoded.sdp).toContain(`a=fingerprint:sha-512 ${FP512}`);
  });
});

// these fields go straight into the SDP we rebuild, or into the connection map key
describe('decodeSignaling input checks', () => {
  it('rejects a peerId that is not a FairShare id', () => {
    expect(() => decodeSignaling(encodeSignaling(makeData({ peerId: '../../evil' })))).toThrow('Invalid peer id');
  });

  it('rejects a CR/LF smuggled into the ICE password', () => {
    const sdp = SDP_TEMPLATE('4zPa', 'pwd12345678901234567890', FINGERPRINT, 'actpass')
      .replace('a=ice-pwd:pwd12345678901234567890', 'a=ice-pwd:pwd1234567890123456789\ra=x');
    expect(() => decodeSignaling(encodeSignaling(makeData({ sdp })))).toThrow();
  });

  it('rejects more than 8 candidates', () => {
    const ice = Array.from({ length: 9 }, (_, i) => ({
      candidate: `candidate:1 1 UDP 2122252543 192.168.1.${i + 1} 1111 typ host`, sdpMid: '0', sdpMLineIndex: 0,
    }));
    expect(() => decodeSignaling(encodeSignaling(makeData({ ice })))).toThrow('Too many ICE candidates');
  });
});

describe('estimateBlobSize', () => {
  it('reports byte length and whether it fits the ~400 byte QR threshold', () => {
    const small = estimateBlobSize('FS2:short');
    expect(small.bytes).toBe(9);
    expect(small.fitsQR).toBe(true);

    const large = estimateBlobSize('FS2:' + 'x'.repeat(500));
    expect(large.bytes).toBe(504);
    expect(large.fitsQR).toBe(false);
  });
});
