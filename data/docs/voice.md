# Voice calls

The `voice` preset gives you a Rocket.Chat workspace where Voice calling works, with two test
users ready to call each other. You can add a PBX to it (a phone system with desk phones, ring
groups and an "outside world") and even connect a real phone.

> **Licence:** Voice needs a Rocket.Chat licence with the **Voice add-on** (`teams-voip`).
> Without it the workspace starts, but Rocket.Chat shows no call button. houston's own
> requirements are in the [README](../../README.md).

Rocket.Chat's side runs as Rocket.Chat ships it in
[rocketchat-compose](https://github.com/RocketChat/rocketchat-compose), set up as
[Configure Rocket.Chat Voice via SIP Integration](https://docs.rocket.chat/docs/configure-voice-via-sip-integration)
describes.

| Word | Meaning |
|---|---|
| **SIP integration** | Rocket.Chat's setting that sends calls through Drachtio and FreeSWITCH (SIP is how phone systems set up calls) |
| **VoIP domain** | `VOIP_DOMAIN` in rocketchat-compose: the address browsers and phones send call audio to |
| **RTP ports** | the UDP ports the call audio (RTP) travels on |
| **ICE servers** | Rocket.Chat's setting for the STUN/TURN servers that help audio through firewalls |
| **Extension** | a user's phone number inside Rocket.Chat: `1001` for voice-alice, `1002` for voice-bob |
| **PBX** | a company phone system. houston adds a test one (Asterisk) with fake desk phones and ring groups |
| **Dialplan** | a phone system's rules for what happens when a number is dialled |
| **Softphone** | a phone app on a computer or mobile, for example Linphone |

## Step 1: Pick what you want to test

| You want to test | Options to use |
|---|---|
| calls between Rocket.Chat users: ringing, audio, mute, hold, forward, screen share | `--preset voice` |
| also dialling numbers, and calls coming in from a PBX | `--preset voice --set sip_integration=on` |
| also a PBX: desk phones, ring groups, outside callers, a real phone | `--preset voice --set sip_integration=on --set pbx=on` |

The steps below use the last row; leave out what you do not need. The workspace is called
`voice-lab` on port `4460`, and `voice.lic` is the file with your licence text. The first row
also works on Kubernetes; the other two run on Docker only. To combine with other presets,
join the names with `+` and prefix the voice options: `--preset email+voice --set voice.sip_integration=on`.

## Step 2: Create the workspace

**On your own machine** (Linux or Mac), with the browser or phone on the same network:

```bash
houston up --version 8.8.1 --name voice-lab --preset voice --set sip_integration=on --set pbx=on \
  --set voip_domain=<this machine's IP> --license voice.lic --port 4460 --wait
```

`<this machine's IP>` is its address on your network, for example `192.168.1.20` (`ipconfig
getifaddr en0` on a Mac, `hostname -I` on Linux). The call audio goes to that address, and
houston opens the call ports on every address of the machine for it; Rocket.Chat's own port
stays on `localhost`. Without it only a browser on the same Linux machine hears anything.

**On a cloud machine** (EC2 or similar), with browsers and phones anywhere:

```bash
houston up --version 8.8.1 --name voice-lab --preset voice --set sip_integration=on --set pbx=on \
  --set voip_domain=<public IP> --domain <name pointing at it> --email <you@example.com> \
  --license voice.lic --wait
```

Allow these inbound in the security group. TCP 80 and 443 must be open to everyone: Let's
Encrypt proves the name on port 80. The rest can be limited to the addresses you test from:

| For | Protocol and ports |
|---|---|
| the browser, and the certificate | TCP 80 and 443 |
| browser audio to FreeSWITCH | UDP 20000 to 20046 (the `rtp_ports` range) |
| a phone to the PBX | UDP and TCP 5060, and UDP 30000 to 30019 |

In the steps below open `https://<name>` where they say `http://localhost:4460`, and take the
lab down when you are done: the phone accounts' passwords are their numbers.

If your licence is tied to a server address, add `--root-url https://<that address>` and still
open `http://localhost:4460`: Rocket.Chat checks the licence against the root address.

**In the GUI:** **Create a workspace** → **Docker** → tick **voice**, then **SIP integration**
and **PBX**; fill **VoIP domain** with the address and add the licence under **Enterprise
license**. On a cloud machine also pick **HTTPS → Let's Encrypt** with the domain and your
email.

**What you should see**, just before the notes:

```
  Voice test users ready: voice-alice, voice-bob (password = username)
  SIP: voice-alice has extension 1001, voice-bob 1002
✓ ready
```

If it says `could not give voice-alice, voice-bob their extensions`, the licence is not active
yet: apply it under **Administration → Subscription**, then run `houston ready --name voice-lab`.

## Step 3: Open Rocket.Chat and sign in

Open **`http://localhost:4460`**: the browser allows the microphone only on `localhost` or
HTTPS, and on any other plain `http://` address Rocket.Chat shows "Application Error". Sign in
as both test users in two browser profiles (a normal and a private window), with headphones on:

| Window | User | Password | Extension |
|---|---|---|---|
| 1 | `voice-alice` | `voice-alice` | 1001 |
| 2 | `voice-bob` | `voice-bob` | 1002 |

The admin account is in `houston info --name voice-lab`.

## Step 4: Make the test calls

In order; each adds one piece.

| # | What it tests | Do this | You should see or hear |
|---|---|---|---|
| 1 | a call between users | alice: open a direct message with bob, press the phone icon, **Call**. bob: **Accept** | both hear each other |
| 2 | Rocket.Chat reaching FreeSWITCH | alice: keypad icon, dial `123`, **Call** | answered at once, alice hears herself |
| 3 | an outside caller ringing a user | `docker exec houston-voice-lab-pbx-1 asterisk -rx "channel originate Local/1002@from-outside application Echo"` | bob sees **Incoming call… 0301234567**; after **Accept** he hears himself |
| 4 | a ring group, answered by bob | the same command with `Local/23000@from-outside`; bob accepts within 10 seconds | bob is connected, the desk phone (22101) stops ringing |
| 5 | a ring group nobody answers | the same command with `Local/23000@from-outside`; bob does nothing | after about 10 seconds the desk phone takes the call, bob stops ringing |
| 6 | a user calling outside | alice dials `5550000`, then `5550002`, then `5550001` | an echo / busy / ringing until it gives up after 30 seconds |
| 7 | a user calling a desk phone | alice dials `22101` | answered after 10 seconds, with an echo |
| 8 | forwarding a call | bob, in the call from test 3: **Forward**, pick **`1001`**, **Hang up and transfer call** | alice rings. Pick the number, not the name: by name Rocket.Chat sends `sip:<username>@…`, which FreeSWITCH's dialplans do not route, and the call ends |

If all eight work, Voice, the SIP integration and the PBX are working. Without the PBX
(`sip_integration=on` alone), FreeSWITCH can ring a user itself:
`docker exec houston-voice-lab-freeswitch-1 fs_cli -x 'originate {media_webrtc=true}sofia/internal/1002@drachtio &echo'`.

After a restart, give the PBX about 15 seconds. If dialling does nothing at all,
`houston restart --name voice-lab` reconnects Rocket.Chat to Drachtio.

## Step 5 (optional): Connect a real phone

The phone is on the same network as your machine, or anywhere if houston runs on a cloud
machine. Install a softphone (Linphone is free on iOS, Android, macOS and Windows) and add a
SIP account:

| Setting | Value |
|---|---|
| Username, password | `22001` (or `22002`, `22003`, `22004`), the same for both |
| Domain | this machine's IP address, the one in `voip_domain` |
| Transport | UDP |
| Publish presence | off |
| Local SIP port, if the app runs on this machine | random, not 5060 |

The account must show **Registered**; if it does not, UDP 5060 is closed from the phone's
network. On the phone, dial `1002` (just the number): bob rings in Rocket.Chat. In Rocket.Chat,
have alice dial `22001`: the phone rings, and you hear each other both ways. Then try `22101`
(rings 10 seconds, answers with an echo) and `23000` (the ring group).

## Step 6 (optional): Look inside

**Watch the calls.** This shows every SIP message between Drachtio, FreeSWITCH and the PBX as a
ladder. Start it in a second terminal, make a call, select it and press Enter:

```bash
docker run --rm -it --net=container:houston-voice-lab-freeswitch-1 --cap-add NET_RAW --cap-add NET_ADMIN \
  docker.io/library/alpine:3.24.2 sh -c 'apk add -q --no-cache sngrep && sngrep port 5060 or port 5080'
```

`INVITE` starts a call, `180 Ringing` means the far side rings, `200 OK` answered, `BYE` hung
up, `486` busy, `603` declined, `480` nobody to ring (usually a user without an extension). To
keep a capture, add `-v ~/.houston/repros/voice-lab/voice/captures:/work` to the command and run
`sngrep -N -O /work/call.pcap port 5060 or port 5080` instead; open it with `sngrep -I call.pcap`
or Wireshark.

**Change what the phone system does.** The PBX's numbers, phone accounts and ring groups are
plain files under `~/.houston/repros/voice-lab/voice/pbx/`: edit one and apply it with the
command in [Files you can edit](#files-you-can-edit). FreeSWITCH's own dialplans become files
too when you rebuild with `freeswitch_dialplans=edit` (repeat every other `--set`; the data is kept):

```bash
houston up --version 8.8.1 --name voice-lab --preset voice --set sip_integration=on --set pbx=on \
  --set freeswitch_dialplans=edit --license voice.lic --port 4460 --force --wait
```

For example, add `<action application="ring_ready"/>` just before the `bridge` line of the
`Local_Extension` block in `voice/freeswitch/public.xml`, then
`docker exec houston-voice-lab-freeswitch-1 fs_cli -x reloadxml` (if your editor replaces the
file, `docker restart houston-voice-lab-freeswitch-1` instead): callers now hear ringing at
once, and the ladder shows `180 Ringing`. Delete the file and run the same `up --force` to undo.

## Step 7: Clean up

```bash
houston down --name voice-lab --volumes --yes
```

## Reference

### Options

The same names in the GUI and on the command line, taken from Rocket.Chat's settings and
rocketchat-compose.

| `--set` | In the GUI | What it does | Default |
|---|---|---|---|
| `sip_integration=off\|on` | **SIP integration** | adds Drachtio and FreeSWITCH as rocketchat-compose runs them, turns on Rocket.Chat's **SIP integration enabled** setting, gives the test users extensions `1001` and `1002`. Docker only | `off` |
| `voip_domain=<address>` | **VoIP domain** | `VOIP_DOMAIN`: the address browsers and phones send RTP audio to, this machine's IP or a name that points straight at it (not a tunnel). Any address but `localhost` opens the call ports on every address of the machine | `freeswitch` (a browser on the same Linux machine only) |
| `rtp_ports=<start>-<end>` | **RTP ports** | the UDP ports for RTP audio (`VOIP_RTP_START_PORT` to `VOIP_RTP_END_PORT`), at most 200; a second SIP workspace needs its own range | `20000-20046` |
| `ice_servers=<list>` | **ICE servers** | Rocket.Chat's **ICE servers** setting: comma-separated `[user:password@]stun:host:port`, `turn:` or `turns:`. houston runs no TURN server | Rocket.Chat's own (Google STUN) |
| `pbx=off\|on` | **PBX** | adds the lab PBX (Asterisk), connected the way `compose.freeswitch.external.yml` connects external calls. Needs `sip_integration=on` | `off` |
| `freeswitch_dialplans=stock\|edit` | **FreeSWITCH dialplans** | gives you FreeSWITCH's dialplans as files to edit. Needs `pbx=on` | `stock` |

Any other Rocket.Chat setting goes on `up` as `--setting <Id>=<value>`; for example
`--setting VoIP_TeamCollab_SIP_Integration_For_Internal_Calls=true` sends calls between users
through the SIP integration too (by default Rocket.Chat calls its own users directly, so test 3,
not test 1, is the SIP path towards a user).

### PBX numbers

| Number | What it is |
|---|---|
| `1001`, `1002` | voice-alice, voice-bob. Any 4-digit number goes to Rocket.Chat |
| `22001`–`22004` | accounts for real phones; username = password = the number |
| `22101` | desk phone: rings 10 seconds, then answers with an echo |
| `22102` / `22103` / `22104` | desk phones: never answers / busy / answers at once |
| `23000` | ring group: 22101, 22001 and voice-bob, all at once |
| `23001` | ring group: 22102 and voice-bob |
| `5550000` / `5550001` / `5550002` | outside world: echo / rings forever / busy |
| any other number of 5 or more digits | rings 3 seconds, then answers with a tone |

### Files you can edit

In the workspace folder, `~/.houston/repros/<name>/` (or under `HOUSTON_HOME`). Edits are kept
across `up --force`, stop/start, upgrade and backups (`restore --new` brings them back);
`houston info` lists the files you changed; delete a file and run `up --force` for the original.
To try a customer's setup, paste their dialplan into the matching file and apply it.

| File | What it holds | Apply a change with |
|---|---|---|
| `voice/pbx/extensions.conf` | what each PBX number does | `docker exec houston-<name>-pbx-1 asterisk -rx "dialplan reload"` |
| `voice/pbx/pjsip.conf` | the link to FreeSWITCH, and the phone accounts | `docker exec houston-<name>-pbx-1 asterisk -rx "pjsip reload"` |
| `voice/pbx/rtp.conf` | the PBX's audio ports (keep them within 30000–30019) | `docker restart houston-<name>-pbx-1` |
| `voice/pbx/transports.conf` | the PBX's address, rewritten on every create from `voip_domain` | do not edit it |
| `voice/freeswitch/public.xml`, `drachtio.xml` (with `freeswitch_dialplans=edit`) | FreeSWITCH's dialplans, as it writes them itself | `docker exec houston-<name>-freeswitch-1 fs_cli -x reloadxml` |

### How it fits together

```
browser ─web──► Rocket.Chat ─:9022─► Drachtio ─SIP :5060─► FreeSWITCH (internal)
browser ◄═══ audio, UDP <voip_domain>:20000-20046 ═══════════► FreeSWITCH
                                                                 │
                                                      FreeSWITCH (external) :5080
                                                                 │
real phones ─SIP :5060─► pbx (Asterisk) ─┬─ desk phones 22101-22104
                                          ├─ ring groups 23000, 23001
                                          └─ outside world 555xxxx
```

- The ringing travels as SIP messages; the audio goes straight between the browser (or phone)
  and FreeSWITCH or the PBX, over UDP, to the address in `voip_domain`. A tunnel or web proxy
  carries the ringing, never the audio. Calls between users go browser to browser.
- With `voip_domain` set, houston opens only the call ports on every address of the machine:
  the RTP range, the PBX's 5060 and 30000–30019, weak phone accounts included. Rocket.Chat's
  own port and FreeSWITCH's 5080 stay on `localhost` unless you pass `--bind`. Docker only;
  one PBX lab per machine.
