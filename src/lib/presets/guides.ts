/**
 * What a preset tells the GUI's scenario card, sorted the way a reader asks: who to sign in
 * as, what to try, what to know -- and, when the preset needs it, the one thing to do first on
 * the reader's machine (a hosts entry). A preset writes its guide beside its notes; the notes
 * stay the CLI's words, the guide is the card's. Plain data, so the composite can carry one
 * per preset and the detail payload can hand them to the browser untouched.
 */
export interface PresetGuide {
  /** The preset's name, which the card uses as the tab. */
  name: string;
  /** One line: what this preset gives the workspace. */
  summary: string;
  /** A thing to do once, on the reader's machine, before the preset works: why, and the line. */
  setup: { why: string; line: string } | null;
  /** Who to sign in as: user, password, and where that login applies ('' when obvious). */
  signIn: [string, string, string][];
  /** What to try, in order, one line each. */
  steps: string[];
  /** The caveats, one line each. */
  know: string[];
}

type GuideParts = Partial<Omit<PresetGuide, 'name'>>;

/** A guide, with the empty parts filled in and blank lines (a conditional that gave '') dropped. */
export function guide(name: string, parts: GuideParts): PresetGuide {
  const lines = (list: readonly string[] | undefined): string[] =>
    (list ?? []).filter((line) => line.trim() !== '');
  return {
    name,
    summary: parts.summary ?? '',
    setup: parts.setup ?? null,
    signIn: (parts.signIn ?? []).map(([user, password, where]) => [user, password, where]),
    steps: lines(parts.steps),
    know: lines(parts.know),
  };
}

/** The guides with nothing that needs the reader's own machine: a public URL serves every UI. */
export function withoutLocalSetup(guides: readonly PresetGuide[]): PresetGuide[] {
  return guides.map((one) => ({
    ...one,
    setup: null,
    know: one.know.filter((line) => !/hosts entry/iu.test(line)),
  }));
}
