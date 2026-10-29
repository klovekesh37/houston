'use strict';

// Voice's designed controls -- each phone option opening once the one it needs is on, and none
// on Kubernetes -- extend 220.
// The create dialog sending voice with the phone system and email as one composed request extends 219.
// A member offered no prepare or forget on a cluster -- an admin's now -- extends 218.
// A member's view of a colleague's workspace -- looked at, never changed -- and a box without
// accounts still offered every control extend 216.
// Three Okta sign-in behaviors -- the button, the tile, a refusal -- extend 213.
// A list read that never answers, given up so the rail carries on, extends 212.
// Two behaviors extend 210: a running create shown on the rail after a reload, and the
// e2ee preset's options sent as its settings.
// Five retained-job History behaviors extend the 205 baseline.
// Five seed GUI behaviors and twenty-two re-verification regressions extend the 178 baseline.
// Re-recorded for a directory workspace's notes reading as points (the presets write one
// string per point now), for a rail card whose long name and preset list stay inside it, and
// for the scenario card reading each preset's guide behind tabs.
// Home not asking about a workspace whose create is still running extends 226.
// Three wording behaviors on a shared server -- restore as new naming who holds the port,
// what deleting taken-down workspaces deletes, a running job named by the GUI's verbs --
// extend 233.
// A running job named by its verb once the record carries it, restore into a colleague's
// workspace shown disabled, and recorded activity in plain words extend 236.
const EXPECTED = 239;

module.exports = (results) => {
  const wanted = process.env.BROWSER_GATE_PROBE === 'count' ? EXPECTED + 1 : EXPECTED;
  if (
    results.numTotalTests !== wanted ||
    results.numPassedTests !== wanted ||
    results.numPendingTests !== 0 ||
    results.numFailedTests !== 0
  ) {
    throw new Error(
      `browser count gate: expected exactly ${wanted} passed and zero skipped; ` +
        `got ${results.numPassedTests} passed, ${results.numPendingTests} skipped, ` +
        `${results.numFailedTests} failed, ${results.numTotalTests} total`,
    );
  }
  process.stdout.write(`Browser count gate: exactly ${EXPECTED} passed, zero skipped\n`);
  return results;
};
