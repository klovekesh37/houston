/**
 * The voice preset's PBX lab (`pbx=on`): Rocket.Chat's official external FreeSWITCH settings,
 * and FreeSWITCH's own dialplans as files a person can edit (`fs_dialplan=edit`).
 *
 * The external settings are `compose.freeswitch.external.yml` from RocketChat/rocketchat-compose
 * (ee0d72d1, unchanged on main 967a4d3a), with the lab PBX as the external domain. The file
 * publishes 5080, FreeSWITCH's external SIP port, which asks no password; houston publishes it on
 * the bind address, as every port, so a loopback workspace keeps it on this machine.
 *
 * The editable dialplans are the image's own render for those values, shipped under
 * `data/voice/freeswitch/`. Each is mounted as ITS OWN FILE because that is what the image's
 * entrypoint looks for: a dialplan mounted from the host is left alone, one that is not is
 * rendered from the variables. ponytail: copied from `rocketchat/freeswitch:latest` on
 * 2026-10-16 (image sha256:c7d3cbaa); re-render when that image changes (the PBX lab plan
 * says how), or `edit` stops matching what stock renders.
 */
import * as fs from 'node:fs';

import * as config from '../config';

/** The lab PBX's own SIP address on the workspace network: the external calls domain. */
const PBX_SIP = 'pbx:5060';
export const EXTERNAL_SIP_PORT = 5080;

/** The official external variables, other than ACCEPT_EXTERNAL_CALLS. */
export function externalEnv(): Record<string, string> {
  return {
    EXTERNAL_CALLS_DOMAIN: PBX_SIP,
    EXTERNAL_NUMBER_EXPRESSION: '^(\\+?\\d{5,})$$',
    EXTERNAL_TO_INTERNAL_NUMBER_EXPRESSION: '^(\\d{4})$$',
    PUBLIC_DIALPLAN_INTERNAL_NUMBER_BRIDGE_STRING:
      'sofia/internal/$${dialed_extension}@$${domain_name}',
    DEFAULT_DIALPLAN_EXTERNAL_NUMBER_BRIDGE_STRING:
      'sofia/external/$${dialed_extension}@$${external_calls_domain}',
    SIP_EXTERNAL_INBOUND_ACL: 'any_v4.auto',
  };
}

const DIALPLANS = ['public.xml', 'drachtio.xml'] as const;

/** Workspace paths of FreeSWITCH's editable dialplans. */
export const FS_DIALPLANS: readonly string[] = DIALPLANS.map((file) => `voice/freeswitch/${file}`);

/** One mount per file, where the image's entrypoint looks for each. */
export const FS_DIALPLAN_MOUNTS: readonly string[] = DIALPLANS.map(
  (file) => `./voice/freeswitch/${file}:/etc/freeswitch/dialplan/${file}:ro`,
);

/** The dialplans as the image renders them for the external variables; read when asked. */
export function fsDialplanFiles(): [string, string][] {
  return DIALPLANS.map((file) => [
    `voice/freeswitch/${file}`,
    fs.readFileSync(config.dataPath('voice', 'freeswitch', file), 'utf8'),
  ]);
}

/*
 * The lab PBX: an Asterisk on FreeSWITCH's external side, as a customer's phone system would
 * be. It is in no Rocket.Chat document -- the PBX is the customer's -- so it is houston's own:
 * a trunk to freeswitch:5080, four softphone accounts, simulated desk phones, ring groups and
 * an "outside world", all in files written once and kept, so a person can edit the dialplan
 * to replay a customer's and reload it. The folder is mounted, and Asterisk's three files are
 * symlinks into it: an editor that replaces a file (vim, sed -i) is still seen on reload,
 * which a single-file mount is not. Measured idle at 48.5 MiB.
 */
const PBX_IMAGE = 'docker.io/andrius/asterisk:22.11.0_debian-trixie-427809d';
const PBX_SIP_PORT = 5060;
const PBX_RTP: readonly [number, number] = [30000, 30019];
const SOFTPHONES = ['22001', '22002', '22003', '22004'] as const;
const OUTSIDE_CALLER = '0301234567';

/** The host ports the PBX publishes: SIP, then its RTP range. */
export const PBX_PORTS: readonly number[] = [
  PBX_SIP_PORT,
  ...Array.from({ length: PBX_RTP[1] - PBX_RTP[0] + 1 }, (_, i) => PBX_RTP[0] + i),
];

/** The lab files a person edits; written once (`Preset.keepFiles`). */
export const PBX_KEPT: readonly string[] = [
  'voice/pbx/pjsip.conf',
  'voice/pbx/extensions.conf',
  'voice/pbx/rtp.conf',
];

export function pbxService(): Record<string, unknown> {
  const rtp = `${String(PBX_RTP[0])}-${String(PBX_RTP[1])}`;
  const links = ['pjsip', 'extensions', 'rtp']
    .map((name) => `ln -sf /etc/asterisk/lab/${name}.conf /etc/asterisk/${name}.conf`)
    .join(' && ');
  // The trunk identifies FreeSWITCH by the address Asterisk looks up when it loads. The wait
  // covers a daemon restart (a reboot), which starts containers without compose's order; the
  // watcher covers a restart that gives FreeSWITCH another address (measured on Docker
  // Desktop), reloading PJSIP when the name moves. `$$` is compose's escape for `$`.
  const wait = 'until getent hosts freeswitch >/dev/null; do sleep 1; done';
  const lookup = "getent hosts freeswitch | cut -d' ' -f1";
  const watch =
    `(last=$$(${lookup}); while sleep 5; do now=$$(${lookup}); ` +
    'if [ -n "$$now" ] && [ "$$now" != "$$last" ]; then ' +
    "asterisk -rx 'pjsip reload' >/dev/null 2>&1 && last=$$now; fi; done)";
  return {
    image: PBX_IMAGE,
    restart: 'unless-stopped',
    depends_on: ['freeswitch'],
    volumes: ['./voice/pbx:/etc/asterisk/lab:ro'],
    command: [
      'sh',
      '-c',
      `${wait} && ${links} && { ${watch} & exec /usr/sbin/asterisk -f -vvv -n -U asterisk -p; }`,
    ],
    ports: [
      `${String(PBX_SIP_PORT)}:${String(PBX_SIP_PORT)}/udp`,
      `${String(PBX_SIP_PORT)}:${String(PBX_SIP_PORT)}/tcp`,
      `${rtp}:${rtp}/udp`,
    ],
  };
}

/** Unset `voip_domain` is FreeSWITCH's own container name, as `voice.ts` treats it. */
const advertises = (voipDomain: string): boolean => voipDomain !== 'freeswitch';

function transports(voipDomain: string): string {
  const external = advertises(voipDomain)
    ? `external_media_address=${voipDomain}\nexternal_signaling_address=${voipDomain}\n`
    : '';
  const transport = (protocol: string): string =>
    `[transport-${protocol}]\ntype=transport\nprotocol=${protocol}\nbind=0.0.0.0:${String(PBX_SIP_PORT)}\n${external}`;
  return (
    '; houston rewrites this file on every create, from --set voip_domain. Edit pjsip.conf instead.\n' +
    `${transport('udp')}\n${transport('tcp')}`
  );
}

function softphone(n: string): string {
  return [
    `; Softphone account ${n}: user name and password are the number.`,
    `[${n}]`,
    'type=endpoint',
    'context=from-phones',
    'disallow=all',
    'allow=ulaw,alaw',
    `auth=${n}`,
    `aors=${n}`,
    `callerid="Phone ${n}" <${n}>`,
    'direct_media=no',
    'rtp_symmetric=yes',
    'force_rport=yes',
    'rewrite_contact=yes',
    '',
    `[${n}]`,
    'type=auth',
    'auth_type=userpass',
    `username=${n}`,
    `password=${n}`,
    '',
    `[${n}]`,
    'type=aor',
    'max_contacts=1',
    'remove_existing=yes',
    '',
  ].join('\n');
}

const PJSIP = `; The lab PBX's SIP side. houston wrote this once and keeps your edits (delete it and run
; houston up --force for the default). Apply an edit: asterisk -rx "pjsip reload"
#include lab/transports.conf

; Rocket.Chat's FreeSWITCH, its external side (port 5080), which asks no password.
[rocketchat]
type=endpoint
transport=transport-udp
context=from-rocketchat
disallow=all
allow=ulaw,alaw
aors=rocketchat
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes

[rocketchat]
type=aor
contact=sip:freeswitch:5080

[rocketchat]
type=identify
endpoint=rocketchat
match=freeswitch

${SOFTPHONES.map(softphone).join('\n')}`;

const EXTENSIONS = [
  "; The lab PBX's dialplan. houston wrote this once and keeps your edits (delete it and run",
  '; houston up --force for the default). Apply an edit: asterisk -rx "dialplan reload"',
  '[general]',
  'static=yes',
  'writeprotect=yes',
  '',
  '[lab]',
  "; 4 digits: a Rocket.Chat user, through FreeSWITCH's external side",
  'exten => _XXXX,1,Dial(PJSIP/${EXTEN}@rocketchat,60)',
  ' same => n,Hangup()',
  '; softphone accounts',
  'exten => _2200[1-4],1,Dial(PJSIP/${EXTEN},60)',
  ' same => n,Hangup()',
  '; simulated desk phones',
  'exten => 22101,1,Ringing()',
  ' same => n,Wait(10)',
  ' same => n,Answer()',
  ' same => n,Echo()',
  'exten => 22102,1,Ringing()',
  ' same => n,Wait(3600)',
  'exten => 22103,1,Busy(10)',
  'exten => 22104,1,Answer()',
  ' same => n,Echo()',
  '; ring groups: every member at once',
  'exten => 23000,1,Dial(Local/22101@lab&PJSIP/22001&PJSIP/1002@rocketchat,60)',
  'exten => 23001,1,Dial(Local/22102@lab&PJSIP/1002@rocketchat,60)',
  '; the outside world',
  'exten => 5550000,1,Answer()',
  ' same => n,Echo()',
  'exten => 5550001,1,Ringing()',
  ' same => n,Wait(3600)',
  'exten => 5550002,1,Busy(10)',
  'exten => _XXXX.,1,Ringing()',
  ' same => n,Wait(3)',
  ' same => n,Answer()',
  ' same => n,Milliwatt()',
  '',
  "; calls Rocket.Chat's users make (5 or more digits, a leading + allowed)",
  '[from-rocketchat]',
  'exten => _+X.,1,Goto(lab,${EXTEN:1},1)',
  'exten => _X.,1,Goto(lab,${EXTEN},1)',
  '',
  '[from-phones]',
  'include => lab',
  '',
  '; asterisk -rx "channel originate Local/<number>@from-outside application Echo"',
  '[from-outside]',
  `exten => _X.,1,Set(CALLERID(all)="Outside caller" <${OUTSIDE_CALLER}>)`,
  ' same => n,Goto(lab,${EXTEN},1)',
  '',
].join('\n');

const RTP = `; The lab PBX's audio ports. houston publishes ${String(PBX_RTP[0])}-${String(PBX_RTP[1])}: keep inside them.
[general]
rtpstart=${String(PBX_RTP[0])}
rtpend=${String(PBX_RTP[1])}
`;

/** The lab's files: the kept three, the transports rewritten from `voip_domain`, captures. */
export function pbxFiles(voipDomain: string): [string, string][] {
  return [
    ['voice/pbx/pjsip.conf', PJSIP],
    ['voice/pbx/extensions.conf', EXTENSIONS],
    ['voice/pbx/rtp.conf', RTP],
    ['voice/pbx/transports.conf', transports(voipDomain)],
    // So a capture container mounting this folder does not create it as root.
    [
      'voice/captures/README.txt',
      'SIP captures of this workspace\'s calls go here (Voice guide, "Call-flow ladders").\n',
    ],
  ];
}

/** What `info` says about the lab. `<name>` as the voice preset's other notes have it. */
export function pbxNotes(voipDomain: string): string[] {
  return [
    `PBX lab: an Asterisk phone system trunked to FreeSWITCH's external side (port 5080). Numbers: 1001/1002 the Rocket.Chat users; 22001–22004 softphone accounts (user = password = number, SIP port 5060 on the bind address); 22101 rings 10 s then answers, 22102 never answers, 22103 is busy, 22104 answers at once; ring group 23000 = 22101 + 22001 + voice-bob, 23001 = 22102 + voice-bob; 5550000 echo, 5550001 rings forever, 5550002 busy, other 5+ digit numbers answer after 3 s with a tone. Rocket.Chat users dial 5+ digits to reach it.`,
    `An outside caller (shows as ${OUTSIDE_CALLER}): docker exec houston-<name>-pbx-1 asterisk -rx "channel originate Local/23000@from-outside application Echo" (Local/1002@from-outside rings voice-bob alone).`,
    'Edit the lab in ~/.houston/repros/<name>/voice/ (under HOUSTON_HOME when set): pbx/extensions.conf and pbx/pjsip.conf, kept across up --force, stop/start and upgrade (delete one and run up --force for the default); apply with docker exec houston-<name>-pbx-1 asterisk -rx "dialplan reload" (or "pjsip reload"). With fs_dialplan=edit, freeswitch/public.xml and drachtio.xml too: docker exec houston-<name>-freeswitch-1 fs_cli -x reloadxml (after an editor that replaces the file, such as vim or sed -i: docker restart houston-<name>-freeswitch-1).',
    `The call flow (ladder): docker run --rm -it --net=container:houston-<name>-freeswitch-1 --cap-add NET_RAW --cap-add NET_ADMIN docker.io/library/alpine:3.24.2 sh -c 'apk add -q --no-cache sngrep && sngrep port 5060 or port 5080'. Text traces: asterisk -rx "pjsip set logger on" in the pbx, fs_cli -x "sofia profile external siptrace on" in freeswitch.`,
    advertises(voipDomain)
      ? `Softphones elsewhere reach the PBX at ${voipDomain}:5060. FreeSWITCH advertises ${voipDomain} to the PBX as well, so the workspace must be bound to cover it (--bind 0.0.0.0 or that IP) or PBX calls have no audio.`
      : 'Softphones on this machine only (127.0.0.1:5060 on a loopback bind); for softphones elsewhere set voip_domain and --bind wider.',
  ];
}
