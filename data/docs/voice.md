# Voice calls

The `voice` preset gives you a Rocket.Chat workspace where Voice calling works, with two test
users ready to call each other. You can add a phone system to it, with desk phones, ring
groups and an "outside world", and even connect a real phone, to see how Rocket.Chat behaves
with one.

> **Licence:** Voice needs a Rocket.Chat licence that includes the **Voice add-on**
> (`teams-voip`). Without it the workspace starts, but Rocket.Chat shows no call button.
> The `voice` preset is in houston 2.1.3 and later. houston's own requirements (Docker,
> Node.js) are in the [README](../../README.md).

Everything on the Rocket.Chat side runs as Rocket.Chat ships it in
[rocketchat-compose](https://github.com/RocketChat/rocketchat-compose), configured as
[Configure Rocket.Chat Voice via SIP Integration](https://docs.rocket.chat/docs/configure-voice-via-sip-integration)
describes.

## Words used here

| Word | Meaning |
|---|---|
| **SIP** | the standard way phone systems set up calls: "call 1002", "it's ringing", "answered", "hung up" |
| **Extension** | a user's phone number inside Rocket.Chat: here `1001` for voice-alice and `1002` for voice-bob |
| **PBX** | a company phone system. houston adds a test one with fake desk phones and ring groups |
| **Softphone** | a phone app on a computer or mobile (for example Linphone) |
| **Dialplan** | a phone system's rules for what happens when a number is dialled |

## Step 1: Pick what you want to test

| You want to test | Options to use |
|---|---|
| calls between Rocket.Chat users: ringing, audio, mute, hold, forward, screen share | `--preset voice` |
| also dialling numbers, and calls coming in from a phone system | `--preset voice --set sip=on` |
| also a company phone system: desk phones, ring groups, outside callers, a real phone | `--preset voice --set sip=on --set pbx=on` |

The steps below use the full set, the last row. Leave out the options you do not need. The
workspace is called `voice-lab` and runs on port `4460`, and `voice.lic` stands for the file
that holds your licence text.

The first row also works on Kubernetes (`--runtime kubernetes`). `sip=on` and `pbx=on` run
on Docker only, and `up` refuses them on Kubernetes.

**Combining with other presets.** Voice, the phone system included, works together with the
other presets. Join the names with `+`, and put `voice.` in front of its options:

```bash
houston up --version 8.8.1 --name voice-lab --preset email+voice --set voice.sip=on --set voice.pbx=on \
  --license voice.lic --port 4460 --wait
```

The rest of this guide is the same, apart from the `voice.` prefix on its options. Only one
workspace with the phone system can run on a machine at a time. With `email`, Rocket.Chat asks
voice-alice and voice-bob for a code when they sign in: it is in Mailpit, at
`http://localhost:8025`.

## Step 2: Create the workspace

*Why:* this starts Rocket.Chat, the phone services and the test users in one go.

**A. Linux, with the browser on the same machine:**

```bash
houston up --version 8.8.1 --name voice-lab --preset voice --set sip=on --set pbx=on \
  --license voice.lic --port 4460 --wait
```

**B. A Mac, or a browser or phone on another device.** The audio needs this machine's network
address, and the ports opened on it.

- On a Mac with Apple Silicon, first open Docker Desktop → **Settings → General**, and tick
  **Use Rosetta for x86_64/amd64 emulation**. Two of the phone services exist only for Intel
  chips, and this lets them run.
- Then, on a Mac:

  ```bash
  houston up --version 8.8.1 --name voice-lab --preset voice --set sip=on --set pbx=on \
    --set voip_domain=$(ipconfig getifaddr en0) --bind 0.0.0.0 --license voice.lic --port 4460 --wait
  ```

- On Linux, use `$(hostname -I | awk '{print $1}')` in place of `$(ipconfig getifaddr en0)`.
- Check the address first. `ipconfig getifaddr en0` should print something like
  `192.168.1.20`. If it prints nothing (a Mac on a cable rather than Wi-Fi), copy the address
  from System Settings → Network instead.

**If your licence is tied to a server address**, add `--root-url https://<that address>`. You
still open the page at `http://localhost:4460`, because Rocket.Chat checks the licence against
that root address, not the one in your browser.

**In the GUI** instead: **Create a workspace** → **Docker** → tick **voice**, then **Phone
services** and **Phone system**, and add the licence under **Enterprise license**. For option
B, fill **Reached at** with this machine's address, and set **Bind host** to `0.0.0.0` under
**More options**.

**What you should see**, just before the notes it prints last:

```
  Voice test users ready: voice-alice, voice-bob (password = username)
  SIP: voice-alice has extension 1001, voice-bob 1002
✓ ready
```

**If you see `could not give voice-alice, voice-bob their extensions`**, the licence is not
active yet. Apply it in Rocket.Chat under **Administration → Subscription**, then run
`houston ready --name voice-lab`. It should then print the `SIP:` line above.

## Step 3: Check that everything is up

*Why:* if one piece is missing, the calls in Step 5 fail in confusing ways.

| Check | Command | You should see |
|---|---|---|
| all five services run | `docker ps --format '{{.Names}}  {{.Status}}' \| grep voice-lab` | `rocketchat`, `mongodb`, `drachtio`, `freeswitch` and `pbx`, all `Up` |
| Rocket.Chat is connected to the phone services | `docker logs houston-voice-lab-drachtio-1 2>&1 \| grep "Added client"` | at least one line, once the licence is active (none before). If there is none with the licence active, run `houston restart --name voice-lab` |
| the phone system knows FreeSWITCH | `docker exec houston-voice-lab-pbx-1 asterisk -rx "pjsip show identifies"` | `rocketchat/rocketchat` and a `Match:` line |

After a restart (`houston restart`, quitting Docker Desktop, rebooting), give it about 15
seconds. A restart can move FreeSWITCH to a new address, and the phone system notices and
picks it up on its own.

## Step 4: Open Rocket.Chat and sign in

Open **`http://localhost:4460`**. Use `localhost`: the browser allows the microphone only on
`localhost` or HTTPS, and on any other plain `http://` address Rocket.Chat shows
"Application Error".

Sign in as the two test users in two separate browser profiles, for example a normal window
and a private window:

| Window | User | Password | Extension |
|---|---|---|---|
| 1 | `voice-alice` | `voice-alice` | 1001 |
| 2 | `voice-bob` | `voice-bob` | 1002 |

Wear headphones, or the two windows feed back into each other. The admin account is in
`houston info --name voice-lab`.

## Step 5: Make the test calls

Do them in order. Each one adds one more piece.

| # | What it tests | Do this | You should see or hear |
|---|---|---|---|
| 1 | a call between users | alice: open a direct message with bob, press the phone icon, then **Call**. bob: **Accept** | both hear each other |
| 2 | Rocket.Chat reaching the phone services | alice: press the keypad icon, dial `123`, **Call** | it answers at once and alice hears herself |
| 3 | an outside caller ringing a user | run `docker exec houston-voice-lab-pbx-1 asterisk -rx "channel originate Local/1002@from-outside application Echo"` | bob sees **Incoming call… 0301234567**. After **Accept** he hears himself |
| 4 | a ring group, answered by bob | run the same command with `Local/23000@from-outside`. bob accepts within 10 seconds | bob is connected, and the desk phone (22101) stops ringing |
| 5 | a ring group nobody answers | run the same command with `Local/23000@from-outside`. bob does nothing | after about 10 seconds the desk phone takes the call, and bob stops ringing |
| 6 | a user calling outside | alice dials `5550000`, then `5550002`, then `5550001` | an echo / a busy signal / ringing until it gives up after 30 seconds |
| 7 | a user calling a desk phone | alice dials `22101` | it answers after 10 seconds, with an echo |
| 8 | forwarding a call | bob, during the call from test 3: **Forward**, pick **`1001`** from the list, then **Hang up and transfer call** | alice rings. Pick the number, not the name: by name the call does not reach her |

If all eight work, Voice, the phone services and the phone system are working.

## Step 6 (optional): Connect a real phone

*Why:* to call Rocket.Chat users from a real phone app, and have them call it. This needs
option B in Step 2, and the phone on the same network as this machine.

1. Install a softphone app. Linphone is free on iOS, Android, macOS and Windows.
2. Add a SIP account with these settings:

   | Setting | Value |
   |---|---|
   | Username | `22001` (or `22002`, `22003`, `22004`) |
   | Password | the same as the username |
   | Domain | this machine's IP address, the one in `voip_domain` |
   | Transport | UDP |
   | Publish presence | off |
   | Local SIP port, if the app runs on this same machine | random, not 5060 |

3. On the phone, dial `1002`. Dial just the number, not `1002@<address>`. bob rings in
   Rocket.Chat.
4. In Rocket.Chat, have alice dial `22001`. The phone rings. You hear each other both ways.

## Step 7 (optional): Reproduce a phone-system problem

*Why:* to see in the workspace what a customer sees, for example desk phones that stop ringing
too early.

1. Rebuild the workspace so FreeSWITCH's rules become a file you can edit. Repeat `--preset
   voice` and every `--set` you used. One `--set` replaces all the recorded ones, and the
   workspace's data is kept.

   ```bash
   houston up --version 8.8.1 --name voice-lab --preset voice --set sip=on --set pbx=on \
     --set fs_dialplan=edit --license voice.lic --port 4460 --force --wait
   ```

2. Open `~/.houston/repros/voice-lab/voice/freeswitch/public.xml`. In the `Local_Extension`
   block, add the line from the table just before the line containing `bridge`.
3. Apply the change: `docker exec houston-voice-lab-freeswitch-1 fs_cli -x reloadxml`
4. Make the test call from the table.

| Problem | Line to add before `bridge` | Then make | You should see |
|---|---|---|---|
| desk phones in a ring group stop ringing as soon as the call reaches Rocket.Chat | `<action application="answer"/>` | test 5 | the desk phone stops at once, while bob is still ringing |
| the caller hears no ringing tone | none: watch the call flow (Step 8) during test 3 | test 3 | no `180 Ringing` before bob accepts |
| the same, fixed by FreeSWITCH sending the tone | `<action application="ring_ready"/>` | test 3 | `180 Ringing` appears at once |

If your editor saves by replacing the file (vim and `sed -i` do), step 3 does not pick the
change up. Run `docker restart houston-voice-lab-freeswitch-1` instead. To undo your edits,
delete the file and run the same `up --force` again.

## Step 8 (optional): Watch the call flow

*Why:* to see every message the phone services exchange during a call, as a ladder diagram.
Start this in a second terminal, then make a call:

```bash
docker run --rm -it --net=container:houston-voice-lab-freeswitch-1 --cap-add NET_RAW --cap-add NET_ADMIN \
  docker.io/library/alpine:3.24.2 sh -c 'apk add -q --no-cache sngrep && sngrep port 5060 or port 5080'
```

Select a call and press Enter to see its ladder. What the common messages mean:

| Message | Meaning |
|---|---|
| `INVITE` | a call is being set up |
| `100 Trying` | received, working on it |
| `180 Ringing` / `183` | the far side is ringing (Rocket.Chat 8.8.1 never sends one) |
| `200 OK`, then `ACK` | answered |
| `486 Busy Here` | busy |
| `480 Temporarily Unavailable` | nobody to ring: usually a user without an extension |
| `603 Decline` | the user pressed Reject |
| `BYE` | hung up |

**Saving a capture for a ticket:**
- Add `-v ~/.houston/repros/voice-lab/voice/captures:/work` to the command, and run
  `sngrep -N -O /work/call.pcap port 5060 or port 5080` instead. Ctrl-C stops it.
- Open the file with `sngrep -I call.pcap`, or with Wireshark under Telephony → VoIP Calls →
  Flow Sequence.

## Step 9: Clean up

```bash
houston down --name voice-lab --volumes --yes
```

## If something does not work

| You see | Why | What to do |
|---|---|---|
| no phone icon, no call button | the licence is missing, has no Voice add-on, or is tied to another address | check **Administration → Subscription**; use `--root-url` with the licensed address |
| "Application Error — The application GUI just crashed" | the page is open on plain `http://` at an address other than localhost | open `http://localhost:4460` |
| the test users cannot sign in ("TOTP required") | email two-factor is on | add `--preset email` and read the code in Mailpit, or turn email two-factor off |
| tests 3–5, or calls from a real phone, fail at once | the test users have no extensions | `houston ready --name voice-lab`. It must print `SIP: voice-alice has extension 1001…` |
| alice's calls in tests 6–7, or to a real phone, end after a second, just after a restart | the phone system has not yet picked up FreeSWITCH's new address | wait 15 seconds and try again; if it persists, `docker exec houston-voice-lab-pbx-1 asterisk -rx "pjsip reload"` |
| test 2 is answered but keeps "ringing", then ends after about 10 seconds | the audio cannot reach the browser | use option B in Step 2. Through a tunnel or web proxy, calls ring but carry no audio |
| calls to and from the phone system connect but are silent | `voip_domain` is set, but the ports are open only on this machine | add `--bind 0.0.0.0` |
| the phone app says "wrong username or password", although it registered | the call failed further on, usually because of missing extensions | fix the extensions; turn **Publish presence** off in the app |
| test 2 does nothing, and Step 3 shows no `Added client` | Rocket.Chat lost its link to the phone services | `houston restart --name voice-lab` |
| `preset 'voice' publishes port(s) …, already claimed by repro '…'` | another voice workspace on this machine uses the same ports | add `--set rtp_ports=21000-21046` for a second SIP workspace. Only one phone-system lab can run per machine |
| `houston` says the preset or an option is unknown | an older houston | `houston --version` must be 2.1.3 or later; update it as the [README](../../README.md) says |

## Reference

### Options

| `--set` | What it does | Default |
|---|---|---|
| `sip=off\|on` | adds the phone services Drachtio and FreeSWITCH, turns on Rocket.Chat's **SIP Integration**, and gives the test users extensions `1001` and `1002`. Docker only | `off` |
| `voip_domain=<address>` | the address browsers and phones send call audio to: this machine's IP, or a name that points straight at it (not a tunnel). Use it with `--bind 0.0.0.0` | `freeswitch` (works only for a browser on the same Linux machine) |
| `rtp_ports=<start>-<end>` | the UDP ports for call audio, at most 200. Change them for a second SIP workspace on the same machine | `20000-20046` |
| `ice_servers=<list>` | Rocket.Chat's **ICE Servers** setting: comma-separated `[user:password@]stun:host:port`, `turn:` or `turns:`. Helps audio through strict firewalls. houston does not run a TURN server | Rocket.Chat's own (Google STUN) |
| `pbx=off\|on` | adds the test phone system, connected the way Rocket.Chat's official external setup connects one. Needs `sip=on` | `off` |
| `fs_dialplan=stock\|edit` | gives FreeSWITCH's dialplans to you as files you can edit. Needs `pbx=on` | `stock` |

Any other Rocket.Chat setting goes on `up` as `--setting <Id>=<value>`. For example,
`--setting VoIP_TeamCollab_SIP_Integration_For_Internal_Calls=true` sends calls between users
through the phone services too.

### Phone system numbers

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

They are in the workspace folder, `~/.houston/repros/<name>/` (or under `HOUSTON_HOME`).
- Your edits are kept across `up --force`, stop/start, upgrade and backups: `restore --new`
  brings them back too.
- `houston info` lists the files you have changed.
- To get the original back, delete the file and run `up --force`.

| File | What it holds | Apply a change with |
|---|---|---|
| `voice/pbx/extensions.conf` | what each phone-system number does | `docker exec houston-<name>-pbx-1 asterisk -rx "dialplan reload"` |
| `voice/pbx/pjsip.conf` | the link to FreeSWITCH, and the phone accounts | `docker exec houston-<name>-pbx-1 asterisk -rx "pjsip reload"` |
| `voice/pbx/rtp.conf` | the phone system's audio ports (keep them within 30000–30019) | `docker restart houston-<name>-pbx-1` |
| `voice/pbx/transports.conf` | the phone system's address, rewritten on every create from `voip_domain` | do not edit it |
| `voice/freeswitch/public.xml`, `drachtio.xml` (with `fs_dialplan=edit`) | FreeSWITCH's dialplans, as it would write them itself | `docker exec houston-<name>-freeswitch-1 fs_cli -x reloadxml` |

To replay a customer's setup, paste their dialplan into the matching file, apply it, make the
same call, and compare the call flow.

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

- **A call has two parts.**
  - The *ringing* travels as SIP messages through Rocket.Chat, Drachtio and FreeSWITCH.
  - The *audio* goes straight between the browser (or phone) and FreeSWITCH or the phone
    system, over UDP, to the address in `voip_domain`.
  - A tunnel or web proxy carries the ringing and never the audio.
- **Calls between users need none of this:** their audio goes browser to browser.
- **Numbers:** 4 digits go to a Rocket.Chat user; 5 or more go out to the phone system.
- **What is published, and where:**
  - By default everything is published only on this machine (`127.0.0.1`): the audio ports
    20000–20046, the phone system's 5060 and 30000–30019, and FreeSWITCH's 5080.
  - `--bind 0.0.0.0` opens them on your network, together with the weak phone accounts and
    5080, which asks for no password. `up` warns you about it.
- **On Docker Desktop (a Mac)**, the services' own addresses cannot be reached from the Mac
  itself. That is why option B in Step 2 is needed there even for a browser on the same Mac.

**Limits:**
- Docker only.
- One phone-system lab per machine: a second is refused, and the message names the first.
- On Apple Silicon, two services run through emulation.

### Rocket.Chat behaviours worth knowing

Seen on Rocket.Chat 8.8.1. houston reproduces them; it does not change the server.

- **Rocket.Chat connects to the phone services only when it starts.** If Drachtio goes away
  and comes back, or SIP Integration is switched off and on, Rocket.Chat stays disconnected
  until it restarts.
- **Dialling a user's extension does not use SIP.** Rocket.Chat calls its own users directly,
  unless **Route internal calls through the SIP integration** is on. To test SIP towards a
  user, ring them from the phone system (test 3).
- **An incoming call is answered only when the user accepts.** Rocket.Chat sends no "ringing"
  message, so the caller hears no ringing tone from Rocket.Chat.
- **Forwarding a call to a user picked by name does not reach them.** Rocket.Chat sends the
  transfer to `sip:<username>@…`, and FreeSWITCH's official dialplans route only numbers. It
  accepts the transfer, ends the forwarding user's side of the call, and the user never rings.
  Picking the user's extension (`1001`) works.
- **On plain `http://` away from localhost, a licensed workspace shows "Application Error"**
  for the whole page.
