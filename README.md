# MixCrtQ

MixCrtQ turns the laptops in a meeting room into a single automixed room microphone for a hybrid meeting. Everyone connects to one website. People in the room enter a room code and their name, and their laptop becomes a microphone. Remote people enter a listening code and hear the room. The mixing is done on the server, and the person running the meeting has a controller view with a level meter and controls for every speaker.

Remote people speak back through the ordinary meeting (Teams, Zoom or Meet), which one laptop in the room plays through the loudspeaker. This is a proof of concept with no echo canceller: the room feed is silenced while a remote person speaks.

## The arrangement

| Direction | Path |
| --- | --- |
| Room to remote | Laptop microphones, mixer on the server, listening page |
| Remote to room | The meeting client, played through a loudspeaker in the room |

No laptop in the room carries the meeting's audio. Each room laptop sends one stream to the server; the server selects the microphone nearest the current talker and sends the mix to each listener. The controller is a view: closing it does not stop the room, and a second device can open it again.

One laptop in the room joins the meeting with its microphone muted, so that remote speakers are heard. That same laptop normally runs the controller, because the controller can listen to the laptop's system sound and tell the mixer when a remote person is speaking. Only that yes-or-no signal leaves the laptop. The mixer mutes the feed for as long as remote speech continues and for 0.6 seconds afterwards; without this, each remote speaker would hear themselves returned through the room microphones. A button mutes the feed by hand as well.

Two consequences follow. The meeting's own recording and transcript contain the remote speakers and none of the room. Room audio and any meeting video of the room are not synchronised.

## How it works

The mixer is browser code (Web Audio and WebRTC). The server runs it in a headless Chromium, one page per room, and restarts it if it dies. Because the server has a public address, room laptops and listeners connect to it directly, so a venue network that isolates its clients from each other is not an obstacle.

The automixer is gated selection, not summation. Each channel is scored by how far its level stands above its own tracked noise floor, so differences in microphone gain between laptops do not bias the choice, and a challenger must lead the live channel by a margin for a minimum time before it takes over. Closed microphones are held at a reduced level, since laptops on independent clocks cannot be combined coherently.

Each room has two codes. The room code admits microphones; the listening code admits listeners, who receive audio and send none. A listener is never shown the room code.

## Installing

Requires Node 18 or later and a Linux server with about 1 GB of free memory.

```
npm install
export PLAYWRIGHT_BROWSERS_PATH=/opt/mixcrtq/browsers
npx playwright install --with-deps chromium     # needs root, for system libraries
npm start                                       # listens on 127.0.0.1:8080
npm test
```

Set `PLAYWRIGHT_BROWSERS_PATH` to the same value when installing and when running, so that the service user finds the browser. To use a Chromium that is already installed, set `CHROMIUM_PATH` to its executable instead.

Browsers only allow microphone capture on HTTPS, so put the server behind a TLS proxy. With Caddy:

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
Environment=PLAYWRIGHT_BROWSERS_PATH=/opt/mixcrtq/browsers
Environment=HOST_KEY=choose-a-phrase
Restart=always
User=mixcrtq

[Install]
WantedBy=multi-user.target
```

Audio arrives at the server over UDP on ports the browser chooses. If the server has a firewall, allow inbound UDP on the ephemeral range (32768 to 60999 on Linux by default).

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Listening port |
| `HOST` | `127.0.0.1` | Bind address; the mixer connects to the server on 127.0.0.1 |
| `HOST_KEY` | none | If set, this phrase is required to start a room. Set it on any public server |
| `MAX_ROOMS` | `3` | Rooms that may run at once (each has a mixer page) |
| `MAX_PARTICIPANTS` | `32` | Microphones per room |
| `MAX_LISTENERS` | `20` | Remote listeners per room |
| `IDLE_MS` | `1800000` | An empty room with no controller is closed after this long |
| `CHROMIUM_PATH` | none | Use this Chromium executable for the mixer |
| `TURN_URLS` | none | Comma-separated TURN URLs; with `TURN_SECRET`, enables the relay (see below) |
| `TURN_SECRET` | none | The secret shared with coturn (`static-auth-secret`) |
| `TURN_TTL` | `86400` | Lifetime in seconds of the issued relay credentials |
| `ICE_POLICY` | `all` | Set to `relay` to force every connection through the relay |
| `ICE_SERVERS` | Google public STUN | JSON array of ICE servers, used only when `TURN_URLS` is not set |

## Running a meeting

1. On the laptop that will play the meeting into the room, open `/host` in Chrome or Edge and start a room.
2. Join the meeting on that laptop with its microphone muted and its speaker on the room loudspeaker.
3. Click "Mute automatically from meeting audio". In the sharing dialogue choose the entire screen and tick the system audio box. A meter appears showing the meeting audio the laptop can hear; it should move when a remote person speaks.
4. Give the room code or join link to everyone in the room, and the listening link to the remote people.

Nothing needs installing on any laptop.

The controller shows one strip per speaker with a level meter (the blue line marks that channel's speech threshold), a gain fader, Mute, Pin (hold open regardless of the automixer) and Remove, together with the list of remote listeners and whether the feed is live or muted. Each person in the room sees a lamp that reads LIVE while the room is listening through their microphone.

Rules for the day:

- People in the room mute their laptop speakers.
- Someone in the room who also opens the meeting itself (for video or screen sharing) keeps microphone and speaker off there.
- Remote people keep the meeting open for speaking and for hearing each other, and the listening page open for hearing the room. They wear headphones when they unmute.

## Venues that block UDP

A venue network that isolates its clients is not a problem, because every laptop talks to the server and not to its neighbours. A network that passes only web traffic is: audio then has to travel through a TURN relay over TLS. MixCrtQ issues short-lived relay credentials itself, so the only extra component is [coturn](https://github.com/coturn/coturn), which can run on the same server.

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

Restrictive networks pass only ports 80 and 443. The dependable arrangement is coturn's TLS listener on port 443, which needs an address of its own because Caddy already holds 443 on the web host: a second IP address, or a separate small server. Use `turns:turn.example.org:443?transport=tcp` in that case.

To rehearse this from any network, add `?relay=1` to the controller address. The join and listening links then carry it too, every laptop is forced through the relay, and each connection reads "via relay" on the controller.

## Known limits

- No echo cancellation. The feed is muted while meeting audio is present and for 0.6 seconds afterwards, so a remote speaker cannot hear the room interject, and anything the meeting plays (including notification sounds) mutes the feed.
- Automatic muting depends on Chrome's system audio capture on Windows. It has been tested only with a substitute signal, not with a real meeting client.
- Everything has been exercised on one machine with simulated microphones: three microphones and two listeners. Real acoustics, real networks and twenty microphones are untested, as is the mixer's processor load at that size.
- The relay path is covered by a unit test for credential issue only; it has not been run against a live coturn.
- Selection is tuned for one talker at a time. Overlapping speech, laughter and a laptop beside a noise source will show its edges; the threshold, margin and closed-microphone level sliders are there for this.
- If the mixer's browser dies, the server restarts it and people reconnect within a few seconds, with a gap in the audio. Fader and mute settings return to their defaults.
- The controller should be Chrome or Edge. Room and listening pages have been exercised in Chromium only; Safari and iOS are untested.
- The room code and the listening code are the only access control for participants.

## Layout

```
server.js                     pages, signalling, room lifecycle
engine.js                     runs each room's mixer in a headless Chromium
public/mixer.html, mixer.js   the mixer engine (loaded only by the server)
public/host.html, host.js     controller view
public/index.html, join.js    room participant page (name and room code)
public/listen.html, listen.js remote listener page (name and listening code)
public/automix.js             selection logic, free of Web Audio so it can be unit tested
public/meter-worklet.js       level metering on the audio thread
public/rtc-config.js          ICE and relay configuration shared by the pages
test/                         automixer and server tests
```
