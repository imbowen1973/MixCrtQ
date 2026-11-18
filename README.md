# MixCrtQ

MixCrtQ turns the laptops in a meeting room into a single automixed room microphone for a hybrid call. Each person in the room opens a web page and enters a session code and their name; their laptop microphone is sent over WebRTC to one host laptop, which selects the microphone nearest the current talker and presents the result to Teams, Zoom or Meet as an ordinary microphone through a virtual audio cable. Because the room appears to the meeting as one participant, the feedback loop between co-located laptops cannot form.

This is a proof of concept. It answers one question: whether the conferencing client's own echo handling tolerates a microphone that arrives through a network hop. It does not yet contain an echo canceller.

## How it works

The server only serves the pages and relays signalling; audio flows peer to peer from each participant to the host. The host page runs a gated automixer on the audio clock. Each channel is scored by how far its level stands above its own tracked noise floor, so differences in microphone gain between laptops do not bias the choice, and a challenger must lead the live channel by a margin for a minimum time before it takes over. Closed microphones are held at a reduced level instead of being summed, since laptops on independent clocks cannot be combined coherently.

The mixer deck shows one strip per speaker with a level meter (the blue line marks that channel's speech threshold), a gain fader, Mute, Pin (hold open regardless of the automixer) and Remove. Each participant sees a lamp that reads LIVE while the room is listening through their microphone.

## Running it

Requires Node 18 or later.

```
npm install
npm start          # listens on 127.0.0.1:8080
npm test
```

Browsers only allow microphone capture on HTTPS, so put it behind a TLS proxy. With Caddy:

```
mix.example.org {
    reverse_proxy 127.0.0.1:8080
}
```

A minimal systemd unit:

```
[Unit]
Description=MixCrtQ
After=network.target

[Service]
WorkingDirectory=/opt/mixcrtq
ExecStart=/usr/bin/node server.js
Environment=PORT=8080
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Listening port |
| `HOST` | `127.0.0.1` | Bind address |
| `ICE_SERVERS` | Google public STUN | JSON array of ICE servers; add a TURN server here for networks with client isolation |
| `MAX_PARTICIPANTS` | `16` | Participants per room |
| `HOST_GRACE_MS` | `60000` | How long a room survives without its host |

## Setting up the host laptop (Windows)

1. Install [VB-CABLE](https://vb-audio.com/Cable/) once (administrator rights needed) and restart.
2. Open `/host` in Chrome or Edge, start a room, and allow microphone access (needed only so that devices can be listed by name).
3. Under "Mixer output device" choose **CABLE Input (VB-Audio Virtual Cable)**. The mix stays silent until an output is chosen, and the page warns if the choice does not look like a cable.
4. In Teams, set the microphone to **CABLE Output (VB-Audio Virtual Cable)** and leave the speaker on the laptop speakers or room loudspeaker.
5. Use "Send a two second test tone" and check that Teams' microphone meter moves.
6. Give the six character session code, or the join link, to everyone in the room.

## Rules for the room

- Participants mute their laptop speakers. Only the host laptop plays the remote side.
- A participant who also opens the meeting itself (for video or screen sharing) keeps microphone and speaker off there.
- The host laptop's own microphone is off by default, because it sits beside the loudspeaker carrying the remote participants.

## Known limits

- No echo cancellation. Remote voices leaving the host's loudspeaker reach the room microphones, and the conferencing client sees that echo late and through a changing path. Teams' residual suppressor may cope; if it does not, the next step is ducking from a far-end reference (below).
- Selection is tuned for one talker at a time. Overlapping speech, laughter and a laptop beside a noise source will show its edges; the threshold, margin and closed-microphone level sliders are there for this.
- Networks with client isolation (eduroam, hotels, many guest networks) block the peer to peer path. Supply a TURN server through `ICE_SERVERS`.
- The host should be Chrome or Edge. Participants have been exercised in Chromium only; Safari and iOS are untested.
- A signalling drop on a participant's side rebuilds that participant's audio connection, with a gap of a few seconds.
- The session code is the only access control.

## Extension points

The host page exposes `window.mixcrtq`:

- `setReferenceStream(stream)` accepts the far-end audio and ducks the room mix while the remote side speaks (`reference.thresholdDb`, `reference.duckDb`, `reference.holdMs`). Today the stream would be a loopback capture of the conferencing client's output; in an all-WebRTC design it would be the remote participants' audio.
- `mixStream` is the room mix as a `MediaStream`, for a sink other than the virtual cable (a remote WebRTC link, or an Azure Communication Services call into a Teams meeting).

## Layout

```
server.js                 static files and WebSocket signalling
public/index.html, join.js    participant page (name and session code)
public/host.html, host.js     mixer deck
public/automix.js             selection logic, free of Web Audio so it can be unit tested
public/meter-worklet.js       level metering on the audio thread
test/                         automixer and signalling tests
```
