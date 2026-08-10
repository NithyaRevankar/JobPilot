// runs-harness.mjs — the run registry and the one-run-per-tab invariant.
//
// Node only, no browser. RunRegistry is dependency-free by design, and its `send` is
// injected precisely so this can drive it without a chrome runtime.
//
// What is being protected here is not a tidy data structure. Two runs on one tab silently
// corrupt each other's element refs — the content script rebuilds refMap per read_page and
// never looks at who asked — so the failure mode is a click landing on the wrong control in
// a real job application, with no error raised anywhere. Every check below is a way that
// could happen.

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (cond) pass++; else fail++;
};

const { RunRegistry, RUN_STATUS } = await import('../sidepanel/js/runs.js');

/** A worker stub that records what it was told and can be made to refuse. */
function makeSend() {
  const sent = [];
  const refuse = new Set();
  const send = async (msg) => {
    sent.push(msg);
    if (msg.kind === 'jobpilot:claim-tab' && refuse.has(msg.tabId)) {
      return { ok: false, error: 'That tab is already being driven by another JobPilot window.' };
    }
    return { ok: true };
  };
  return { send, sent, refuse };
}

// ============================================================ one run per tab
{
  const { send } = makeSend();
  const reg = new RunRegistry({ send });

  const a = await reg.create({ tabId: 1, title: 'Workday' });
  check('a run claims its tab', a.ok === true && reg.ownerOf(1) === a.run.id);

  const b = await reg.create({ tabId: 1, title: 'the same tab' });
  check('THE INVARIANT: a second run cannot be started on a tab that already has one',
    b.ok === false && /already has an application/i.test(b.error), JSON.stringify(b));
  check('...and the refusal did not disturb the run that was there',
    reg.ownerOf(1) === a.run.id && reg.list().length === 1);

  const c = await reg.create({ tabId: 2 });
  check('a different tab is fine', c.ok === true && reg.ownerOf(2) === c.run.id);
  check('...and the two runs have different ids', c.run.id !== a.run.id);
}

// ================================================================== the cap
{
  const { send } = makeSend();
  const reg = new RunRegistry({ max: 2, send });
  const a = await reg.create({ tabId: 1 });
  const b = await reg.create({ tabId: 2 });
  reg.setStatus(a.run.id, RUN_STATUS.RUNNING);
  reg.setStatus(b.run.id, RUN_STATUS.RUNNING);

  const c = await reg.create({ tabId: 3 });
  check('the cap refuses a run past the limit rather than queueing it silently',
    c.ok === false && /already running/i.test(c.error), JSON.stringify(c));

  // A run waiting on the user still holds a tab and a conversation, so it still counts.
  reg.setStatus(b.run.id, RUN_STATUS.BLOCKED);
  const d = await reg.create({ tabId: 3 });
  check('a run BLOCKED on a question still counts against the cap — it holds a tab and a stream',
    d.ok === false, JSON.stringify(d));

  reg.setStatus(b.run.id, RUN_STATUS.DONE);
  const e = await reg.create({ tabId: 3 });
  check('...but a finished one releases the slot', e.ok === true);
}

// ============================================== the worker arbitrates windows
{
  const { send, refuse, sent } = makeSend();
  refuse.add(7); // another window's panel already drives tab 7
  const reg = new RunRegistry({ send });

  const r = await reg.create({ tabId: 7 });
  check('THE CROSS-WINDOW CASE: the worker refuses a tab another window is driving, and ' +
    'the panel does not start a run anyway',
    r.ok === false && /another JobPilot window/i.test(r.error), JSON.stringify(r));
  check('...and nothing was recorded locally for it', reg.ownerOf(7) === null && reg.list().length === 0);
  check('...but it did ASK — the panel-local map alone cannot see other windows',
    sent.some((m) => m.kind === 'jobpilot:claim-tab' && m.tabId === 7));
}

// ================================================ adoption, release, retarget
{
  const { send, sent } = makeSend();
  const reg = new RunRegistry({ send });
  const a = await reg.create({ tabId: 1 });
  const b = await reg.create({ tabId: 2 });

  const tabsA = reg.tabsFor(a.run.id);
  check('the collaborator handed to AgentRunner reports the OTHER run as a tab owner',
    tabsA.ownerOf(2) === b.run.id);
  check('...and reports its own tab as its own', tabsA.ownerOf(1) === a.run.id);
  check('...and an unclaimed tab as free', tabsA.ownerOf(99) === null);

  // "Apply" opened a new tab and run A followed it there.
  tabsA.claim(50);
  check('adopting a spawned tab records it', reg.ownerOf(50) === a.run.id);
  check('...and moves the run onto it, so the switcher and the indicator follow',
    reg.get(a.run.id).tabId === 50);
  check('...and tells the worker', sent.some((m) => m.kind === 'jobpilot:claim-tab' && m.tabId === 50));

  tabsA.release(50);
  check('releasing gives the tab back', reg.ownerOf(50) === null);
  check('...and says so, or the next run to be pointed at it would be refused by a claim ' +
    'nobody holds', sent.some((m) => m.kind === 'jobpilot:release-tab' && m.tabId === 50));

  // A release from a run that does NOT hold the tab must not unlock it.
  reg.release(2, a.run.id);
  check('a run cannot release a tab it does not own', reg.ownerOf(2) === b.run.id);
}

// ======================================== the tab events nothing listened for
{
  const { send } = makeSend();
  const reg = new RunRegistry({ send });
  const a = await reg.create({ tabId: 1 });

  // chrome.tabs.onReplaced — prerender activation swaps the id under a live page.
  const owner = reg.replaceTab(1, 900);
  check('onReplaced: a changed tab id is remapped rather than ending the run',
    owner === a.run.id && reg.ownerOf(900) === a.run.id && reg.ownerOf(1) === null);
  check('...and the run points at the new id', reg.get(a.run.id).tabId === 900);

  // chrome.tabs.onRemoved — the tab actually closed.
  const gone = reg.forgetTab(900);
  check('onRemoved: the owner is reported so the caller can end that run',
    gone === a.run.id && reg.ownerOf(900) === null);
  check('forgetting a tab nobody owns is a no-op, not a throw', reg.forgetTab(12345) === null);
}

// ==================================================== removal frees everything
{
  const { send } = makeSend();
  const reg = new RunRegistry({ send });
  const a = await reg.create({ tabId: 1 });
  reg.tabsFor(a.run.id).claim(2); // a run can own several tabs

  reg.remove(a.run.id);
  check('removing a run releases EVERY tab it held, not just the one it is on',
    reg.ownerOf(1) === null && reg.ownerOf(2) === null, JSON.stringify([...reg.tabOwners]));
  check('...and the run is gone', reg.get(a.run.id) === null && reg.list().length === 0);

  const b = await reg.create({ tabId: 1 });
  check('...so the tab can be used again', b.ok === true);
}

// ============================================================== subscriptions
{
  const { send } = makeSend();
  const reg = new RunRegistry({ send });
  let beats = 0;
  const off = reg.subscribe(() => { beats += 1; });
  const a = await reg.create({ tabId: 1 });
  check('creating a run notifies the UI', beats === 1);
  reg.setStatus(a.run.id, RUN_STATUS.RUNNING);
  check('...and so does a status change', beats === 2);
  reg.setStatus(a.run.id, RUN_STATUS.RUNNING);
  check('...but an unchanged status does not re-render for nothing', beats === 2);
  off();
  reg.setStatus(a.run.id, RUN_STATUS.DONE);
  check('unsubscribing stops the notifications', beats === 2);
}

console.log(fail ? `\n${fail} run-registry check(s) FAILED` : `\nall run-registry checks passed (${pass})`);
process.exit(fail ? 1 : 0);
