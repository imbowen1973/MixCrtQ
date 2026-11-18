// Peer connection configuration, fetched from the server so that TURN
// credentials (which are short lived) are always fresh.
//
// Adding ?relay=1 to the page address forces all audio through the TURN
// relay. That reproduces, from any network, what happens on a venue network
// that isolates its clients, so the relay path can be tested in advance.

let cached = null;
let fetchedAt = 0;

export async function rtcConfig() {
  if (!cached || Date.now() - fetchedAt > 10 * 60 * 1000) {
    try {
      cached = await (await fetch('/config', { cache: 'no-store' })).json();
    } catch {
      cached = cached || { iceServers: [] };
    }
    fetchedAt = Date.now();
  }
  const forceRelay = new URLSearchParams(location.search).get('relay') === '1';
  return {
    iceServers: cached.iceServers || [],
    iceTransportPolicy: forceRelay || cached.iceTransportPolicy === 'relay' ? 'relay' : 'all',
  };
}

/** Resolves to 'relay' or 'direct' for a connected peer connection, or null. */
export async function pathOf(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    for (const r of stats.values()) {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
    }
    if (!pair) {
      for (const r of stats.values()) {
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
      }
    }
    if (!pair) return null;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    return local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
  } catch {
    return null;
  }
}
