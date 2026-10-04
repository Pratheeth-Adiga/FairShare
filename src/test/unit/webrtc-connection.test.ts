import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebRTCConnection } from '@/lib/p2p/webrtc-connection';

const peerConnections: MockPeerConnection[] = [];

class MockPeerConnection {
  signalingState: RTCSignalingState = 'stable';
  iceConnectionState: RTCIceConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  oniceconnectionstatechange: (() => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  onicecandidateerror: ((event: Event) => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  createDataChannel = vi.fn();
  close = vi.fn(() => { this.signalingState = 'closed'; });
}

describe('WebRTCConnection offer lifecycle', () => {
  afterEach(() => {
    peerConnections.length = 0;
    vi.unstubAllGlobals();
  });

  it('rejects a new offer before touching a peer connection that was closed', async () => {
    vi.stubGlobal('RTCPeerConnection', class extends MockPeerConnection {
      constructor() {
        super();
        peerConnections.push(this);
      }
    });

    const connection = new WebRTCConnection('local-peer', 'remote-peer');
    connection.close();

    await expect(connection.createOffer('group-1'))
      .rejects.toThrow('Connection was closed before negotiation could start');
    expect(peerConnections[0].createDataChannel).not.toHaveBeenCalled();
  });
});