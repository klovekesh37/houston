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
also works on Kubernetes; the other two run on Docker only.

**With other presets**, join the names with `+` and put `voice.` in front of its options:

```bash
houston up --version 8.8.1 --name voice-lab --preset email+voice --set voice.sip_integration=on --set voice.pbx=on \
  --license voice.lic --port 4460 --wait
```

With `email`, the test users are asked for a sign-in code: it is in Mailpit at
`http://localhost:8025`. Only one workspace with the PBX can run on a machine at a time.

## Step 2: Create the workspace

**A. Linux, with the browser on the same machine:**

```bash
houston up --version 8.8.1 --name voice-lab --preset voice --set sip_integration=on --set pbx=on \
  --license voice.lic --port 4460 --wait
```

**B. A Mac, or a browser or phone on another device.** The audio needs this machine's network
address, and the ports opened on it:

```bash
houston up --version 8.8.1 --name voice-lab --preset voice --set sip_integration=on --set pbx=on \
  --set voip_domain=$(ipconfig getifaddr en0) --bind 0.0.0.0 --license voice.lic --port 4460 --wait
```

- On Linux, use `$(hostname -I | awk '{print $1}')` for the address. On a Mac,
  `ipconfig getifaddr en0` should print something like `192.168.1.20`; if it prints nothing
  (a cabled Mac), copy the address from System Settings → Network.
- On a Mac with Apple Silicon, first tick **Use Rosetta for x86_64/amd64 emulation** in Docker
  Desktop → **Settings → General**: Drachtio and FreeSWITCH exist only for Intel chips.

If your licence is tied to a server address, add `--root-url https://<that address>` and still
open `http://localhost:4460`: Rocket.Chat checks the licence against the root address.

**In the GUI:** **Create a workspace** → **Docker** → tick **voice**, then **SIP integration**
and **PBX**, and add the licence under **Enterprise license**. For B, fill **VoIP domain** with
this machine's address and set **Bind host** to `0.0.0.0` under **More options**.

**What you should see**, just before the notes:

```
  Voice test users ready: voice-alice, voice-bob (password = username)
  SIP: voice-alice has extension 1001, voice-bob 1002
✓ ready
```

If it says `could not give voice-alice, voice-bob their extensions`, the licence is not active
yet: apply it under **Administration → Subscription**, then run `houston ready --name voice-lab`.

## Step 3: Check that everything is up

| Check | Command | You should see |
|---|---|---|
| all five services run | `docker ps --format '{{.Names}}  {{.Status}}' \| grep voice-lab` | `rocketchat`, `mongodb`, `drachtio`, `freeswitch`, `pbx`, all `Up` |
| Rocket.Chat is connected to Drachtio | `docker logs houston-voice-lab-drachtio-1 2>&1 \| grep "Added client"` | at least one line once the licence is active; none with it active: `houston restart --name voice-lab` |
| the PBX knows FreeSWITCH | `docker exec houston-voice-lab-pbx-1 asterisk -rx "pjsip show identifies"` | `rocketchat/rocketchat` and a `Match:` line |

After any restart (`houston restart`, Docker Desktop, a reboot), give it about 15 seconds: the
PBX picks up FreeSWITCH's new address on its own.

## Step 4: Open Rocket.Chat and sign in

Open **`http://localhost:4460`**: the browser allows the microphone only on `localhost` or
HTTPS, and on any other plain `http://` address Rocket.Chat shows "Application Error". Sign in
as both test users in two browser profiles (a normal and a private window), with headphones on:

| Window | User | Password | Extension |
|---|---|---|---|
| 1 | `voice-alice` | `voice-alice` | 1001 |
| 2 | `voice-bob` | `voice-bob` | 1002 |

The admin account is in `houston info --name voice-lab`.

## Step 5: Make the test calls

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

## Step 6 (optional): Connect a real phone

Needs B in Step 2 and the phone on the same network. Install a softphone (Linphone is free on
iOS, Android, macOS and Windows) and add a SIP account:

| Setting | Value |
|---|---|
| Username, password | `22001` (or `22002`, `22003`, `22004`), the same for both |
| Domain | this machine's IP address, the one in `voip_domain` |
| Transport | UDP |
| Publish presence | off |
| Local SIP port, if the app runs on this machine | random, not 5060 |

On the phone, dial `1002` (just the number): bob rings in Rocket.Chat. In Rocket.Chat, have
alice dial `22001`: the phone rings, and you hear each other both ways.

## Step 7 (optional): Reproduce a PBX problem

To see what a customer sees, for example desk phones that stop ringing too early:

1. Rebuild the workspace so FreeSWITCH's dialplans become files you can edit. Repeat every
   `--set` you used (one `--set` replaces all the recorded ones); the data is kept.

   ```bash
   houston up --version 8.8.1 --name voice-lab --preset voice --set sip_integration=on --set pbx=on \
     --set freeswitch_dialplans=edit --license voice.lic --port 4460 --force --wait
   ```

2. In `~/.houston/repros/voice-lab/voice/freeswitch/public.xml`, add the line from the table
   just before the line containing `bridge` in the `Local_Extension` block.
3. Apply it: `docker exec houston-voice-lab-freeswitch-1 fs_cli -x reloadxml`. If your editor
   replaces the file (vim, `sed -i`), use `docker restart houston-voice-lab-freeswitch-1` instead.
4. Make the test call from the table. To undo, delete the file and run the same `up --force`.

| Problem | Line to add before `bridge` | Then make | You should see |
|---|---|---|---|
| desk phones in a ring group stop ringing as soon as the call reaches Rocket.Chat | `<action application="answer"/>` | test 5 | the desk phone stops at once while bob still rings |
| the caller hears no ringing tone | none: watch the call flow (Step 8) | test 3 | no `180 Ringing` before bob accepts |
| the same, fixed by FreeSWITCH sending the tone | `<action application="ring_ready"/>` | test 3 | `180 Ringing` at once |

## Step 8 (optional): Watch the call flow

Every SIP message Drachtio, FreeSWITCH and the PBX exchange, as a ladder. Start this in a
second terminal, make a call, select it and press Enter:

```bash
docker run --rm -it --net=container:houston-voice-lab-freeswitch-1 --cap-add NET_RAW --cap-add NET_ADMIN \
  docker.io/library/alpine:3.24.2 sh -c 'apk add -q --no-cache sngrep && sngrep port 5060 or port 5080'
```

| Message | Meaning |
|---|---|
| `INVITE` / `100 Trying` | a call is being set up / received |
| `180 Ringing` / `183` | the far side is ringing (Rocket.Chat 8.8.1 never sends one) |
| `200 OK`, then `ACK` | answered |
| `486 Busy Here` / `603 Decline` | busy / the user pressed Reject |
| `480 Temporarily Unavailable` | nobody to ring: usually a user without an extension |
| `BYE` | hung up |

- **Text traces instead:** `docker exec houston-voice-lab-pbx-1 asterisk -rx "pjsip set logger on"`
  (then `docker logs houston-voice-lab-pbx-1`), and
  `docker exec houston-voice-lab-freeswitch-1 fs_cli -x "sofia profile external siptrace on"`.
- **Saving a capture for a ticket:** add `-v ~/.houston/repros/voice-lab/voice/captures:/work`
  to the command and run `sngrep -N -O /work/call.pcap port 5060 or port 5080` instead (Ctrl-C
  stops it). Open it with `sngrep -I call.pcap` or Wireshark → Telephony → VoIP Calls.

## Step 9: Clean up

```bash
houston down --name voice-lab --volumes --yes
```

## If something does not work

| You see | Why, and what to do |
|---|---|
| no phone icon, no call button | the licence is missing, has no Voice add-on, or is tied to another address: check **Administration → Subscription**, use `--root-url` with the licensed address |
| "Application Error — The application GUI just crashed" | the page is on plain `http://` away from localhost: open `http://localhost:4460` |
| the test users cannot sign in ("TOTP required") | email two-factor is on: add `--preset email` and read the code in Mailpit, or turn it off |
| tests 3–5, or calls from a real phone, fail at once | the test users have no extensions: `houston ready --name voice-lab` must print `SIP: voice-alice has extension 1001…` |
| alice's calls to the PBX end after a second, just after a restart | the PBX has not picked up FreeSWITCH's new address: wait 15 seconds; if it persists, `docker exec houston-voice-lab-pbx-1 asterisk -rx "pjsip reload"` |
| test 2 is answered but keeps "ringing", then ends after about 10 seconds | the audio cannot reach the browser: use B in Step 2. Through a tunnel or web proxy, calls ring but carry no audio |
| calls to and from the PBX connect but are silent | `voip_domain` is set but the ports are open only on this machine: add `--bind 0.0.0.0` |
| the phone app says "wrong username or password" although it registered | the call failed further on, usually missing extensions: fix them, and turn **Publish presence** off |
| test 2 does nothing, and Step 3 shows no `Added client` | Rocket.Chat connects to Drachtio only when it starts, and lost it (Drachtio restarted, or SIP integration was switched off and on): `houston restart --name voice-lab` |
| `preset 'voice' publishes port(s) …, already claimed by repro '…'` | another SIP workspace uses the ports: add `--set rtp_ports=21000-21046`. Only one PBX lab runs per machine |
| `houston` says the preset or an option is unknown | an older houston: 2.1.4 or later has these names (2.1.3 has the preset, under `sip` and `fs_dialplan`); update it as the [README](../../README.md) says |

## Reference

### Options

The same names in the GUI and on the command line, taken from Rocket.Chat's settings and
rocketchat-compose. houston 2.1.3 spelled two of them `sip` and `fs_dialplan`; those still work
in commands, workspace records and backups.

| `--set` | In the GUI | What it does | Default |
|---|---|---|---|
| `sip_integration=off\|on` | **SIP integration** | adds Drachtio and FreeSWITCH as rocketchat-compose runs them, turns on Rocket.Chat's **SIP integration enabled** setting, gives the test users extensions `1001` and `1002`. Docker only | `off` |
| `voip_domain=<address>` | **VoIP domain** | `VOIP_DOMAIN`: the address browsers and phones send RTP audio to, this machine's IP or a name that points straight at it (not a tunnel). Use with `--bind 0.0.0.0` | `freeswitch` (a browser on the same Linux machine only) |
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
To replay a customer's setup, paste their dialplan into the matching file, apply it, make the
same call, and compare the call flow.

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
  carries the ringing, never the audio. Calls between users go browser to browser and need none
  of this.
- By default everything is published on this machine only (`127.0.0.1`): the RTP ports, the
  PBX's 5060 and 30000–30019, FreeSWITCH's 5080. `--bind 0.0.0.0` opens them on your network,
  weak phone accounts included, and `up` warns you. On Docker Desktop (a Mac) the services'
  own addresses cannot be reached from the Mac, hence B in Step 2 even for a browser on the Mac.
- Limits: Docker only; one PBX lab per machine; on Apple Silicon two services run emulated.
