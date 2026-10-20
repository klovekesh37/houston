import { bindPorts, type ComposeDoc } from '../../../src/lib/compose';
import { load, loadMany, resolve } from '../../../src/lib/presets/index';
import { type Preset } from '../../../src/lib/presets/types';

type Service = Record<string, unknown> & { environment: Record<string, string> };

/** The FreeSWITCH service a voice preset with these params builds. */
function fsOf(params: Record<string, unknown>): Service {
  return load('voice', params).services.freeswitch as Service;
}

describe("the voice PBX lab: FreeSWITCH's external side", () => {
  it('gives FreeSWITCH the official external variables with pbx=on', () => {
    // compose.freeswitch.external.yml, the `$$` escapes as that file writes them.
    expect(fsOf({ sip_integration: 'on', pbx: 'on' }).environment).toMatchObject({
      ACCEPT_EXTERNAL_CALLS: 'true',
      EXTERNAL_CALLS_DOMAIN: 'pbx:5060',
      EXTERNAL_NUMBER_EXPRESSION: '^(\\+?\\d{5,})$$',
      EXTERNAL_TO_INTERNAL_NUMBER_EXPRESSION: '^(\\d{4})$$',
      PUBLIC_DIALPLAN_INTERNAL_NUMBER_BRIDGE_STRING:
        'sofia/internal/$${dialed_extension}@$${domain_name}',
      DEFAULT_DIALPLAN_EXTERNAL_NUMBER_BRIDGE_STRING:
        'sofia/external/$${dialed_extension}@$${external_calls_domain}',
      SIP_EXTERNAL_INBOUND_ACL: 'any_v4.auto',
    });
    expect(fsOf({ sip_integration: 'on', pbx: 'on' }).expose).toEqual(['5060/udp', '5080/udp']);
    // The official file's port, after the base file's RTP range (compose merges them in that order).
    expect(fsOf({ sip_integration: 'on', pbx: 'on' }).ports).toEqual([
      '20000-20046:20000-20046/udp',
      '5080:5080/udp',
    ]);
    expect(load('voice', { sip_integration: 'on', pbx: 'on' }).ports).toContain(5080);
    expect(load('voice', { sip_integration: 'on' }).ports).not.toContain(5080);
  });

  it('leaves sip_integration=on alone without pbx', () => {
    expect(fsOf({ sip_integration: 'on' }).environment.ACCEPT_EXTERNAL_CALLS).toBe('false');
    expect(fsOf({ sip_integration: 'on' }).environment).not.toHaveProperty('EXTERNAL_CALLS_DOMAIN');
    expect(fsOf({ sip_integration: 'on' }).expose).toEqual(['5060/udp']);
  });

  it('mounts editable dialplans only with freeswitch_dialplans=edit, one file at a time, kept', () => {
    // One mount per file: the image's entrypoint leaves a dialplan alone when that FILE is
    // mounted from the host, and renders it from the variables otherwise.
    const edit = load('voice', { sip_integration: 'on', pbx: 'on', freeswitch_dialplans: 'edit' });
    expect((edit.services.freeswitch as Service).volumes).toEqual([
      './voice/freeswitch/public.xml:/etc/freeswitch/dialplan/public.xml:ro',
      './voice/freeswitch/drachtio.xml:/etc/freeswitch/dialplan/drachtio.xml:ro',
    ]);
    expect(edit.keepFiles).toEqual(
      expect.arrayContaining(['voice/freeswitch/public.xml', 'voice/freeswitch/drachtio.xml']),
    );
    const pub = edit.files.find(([file]) => file === 'voice/freeswitch/public.xml')?.[1] ?? '';
    expect(pub).toContain(
      '<action application="bridge" data="sofia/internal/${dialed_extension}@${domain_name}"/>',
    );
    const stock = load('voice', { sip_integration: 'on', pbx: 'on' });
    expect((stock.services.freeswitch as Service).volumes).toBeUndefined();
    expect(
      stock.files.map(([file]) => file).filter((file) => file.startsWith('voice/freeswitch/')),
    ).toEqual([]);
  });

  it.each([
    [{ pbx: 'on' }, '--set pbx=on needs sip_integration=on'],
    [
      { sip_integration: 'on', freeswitch_dialplans: 'edit' },
      '--set freeswitch_dialplans=edit needs pbx=on',
    ],
    [{ sip_integration: 'on', pbx: 'maybe' }, "--set pbx='maybe' expects one of: off, on"],
  ])('refuses %j', (params, message) => {
    expect(() => load('voice', params)).toThrow(message);
  });

  it('refuses pbx on Kubernetes, as it refuses sip', () => {
    expect(() => resolve('voice', 'kubernetes', { sip_integration: 'on', pbx: 'on' })).toThrow(
      'voice sip_integration=on runs on Docker only',
    );
  });

  it('routes voice.pbx in a composed workspace', () => {
    const composed = loadMany(
      ['email', 'voice'],
      { voice: { sip_integration: 'on', pbx: 'on' } },
      'docker',
    );
    expect((composed.services.freeswitch as Service).environment.ACCEPT_EXTERNAL_CALLS).toBe(
      'true',
    );
  });
});

describe('the voice PBX lab: the Asterisk phone system', () => {
  const lab = (params: Record<string, unknown> = {}): Preset =>
    load('voice', { sip_integration: 'on', pbx: 'on', ...params });
  const file = (pre: Preset, name: string): string =>
    pre.files.find(([path]) => path === name)?.[1] ?? '';

  it('runs the pinned Asterisk with its config folder mounted, after FreeSWITCH', () => {
    const pbx = lab().services.pbx as Record<string, unknown>;
    expect(pbx).toMatchObject({
      image: 'docker.io/andrius/asterisk:22.11.0_debian-trixie-427809d',
      restart: 'unless-stopped',
      depends_on: ['freeswitch'],
      volumes: ['./voice/pbx:/etc/asterisk/lab:ro'],
      ports: ['5060:5060/udp', '5060:5060/tcp', '30000-30019:30000-30019/udp'],
    });
    // Symlinks, not file mounts: an editor that replaces the file is still seen.
    expect(String((pbx.command as string[])[2])).toContain(
      'ln -sf /etc/asterisk/lab/extensions.conf /etc/asterisk/extensions.conf',
    );
    // The trunk resolves `freeswitch` once, when Asterisk loads; after a reboot the daemon starts
    // containers without compose's order, so the PBX waits for the name first.
    expect(String((pbx.command as string[])[2])).toMatch(
      /^until getent hosts freeswitch >\/dev\/null; do sleep 1; done && /u,
    );
  });

  it('finds FreeSWITCH again after a restart moves it, with no reload by hand', () => {
    // Measured on Docker Desktop: `houston restart` gave FreeSWITCH another address and the
    // trunk, matched by the address Asterisk looked up when it loaded, refused its calls.
    const command = String(
      ((lab().services.pbx as Record<string, unknown>).command as string[])[2],
    );
    // `$$` is compose's escape for a literal `$`: the container's shell gets `$`.
    expect(command).toContain(
      "while sleep 5; do now=$$(getent hosts freeswitch | cut -d' ' -f1); " +
        'if [ -n "$$now" ] && [ "$$now" != "$$last" ]; then ' +
        "asterisk -rx 'pjsip reload' >/dev/null 2>&1 && last=$$now; fi; done",
    );
    // In the background, started before Asterisk takes over the container's main process.
    expect(command).toMatch(/&& \{ \(last=.*\) & exec \/usr\/sbin\/asterisk /u);
  });

  it('gives FreeSWITCH its container address: local_net from the route table, at start', () => {
    // Measured on a lane behind NAT, as a cloud machine is: with voip_domain the public IP the
    // transports handed that address to FreeSWITCH next door, and the machine cannot reach its
    // own public address from inside, so PBX calls carried no audio (0 RTP packets either way;
    // 359 each way once local_net named the container's subnet).
    const command = String(
      ((lab().services.pbx as Record<string, unknown>).command as string[])[2],
    );
    expect(command).toContain('open("/proc/net/route")');
    // Only to the transports the person's pjsip.conf still has: `[name](+)` on a missing
    // section fails the whole file, so a pasted customer pjsip.conf left the PBX with no SIP.
    for (const t of ['transport-udp', 'transport-tcp']) {
      expect(command).toContain(
        `{ ! { grep -qs '^\\[${t}\\]' /etc/asterisk/lab/pjsip.conf || ` +
          `{ grep -qs '^#include *lab/transports.conf' /etc/asterisk/lab/pjsip.conf && ` +
          `grep -qs '^\\[${t}\\]' /etc/asterisk/lab/transports.conf; }; } || ` +
          `printf '[${t}](+)\\nlocal_net=%s\\n' "$$n" >> /etc/asterisk/lab-local.conf; }`,
      );
    }
    // The person's pjsip.conf is included, not replaced: edits and `pjsip reload` still apply.
    expect(command).toContain(
      "printf '#include lab/pjsip.conf\\n#include lab-local.conf\\n' > /etc/asterisk/pjsip.conf",
    );
    expect(command).not.toContain('ln -sf /etc/asterisk/lab/pjsip.conf');
    // Before Asterisk starts, after the symlinks.
    expect(command).toMatch(
      /rtp\.conf && n=\$\$\(python3 .*: > \/etc\/asterisk\/lab-local\.conf && .* > \/etc\/asterisk\/pjsip\.conf && \{ /u,
    );
  });

  it('claims the PBX ports beside the RTP range, so a second lab is refused', () => {
    const ports = lab().ports;
    expect(ports).toEqual(expect.arrayContaining([5060, 5080, 30000, 30019, 20000, 20046]));
    expect(ports).toHaveLength(47 + 1 + 21);
  });

  it('keeps pjsip, extensions and rtp, and rewrites transports from voip_domain', () => {
    const pre = lab({ voip_domain: '172.16.0.2' });
    expect(pre.keepFiles).toEqual([
      'voice/pbx/pjsip.conf',
      'voice/pbx/extensions.conf',
      'voice/pbx/rtp.conf',
    ]);
    expect(file(pre, 'voice/pbx/transports.conf')).toContain('external_media_address=172.16.0.2');
    expect(file(pre, 'voice/pbx/pjsip.conf')).toContain('#include lab/transports.conf');
    expect(file(pre, 'voice/pbx/pjsip.conf')).not.toContain('external_');
    expect(file(lab(), 'voice/pbx/transports.conf')).not.toContain('external_');
    expect(lab({ freeswitch_dialplans: 'edit' }).keepFiles).toHaveLength(5);
  });

  it('trunks to FreeSWITCH :5080 and gives four softphone accounts', () => {
    const pj = file(lab(), 'voice/pbx/pjsip.conf');
    expect(pj).toContain('contact=sip:freeswitch:5080');
    expect(pj).toContain('match=freeswitch');
    expect(pj).toContain('rewrite_contact=yes');
    for (const n of ['22001', '22002', '22003', '22004']) {
      expect(pj).toContain(`username=${n}\npassword=${n}`);
    }
  });

  it('dials the numbers the spec names', () => {
    const ex = file(lab(), 'voice/pbx/extensions.conf');
    for (const line of [
      'exten => _XXXX,1,Dial(PJSIP/${EXTEN}@rocketchat,60)',
      'exten => 23000,1,Dial(Local/22101@lab&PJSIP/22001&PJSIP/1002@rocketchat,60)',
      'exten => 23001,1,Dial(Local/22102@lab&PJSIP/1002@rocketchat,60)',
      'exten => 22103,1,Busy(10)',
      'exten => 5550002,1,Busy(10)',
      'exten => _XXXX.,1,Ringing()',
      'exten => _X.,1,Set(CALLERID(all)="Outside caller" <0301234567>)',
    ]) {
      expect(ex).toContain(line);
    }
    expect(file(lab(), 'voice/pbx/rtp.conf')).toContain('rtpstart=30000\nrtpend=30019');
    expect(file(lab(), 'voice/captures/README.txt')).not.toBe('');
  });

  it('opens only the call ports on every address once voip_domain names one', () => {
    // A VoIP domain is where browsers and phones elsewhere send to. Left on 127.0.0.1, the call
    // ports answered none of them: a phone on the same Wi-Fi could not register, and a cloud lab
    // had no PBX audio, until someone remembered --bind 0.0.0.0. Rocket.Chat's own port and
    // FreeSWITCH's 5080 stay on the bind; the PBX reaches 5080 by name.
    const wired = (voipDomain?: string, bind = '127.0.0.1'): ComposeDoc => {
      const pre = lab(voipDomain === undefined ? {} : { voip_domain: voipDomain });
      const ports = (name: string): unknown[] => [
        ...((pre.services[name] as { ports: unknown[] }).ports as unknown[]),
      ];
      const doc = {
        services: {
          rocketchat: { ports: ['4460:3000'] },
          freeswitch: { ports: ports('freeswitch') },
          pbx: { ports: ports('pbx') },
        },
      } as unknown as ComposeDoc;
      bindPorts(doc, bind);
      return doc;
    };
    expect(wired('192.168.1.20').services).toEqual({
      rocketchat: { ports: ['127.0.0.1:4460:3000'] },
      freeswitch: {
        ports: ['0.0.0.0:20000-20046:20000-20046/udp', '127.0.0.1:5080:5080/udp'],
      },
      pbx: {
        ports: [
          '0.0.0.0:5060:5060/udp',
          '0.0.0.0:5060:5060/tcp',
          '0.0.0.0:30000-30019:30000-30019/udp',
        ],
      },
    });
    // A bind chosen on purpose wins: the call ports follow it rather than every address.
    const narrow = wired('192.168.1.20', '10.0.0.5').services;
    expect((narrow.pbx as { ports: string[] }).ports[0]).toBe('10.0.0.5:5060:5060/udp');
    // The default and every loopback spelling are this machine only: everything on the bind.
    for (const voipDomain of [
      undefined,
      '127.0.0.1',
      '127.0.0.2',
      'localhost',
      'LOCALHOST',
      'localhost.localdomain',
      'ip6-localhost',
      'lab.localhost',
    ]) {
      const flat = Object.values(wired(voipDomain).services).flatMap(
        (svc) => (svc as { ports: string[] }).ports,
      );
      expect(flat.every((port) => port.startsWith('127.0.0.1:'))).toBe(true);
    }
  });

  it('notes the numbers, the outside caller, reloads, the ladder and the open ports', () => {
    const notes = lab({ voip_domain: '172.16.0.2' }).notes.join('\n');
    for (const text of [
      '22101 rings 10 s',
      'Local/23000@from-outside',
      'dialplan reload',
      'alpine:3.24.2',
      'sngrep port 5060 or port 5080',
      'opens 5060 and the PBX',
      'password = number',
      // The three kept files, and what brings them back: the note once named two of them.
      'pbx/extensions.conf, pbx/pjsip.conf and pbx/rtp.conf',
      'restore --new brings them back',
      'freeswitch_dialplans=edit',
    ]) {
      expect(notes).toContain(text);
    }
    // One vocabulary: the official word is PBX, and the SIP services are named.
    expect(notes).not.toMatch(/phone (system|services)/iu);
  });
});
