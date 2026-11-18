# MixCrtQ

MixCrtQ turns the laptops in a meeting room into a single automixed room microphone for a hybrid meeting. Each person in the room opens a web page and enters a room code and their name; their laptop microphone is sent over WebRTC to one host laptop, which selects the microphone nearest the current talker. Remote people hear that mix on a listening page, and speak back through the ordinary meeting (Teams, Zoom or Meet), which the host laptop plays into the room.

This is a proof of concept. It contains no echo canceller: the room feed is silenced while a remote person speaks, which makes the conversation half duplex across the room boundary.

## The arrangement

| Direction | Path |
| --- | --- |
| Room to remote | Laptop microphones, host automixer, listening page |
| Remote to room | The meeting client, played through the host laptop's loudspeaker |

The host laptop joins the meeting with its microphone muted, so the meeting carries remote voices only. When a remote person speaks, the room microphones hear them from the loudspeaker; the mixer therefore mutes the feed for as long as meeting audio is present, either automatically (it listens to the host's system audio) or by hand with the "remote speaker on air" button. Remote people who speak wear headphones, so that the listening page is not picked up by their own meeting microphone.

Two consequences follow. The meeting's own recording and transcript contain the remote speakers and none of the room. Room audio and any meeting video of the room are not synchronised.

The mix can instead be sent to a virtual audio cable and used as the meeting's microphone (see "Virtual cable mode"); the two modes share everything on the room side.

## How it works

The server only serves the pages and relays signalling; audio flows peer to peer from each participant to the host. The host page runs a gated automixer on the audio clock. Each channel is scored by how far its level stands above its own tracked noise floor, so differences in microphone gain between laptops do not bias the choice, and a challenger must lead the live channel by a margin for a minimum time before it takes over. Closed microphones are held at a reduced level instead of being summed, since laptops on independent clocks cannot be combined coherently.

The mixer deck shows one strip per speaker with a level meter (the blue line marks that channel's speech threshold), a gain fader, Mute, Pin (hold open regardless of the automixer) and Remove. Each participant sees a lamp that reads LIVE while the room is listening through their microphone. The deck also lists the remote listeners and shows whether the feed is live or muted.

Each room has two codes. The room code admits microphones; the listening code admits listeners, who receive audio and send none. A listener is never shown the room code. The host sends the mix to each listener over its own connection, which is sound for a small audience (the default limit is 20) and would need a forwarding server beyond that.

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
| `TURN_URLS` | none | Comma-separated TURN URLs; with `TURN_SECRET`, enables the relay (see below) |
| `TURN_SECRET` | none | The secret shared with coturn (`static-auth-secret`) |
| `TURN_TTL` | `86400` | Lifetime in seconds of the issued relay credentials |
| `ICE_POLICY` | `all` | Set to `relay` to force every connection through the relay |
| `ICE_SERVERS` | Google public STUN | JSON array of ICE servers, used only when `TURN_URLS` is not set |
| `MAX_PARTICIPANTS` | `32` | Microphones per room |
| `MAX_LISTENERS` | `20` | Remote listeners per room |
| `HOST_GRACE_MS` | `60000` | How long a room survives without its host |

## Venues that isolate their clients

Hotel, conference and other venue networks normally forbid laptops on the same network from reaching each other, so the direct path fails and participants stay at "connecting". The audio must then travel through a TURN relay on a server: each participant's audio goes out to the relay and back to the host. MixCrtQ issues short-lived relay credentials itself, so the only extra component is [coturn](https://github.com/coturn/coturn).

A starting `/etc/turnserver.conf` (not yet exercised against this code):

```
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=CHANGE-ME-TO-A-LONG-RANDOM-STRING
realm=turn.example.org
cert=/etc/coturn/fullchain.pem
pkey=/etc/coturn/privkey.pem
min-port=49160
max-port=49260
no-multicast-peers
no-cli
# external-ip=PUBLIC/PRIVATE   (only if the server sits behind NAT)
```

Then start MixCrtQ with the matching settings:

```
TURN_URLS="turn:turn.example.org:3478?transport=udp,turns:turn.example.org:5349?transport=tcp" \
TURN_SECRET="CHANGE-ME-TO-A-LONG-RANDOM-STRING" npm start
```

Open UDP and TCP 3478, TCP 5349 and UDP 49160 to 49260 on the server's firewall.

Three points decide whether this works in a given venue:

- **Ports.** Restrictive guest networks pass only 80 and 443. The dependable arrangement is coturn's TLS listener on port 443, which needs an address of its own because Caddy already holds 443 on the web host: a second IP address, or a separate small server. Use `turns:turn.example.org:443?transport=tcp` in that case.
- **Distance.** Every packet makes a round trip to the relay, so place it close to the venue. That added delay widens the echo problem at the far end.
- **Testing in advance.** Add `?relay=1` to the host address (the join link then carries it too) to force all audio through the relay from any network. A strip that connects in this mode reads "via relay". Do this before travelling: it reproduces the venue's conditions at home.

## Setting up the host laptop (Windows)

1. Open `/host` in Chrome or Edge and start a room. Allow microphone access (needed only so that devices can be listed by name).
2. Join the meeting on the same laptop with its microphone muted and its speaker on the room loudspeaker.
3. Click "Mute automatically from meeting audio". In the sharing dialogue choose the entire screen and tick the system audio box. Only the sound is used. A meter appears showing the meeting audio the mixer can hear; it should move when a remote person speaks.
4. Give the room code or join link to everyone in the room, and the listening link to the remote people.

Nothing needs installing in this mode.

## Rules

- People in the room mute their laptop speakers. Only the host laptop plays the remote side.
- Someone in the room who also opens the meeting itself (for video or screen sharing) keeps microphone and speaker off there.
- Remote people keep the meeting open for speaking and for hearing each other, and the listening page open for hearing the room. They wear headphones when they unmute.
- The host laptop's own microphone is off by default, because it sits beside the loudspeaker.

## Virtual cable mode

To feed the mix into the meeting as its microphone instead of using the listening page: install [VB-CABLE](https://vb-audio.com/Cable/) on the host, choose **CABLE Input** as the mixer output device, and choose **CABLE Output** as the meeting's microphone. The test tone button confirms the path. In this mode the meeting client's echo handling has to cope with a microphone that arrives late and through a changing path, which is untested.

## Known limits

- No echo cancellation. The feed is muted while meeting audio is present and for 0.6 seconds afterwards, so a remote speaker cannot hear the room interject, and anything the meeting plays (including notification sounds) mutes the feed.
- Automatic muting depends on Chrome's system audio capture on Windows. It has been tested only with a substitute signal, not with a real meeting client.
- Selection is tuned for one talker at a time. Overlapping speech, laughter and a laptop beside a noise source will show its edges; the threshold, margin and closed-microphone level sliders are there for this.
- Networks with client isolation block the peer to peer path and need the relay described above. The relay code path is covered by a unit test for credential issue only; it has not been run against a live coturn.
- The host should be Chrome or Edge. Participants have been exercised in Chromium only; Safari and iOS are untested.
- A signalling drop on a participant's side rebuilds that participant's audio connection, with a gap of a few seconds.
- The session code is the only access control.

## Extension points

The host page exposes `window.mixcrtq`:

- `setReferenceStream(stream)` accepts the far-end audio and mutes the room mix while it is active (`reference.thresholdDb`, `reference.duckDb`, `reference.holdMs`). The "mute automatically" button calls it with the captured system audio.
- `mixStream` is the room mix as a `MediaStream`: the stream sent to listeners, and the place to attach a recorder or a forwarding server.

## Layout

```
server.js                 static files and WebSocket signalling
public/index.html, join.js    room participant page (name and room code)
public/listen.html, listen.js remote listener page (name and listening code)
public/host.html, host.js     mixer deck
public/rtc-config.js          ICE and relay configuration shared by the pages
public/automix.js             selection logic, free of Web Audio so it can be unit tested
public/meter-worklet.js       level metering on the audio thread
test/                         automixer and signalling tests
```
