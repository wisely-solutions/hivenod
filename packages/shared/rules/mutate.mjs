// Rules mutation check: weakens one security rule at a time and asserts the rules suite
// catches it (at least one test fails). Proves the deny tests fail for the right reason.
// MUTATE_ONLY="name,name" limits the run. Run inside the emulator:  pnpm test:rules:mutate   (from the repo root)
// The tracked firestore.rules is NEVER edited: each mutation is written to a temp copy (under TMPDIR,
// which scripts/emu-exec.mjs gives this run) and the rules suite reads it through HIVE_RULES_FILE. An
// interrupted run therefore cannot leave weakened rules behind (SIGINT/SIGTERM/SIGHUP only clean the temp dir).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { applyEdits, assertWellFormed } from './mutate-lib.mjs';

const RULES = new URL('../../../firestore.rules', import.meta.url);
const original = readFileSync(RULES, 'utf8');
const tmp = mkdtempSync(join(tmpdir(), 'hive-mutate-'));
const TEMP_RULES = join(tmp, 'firestore.rules');
let child = null;
const cleanup = () => rmSync(tmp, { recursive: true, force: true });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (child) child.kill('SIGTERM');
    cleanup();
    process.exit(130);
  });
}
process.on('exit', cleanup);

/**
 * [name, [[find, replace], …]]. Every `find` must occur in the rules (all occurrences are
 * replaced). Where a promise is enforced by two independent layers, the mutation removes both.
 */
const MUTATIONS = [
  // Projects removed (OE8Fm slice 11): workspace events never name a project, item or run, and
  // only admins read the old project events.
  [
    'events may name a project',
    [['&& d.projectId == null && d.itemId == null && d.runId == null', '']],
  ],
  [
    'members read project events',
    [['(resource.data.projectId == null && isMember(wid))', 'isMember(wid)']],
  ],
  ['member connects unbounded', [['&& d.projectIds is list && d.projectIds.size() <= 5;', ';']]],
  ['agent cliVersion unbounded', [["&& strOrNull(d.get('cliVersion', null), 40)", '']]],
  ['agent seenSession unbounded', [["&& strOrNull(d.get('seenSession', null), 64)", '']]],
  ['agent seenHostId unbounded', [["&& strOrNull(d.get('seenHostId', null), 64))", ')']]],
  [
    'cliVersion without presence',
    [
      [
        "&& d.lastSeenAt == request.time\n            && strOrNull(d.get('seenHost', null), 80)",
        "&& strOrNull(d.get('seenHost', null), 80)",
      ],
    ],
  ],
  [
    'event time not checked',
    [
      ['&& e.data.at == request.time', ''],
      ['&& d.at == request.time\n          && d.data is map', '&& d.data is map'],
    ],
  ],
  [
    'event actor not checked',
    [
      ['&& e.data.actor.id == me() && e.data.at', '&& e.data.at'],
      ['&& d.actor.id == me()\n', '\n'],
    ],
  ],
  [
    'event need not exist',
    [
      [
        'return eid is string && e != null\n        && e.data.actor.id == me() && e.data.at == request.time && e.data.type in types;',
        'return eid is string\n        && (e == null || (e.data.actor.id == me() && e.data.at == request.time && e.data.type in types));',
      ],
    ],
  ],
  [
    'agents emit human events',
    [
      [
        "&& ((d.actor.type == 'human' && isMemberAfter(wid)",
        '&& (((isMemberAfter(wid) || isActiveAgent(wid))',
      ],
    ],
  ],
  [
    'revoked agents active',
    [['return a != null && a.data.revokedAt == null;', 'return a != null;']],
  ],
  [
    'groups by members',
    [
      [
        "return isAdmin(wid)\n          && exactKeys(d, ['name', 'memberUids'",
        "return isMember(wid)\n          && exactKeys(d, ['name', 'memberUids'",
      ],
    ],
  ],
  [
    'agents by members',
    [
      [
        'return (isAdmin(wid) || memberConnects(d)) && verified()\n          && aid != me()',
        'return isMember(wid) && verified()\n          && aid != me()',
      ],
    ],
  ],
  ['member can be agent', [['&& aid != me() && !(aid in get(wsPath(wid)).data.memberRoles)', '']]],
  ['owner adds members directly', [['.addedKeys().size() == 0', '.addedKeys().size() >= 0']]],
  [
    'invite email unchecked',
    [
      [
        "&& r.email == request.auth.token.get('email', '').lower()\n          && docTracked",
        '&& docTracked',
      ],
    ],
  ],
  [
    'expired invites ok',
    [
      ['&& r.expiresAt > request.time\n', '\n'],
      [
        '&& inv.data.usedBy == null && inv.data.expiresAt > request.time',
        '&& inv.data.usedBy == null',
      ],
    ],
  ],
  [
    'outsiders read',
    [['allow read: if isMember(wid) || isActiveAgent(wid);', 'allow read: if signedIn();']],
  ],
  // Inbox (item 4PEHrOW5IfXBQWgOK9wo)
  [
    'inbox: other members read',
    [
      [
        'function inboxOwner(d) { return isMember(wid) && d.memberUid == me(); }',
        'function inboxOwner(d) { return isMember(wid); }',
      ],
    ],
  ],
  [
    'inbox: for anyone',
    [
      [
        'function inboxMember(uid) { return uid is string && uid in get(wsPath(wid)).data.memberRoles; }',
        'function inboxMember(uid) { return uid is string; }',
      ],
    ],
  ],
  [
    'inbox: agents decide outcomes',
    [
      [
        '((inboxOwner(resource.data)\n                && (inboxDecide(',
        '(((inboxOwner(resource.data) || isActiveAgent(wid))\n                && (inboxDecide(',
      ],
      [
        "'thread.asked', 'thread.woke', 'thread.titled', 'outcome.proposed',",
        "'thread.asked', 'thread.woke', 'thread.titled', 'outcome.proposed', 'outcome.approved',",
      ],
    ],
  ],
  [
    'inbox: any agent carries out',
    [
      ["return r.state == 'approved' && r.executor == me()", "return r.state == 'approved'"],
      ['&& inboxOutcomeOf(d.lastEventId).executor == me()', ''],
    ],
  ],
  [
    'inbox: carried out before approval',
    [
      [
        "return r.state == 'approved' && r.executor == me()",
        "return r.state in ['approved', 'proposed'] && r.executor == me()",
      ],
    ],
  ],
  // Inbox plans (item qwFAWxZM5xkcE7PPjAzi)
  [
    'plans: step carried out out of turn',
    [
      [
        "(isActiveAgent(wid) && turn && p.state in ['proposed', 'active']",
        "(isActiveAgent(wid) && p.state in ['proposed', 'active']",
      ],
    ],
  ],
  [
    'plans: step carried out before approval',
    [
      [
        ": r.state in ['approved', 'running']\n",
        ": r.state in ['approved', 'running', 'proposed']\n",
      ],
    ],
  ],
  [
    'plans: gate decided before its turn',
    [
      [
        "? turn && r.state == 'proposed' && d.state == 'done' && pa.cursor == p.cursor + 1",
        "? r.state == 'proposed' && d.state == 'done'",
      ],
    ],
  ],
  [
    'plans: cursor jumps',
    [
      ['let next = d.cursor == r.cursor + 1 && same', 'let next = d.cursor > r.cursor && same'],
      [
        "? d.state == 'done' && pa.cursor == p.cursor + 1",
        "? d.state == 'done' && pa.cursor > p.cursor",
      ],
    ],
  ],
  ['plans: done step reordered', [['inboxPlanFirstFree(r)))))', '0))))']]],
  ['plans: nine steps', [['d.steps.size() <= 8', 'd.steps.size() <= 9']]],
  [
    'plans: step on another thread',
    [
      [
        '&& d.planId is string && p.threadId == d.threadId && p.memberUid',
        '&& d.planId is string && p.memberUid',
      ],
      [
        "inboxDocTracked(d, ['plan.proposed'], d.memberUid, d.threadId))",
        "inboxTracked(d.lastEventId, ['plan.proposed'], d.memberUid))",
      ],
    ],
  ],
  [
    'inbox: plan-only type proposed alone',
    [['(d.type in outcomeSingle() ||', '(d.type in outcomeTypes() ||']],
  ],
  [
    'inbox: forged executor',
    [['&& d.executor == (d.type in outcomeImmediate() ? null : t.fetchedBy);', ';']],
  ],
  [
    'inbox: approved outcome thread state unchecked',
    [["&& d.state == 'waiting' && d.waiting == {'on': 'agent', 'until': null})", ')']],
  ],
  [
    'inbox: unknown outcome fields',
    [['return f is map && f.keys().hasOnly(outcomeFieldKeys()[type])', 'return f is map']],
  ],
  [
    "inbox: another member's subject",
    [["&& getAfter(inboxDoc('inboxSubjects', sid)).data.memberUid == member;", ';']],
  ],
  [
    'inbox: agent rewrites more than a subject area',
    [["&& touched(['area', 'label', 'labelSuggested', 'labelBy'])", '']],
  ],
  [
    'inbox: agent sets an area outside a filing',
    [
      [
        "inboxTracked(d.lastEventId, ['thread.filed'], r.memberUid)\n          && inboxEvOf(d).subjectId == sid;",
        'true;',
      ],
    ],
  ],
  [
    'inbox: unbounded area',
    [
      [
        "function inboxAreaOk(d) { return !('area' in d) || d.area == null || str(d.area, 1, 60); }",
        'function inboxAreaOk(d) { return true; }',
      ],
    ],
  ],
  [
    'inbox: agent confirms its own label',
    [["&& d.labelSuggested == true && d.labelBy == 'agent');", '&& true);']],
  ],
  [
    'inbox: agent overwrites a confirmed label',
    [["&& !(r.get('labelBy', null) == 'member')))", '&& true))']],
  ],
  [
    'inbox: unbounded agent label',
    [
      [
        "(d.keys().hasAll(['label', 'labelSuggested', 'labelBy']) && str(d.label, 1, 30)",
        "(d.keys().hasAll(['label', 'labelSuggested', 'labelBy'])",
      ],
    ],
  ],
  [
    'inbox: member label not marked confirmed',
    [["return d.labelSuggested == false && d.labelBy == 'member'", 'return true']],
  ],
  [
    'inbox: member label outside the list',
    [["&& (d.label in inboxLabelList() || ('label' in r && d.label == r.label))", '']],
  ],
  ['inbox: label change without its event', [["&& inboxEvOf(d).type == 'subject.label'))", '))']]],
  [
    'inbox: people create labelled subjects',
    [
      [
        "&& inboxNoLabel(d)\n                && d.createdBy == me_('human')",
        "&& d.createdBy == me_('human')",
      ],
    ],
  ],
  [
    'inbox: members edit the label list',
    [["return cid == 'labels' && isAdmin(wid)", "return cid == 'labels' && isMember(wid)"]],
  ],
  [
    'inbox: agents edit the label list',
    [
      [
        "return cid == 'labels' && isAdmin(wid)",
        "return cid == 'labels' && (isAdmin(wid) || isActiveAgent(wid))",
      ],
    ],
  ],
  ['inbox: unbounded label list', [['d.labels.size() <= 12', 'd.labels.size() <= 100']]],
  [
    'inbox: people write agent events',
    [
      [
        "'schedule.deleted', 'run.decided', 'agents.off', 'agents.on'])",
        "'schedule.deleted', 'run.decided', 'agents.off', 'agents.on', 'outcome.done'])",
      ],
    ],
  ],
  [
    'inbox: messages as anyone',
    [['&& d.fetchedBy == me() && d.createdAt == request.time;', '&& d.createdAt == request.time;']],
  ],
  [
    'inbox: no reopen',
    [
      [
        "? d.state == 'investigating' && d.waiting == null\n              : d.state == r.state",
        '? true\n              : d.state == r.state',
      ],
    ],
  ],
  [
    'inbox: any after-state',
    [['return d.state == outcomeAfter()[type]', 'return d.state is string']],
  ],
  ['inbox: early wake', [['&& r.waiting.until <= request.time', '']]],
  [
    "inbox: relate another member's subject",
    [['&& inboxSubjectOf(d.a, d.memberUid) && inboxSubjectOf(d.b, d.memberUid);', ';']],
  ],
  ['inbox: relation id forged', [["&& d.a < d.b && rid == 'rel-' + d.a + '-' + d.b", '']]],
  ['inbox: urgent not a boolean', [['&& request.resource.data.urgent is bool', '']]],
  [
    'inbox: agents propose a related link',
    [
      [
        "&& d.state == 'proposed'\n                && d.proposedBy == me_('agent')",
        "&& d.proposedBy == me_('agent')",
      ],
    ],
  ],
  // Decision data (item kt3E7u9EliL3q2veDDI0)
  [
    'inbox: any confidence',
    [
      [
        "|| d.confidence in ['high', 'medium', 'low'])\n          && d.get('sendBackTo', {})",
        "|| true)\n          && d.get('sendBackTo', {})",
      ],
      [
        "|| d.confidence in ['high', 'medium', 'low'])\n          && (!('checks' in d) || (d.checks is list && d.checks.size() <= 6))\n          // Alone",
        "|| true)\n          && (!('checks' in d) || (d.checks is list && d.checks.size() <= 6))\n          // Alone",
      ],
    ],
  ],
  [
    'inbox: unbounded checks',
    [
      [
        '(d.checks is list && d.checks.size() <= 6))\n          // Alone',
        '(d.checks is list))\n          // Alone',
      ],
    ],
  ],
  [
    'inbox: outcomes with any keys',
    [
      [
        "'decision', 'result', 'createdAt', 'updatedAt', 'lastEventId'],\n               ['confidence', 'checks'])",
        "'decision', 'result', 'createdAt', 'updatedAt', 'lastEventId'],\n               ['confidence', 'checks', 'score'])",
      ],
    ],
  ],
  [
    'inbox: due without its event',
    [
      [
        "['thread.due'], resource.data.memberUid, tid)",
        "['thread.due', 'thread.flagged'], resource.data.memberUid, tid)",
      ],
    ],
  ],
  [
    'inbox: due not a timestamp',
    [['&& (request.resource.data.due == null || request.resource.data.due is timestamp)', '']],
  ],
  ['inbox: due rewrites more', [["touched(['due'])", "touched(['due', 'state'])"]]],
  [
    'inbox: unbounded options',
    [
      [
        '(d.question.options is list && d.question.options.size() <= 4))',
        '(d.question.options is list))',
      ],
    ],
  ],
  [
    'inbox: questions with any keys',
    [
      [
        "keysOk(d.question, ['text', 'by', 'at', 'answer', 'answeredAt'],\n                   ['options'])",
        "d.question.keys().hasAll(['text', 'by', 'at', 'answer', 'answeredAt'])",
      ],
    ],
  ],
  [
    'inbox: the answer rewrites the question',
    [["&& d.question.diff(r.question).affectedKeys().hasOnly(['answer', 'answeredAt'])", '']],
  ],
  // Ask for changes (item L7OzWKMYZ1O2dX33Xkrj): one mutation per new invariant.
  ['inbox: any agent revises', [['            && r.proposedBy == me()\n', '']]],
  ['inbox: versions rewritten', [[': d.versions[0:prev.size()] == prev)', ': true)']]],
  [
    'inbox: v1 rewritten',
    [
      [
        "? d.versions[0] == {'n': 1, 'fields': r.fields, 'note': r.note,",
        "? d.versions[0].n == 1 || {'n': 1, 'fields': r.fields, 'note': r.note,",
      ],
    ],
  ],
  ['inbox: an 11th version', [[' && n <= 10\n', '\n']]],
  ['inbox: ask past 10 versions', [["&& r.get('versions', []).size() < 10)", ')']]],
  [
    'inbox: unbounded revise instruction',
    [['str(d.revise.instruction, 1, 500)', 'd.revise.instruction is string']],
  ],
  [
    'inbox: any revise chips',
    [["&& d.revise.chips.hasOnly(['shorter', 'formal', 'warmer', 'availability'])", '']],
  ],
  ['inbox: revision fields not the latest', [['&& last.fields == d.fields', '']]],
  [
    'inbox: revision with unknown fields',
    [
      [
        '&& inboxFieldsOk(r.type, d.fields)\n            && str(d.note, 0, 2000)',
        '&& str(d.note, 0, 2000)',
      ],
    ],
  ],
  ['inbox: approve keeps the revise request', [["&& d.get('revise', null) == null\n", '\n']]],
  [
    'inbox: approve any version',
    [["&& d.decision.version <= r.get('versions', []).size())))", ')))']],
  ],
  ['inbox: member rewrites fields while asking', [["touched(['state', 'revise'])", 'true']]],
  [
    'inbox: reject while revising',
    [
      [
        "&& r.state == 'proposed'\n                && exactKeys(d.decision",
        '&& exactKeys(d.decision',
      ],
    ],
  ], // Re-check (item bmNoIvvqKCdAorLSShE9).
  [
    'recheck: another member asks',
    [['(inboxOwner(resource.data) && inboxRecheckAsked(', '(inboxRecheckAsked(']],
  ],
  [
    'recheck: ask while pending',
    [["|| r.recheck.requestedAt + duration.value(30, 'm') <= request.time)", '|| true)']],
  ],
  [
    'recheck: ask with nothing open',
    [
      [
        "return touched(['recheck'])\n            && r.state in ['yourCall', 'waiting']",
        "return touched(['recheck'])",
      ],
    ],
  ],
  ['recheck: forged request', [["&& d.recheck.state == 'pending' && d.recheck.by == me()", '']]],
  ['recheck: any agent answers', [['            && r.fetchedBy == me()\n', '']]],
  [
    'recheck: answered twice',
    [
      [
        "&& r.get('recheck', null) != null && r.recheck.state == 'pending'\n            && exactKeys(d.recheck",
        '&& exactKeys(d.recheck',
      ],
    ],
  ],
  [
    'recheck: result not its event',
    [['\n            && inboxEv(d.lastEventId).data.data.result == d.recheck.result;', ';']],
  ],
  [
    'recheck: answer rewrites the request',
    [['&& d.recheck.by == r.recheck.by && d.recheck.requestedAt == r.recheck.requestedAt', '']],
  ],
  ['recheck: unbounded note', [['strOrNull(d.recheck.note, 500)', 'true']]],
  [
    'recheck: checkedAt without the answer',
    [
      [
        "\n            && getAfter(inboxDoc('inboxThreads', r.threadId)).data.lastEventId == d.lastEventId",
        '',
      ],
    ],
  ],
  [
    'recheck: checkedAt on a decided outcome',
    [
      [
        "data.lastEventId == d.lastEventId\n            && (r.state == 'proposed'",
        'data.lastEventId == d.lastEventId\n            && (true',
      ],
    ],
  ],
  [
    'recheck: checkedAt or revise at the cursor',
    [['&& !inboxAtCursor(get(inboxPlanDoc(r.planId)).data, oid)', '']],
  ],
  [
    'recheck: checkedAt with any result',
    [["&& e.data.data.result == 'still_good' && oid in e.data.data.checked", '']],
  ],
  ['recheck: checkedAt with other changes', [["touched(['checkedAt'])", 'true']]],
  [
    'recheck: unasked revise without a request',
    [
      [
        "return t.get('recheck', null) != null && t.recheck.state == 'pending' && t.fetchedBy == me()",
        'return true',
      ],
    ],
  ],
  [
    'recheck: unasked revise by another agent',
    [["&& t.recheck.state == 'pending' && t.fetchedBy == me()", "&& t.recheck.state == 'pending'"]],
  ],
  [
    'recheck: revised step keeps its approval',
    [["&& (r.state == 'approved' ? d.decision == null : d.decision == r.decision)", '']],
  ],
  [
    'recheck: unasked version with an ask',
    [
      [
        "&& last.asked == (r.state == 'revising'\n              ? {'instruction': r.revise.instruction, 'chips': r.revise.chips} : null);",
        ';',
      ],
    ],
  ],
  // Not now (item OE8FmrTaIxFVGcaeGG3N, slice 3).
  ['not now: another member', [['(inboxOwner(resource.data) && inboxNotNow(', '(inboxNotNow(']]],
  ['not now: any time', [["n.until <= request.time + duration.value(48, 'h') && ", '']]],
  ['not now: past time', [['&& n.until > request.time', '']]],
  ['not now: other fields too', [["return changed(['notNow', 'lastEventId']) && ", 'return ']]],
  ['not now: nothing waits', [[" && r.state in ['needsYou', 'yourCall']", '']]],
  ["not now: key not the event's", [['&& e.key == n.key && e.until == n.until;', ';']]],
  // Ask the agent (item w6O2KOw4ys70TQv9I1xD).
  [
    'instruct: another member asks',
    [['(inboxOwner(resource.data) && inboxInstructed(', '(inboxInstructed(']],
  ],
  [
    'instruct: ask while pending',
    [["|| r.instruct.at + duration.value(30, 'm') <= request.time)", '|| true)']],
  ],
  [
    'instruct: rewrite or drop earlier ones',
    [['&& diff.addedKeys() == [id].toSet() && diff.changedKeys().size() == 0', '&& true']],
  ],
  ['instruct: drop one below 20', [['? diff.removedKeys().size() == 0', '? true']]],
  [
    'instruct: drop two at 20',
    [[': diff.removedKeys().size() == 1 && d.instructions.size() == 20)', ': true)']],
  ],
  [
    'instruct: forged entry',
    [["&& n.by == me() && n.at == request.time && n.state == 'pending' && n.answer == null", '']],
  ],
  [
    'instruct: unbounded text or any chip',
    [
      [
        "&& ((n.chip == null && str(n.text, 1, 500))\n              || (n.text == null && n.chip in ['prepare_meeting', 'follow_up', 'summarize', 'draft_reply']))",
        '',
      ],
    ],
  ],
  [
    'instruct: latest not pointing at it',
    [["&& d.instruct == {'state': 'pending', 'id': id, 'at': request.time}", '']],
  ],
  ['instruct: event says other', [['\n            && e.text == n.text && e.chip == n.chip;', ';']]],
  [
    'instruct: any agent answers',
    [
      [
        "            && r.fetchedBy == me()\n            && r.get('instructions', null) != null",
        "            && r.get('instructions', null) != null",
      ],
    ],
  ],
  ['instruct: answered twice', [["            && a.state == 'pending'\n", '']]],
  [
    'instruct: answer rewrites the request',
    [['&& b.text == a.text && b.chip == a.chip && b.by == a.by && b.at == a.at', '']],
  ],
  [
    'instruct: answer touches others',
    [['&& d.instructions.diff(r.instructions).affectedKeys() == [id].toSet()', '']],
  ],
  [
    'instruct: answer unchecked',
    [
      [
        "&& (b.answer.kind in ['outcome', 'plan'] ? str(b.answer.refId, 1, 200) : b.answer.refId == null)\n            && strOrNull(b.answer.note, 500) && (b.answer.kind != 'note' || b.answer.note != null)",
        '',
      ],
    ],
  ],
  ['instruct: answer kind not its event', [['\n            && b.answer.kind == e.kind', '']]],
  [
    'instruct: latest state forged',
    [
      [
        "&& d.get('instruct', null) == (r.instruct.id == id\n              ? {'state': 'done', 'id': id, 'at': r.instruct.at} : r.instruct)",
        '',
      ],
    ],
  ],
  [
    'chips: any agent',
    [
      [
        "return touched(['suggestedChips'])\n            && r.fetchedBy == me()",
        "return touched(['suggestedChips'])",
      ],
    ],
  ],
  [
    'chips: unchecked list',
    [
      [
        "&& d.suggestedChips.hasOnly(['prepare_meeting', 'recheck', 'follow_up', 'summarize', 'draft_reply'])\n            && d.suggestedChips.toSet().size() == d.suggestedChips.size()",
        '',
      ],
    ],
  ],
  // Thread summaries (item OE8FmrTaIxFVGcaeGG3N).
  [
    'summary: any agent writes',
    [
      [
        '          && t.fetchedBy == me() && d.memberUid == t.memberUid',
        '          && d.memberUid == t.memberUid',
      ],
      [
        'return r.fetchedBy == me() && s.lastEventId == d.lastEventId',
        'return s.lastEventId == d.lastEventId',
      ],
    ],
  ],
  ['summary: version skip', [['&& d.version == prev + 1 &&', '&& d.version > prev &&']]],
  [
    'summary: without its version doc',
    [['\n          && existsAfter(inboxSummaryVersionDoc(tid, d.version))', '']],
  ],
  [
    'summary: without the mirror',
    [
      [
        "\n          && getAfter(inboxDoc('inboxThreads', tid)).data.get('summary', {}).get('version', 0) == d.version;",
        ';',
      ],
    ],
  ],
  [
    'summary: 6 bullets',
    [
      [
        'return l is list && l.size() >= 1 && l.size() <= 5',
        'return l is list && l.size() >= 1 && l.size() <= 6',
      ],
      [
        'd.bullets.size() >= 1 && d.bullets.size() <= 5',
        'd.bullets.size() >= 1 && d.bullets.size() <= 6',
      ],
    ],
  ],
  [
    'summary: 5 visuals',
    [
      ['return l.size() <= 4\n', 'return l.size() <= 5\n'],
      ['d.visuals is list && d.visuals.size() <= 4', 'd.visuals is list && d.visuals.size() <= 5'],
    ],
  ],
  [
    'summary: unknown visual kind',
    [
      [
        "return v.kind in ['bar', 'line', 'stacked_bar', 'number', 'flow', 'before_after', 'timeline', 'image', 'image_pair']\n",
        'return true\n',
      ],
    ],
  ],
  ['summary: chart with 25 points', [['v.x.size() >= 2 && v.x.size() <= 24', 'v.x.size() >= 2']]],
  [
    'summary: chart with 5 series',
    [['v.series.size() >= 1 && v.series.size() <= 4', 'v.series.size() >= 1']],
  ],
  [
    'summary: flow with 9 nodes',
    [['v.nodes.size() >= 2 && v.nodes.size() <= 8', 'v.nodes.size() >= 2']],
  ],
  ['summary: html in a title', [["&& !v.matches('(?s).*<[a-zA-Z/!].*')", '']]],
  [
    'summary: ask with no visual and no reason',
    [['(d.ask == null || d.visuals.size() > 0 || d.noVisualWhy != null)', 'true']],
  ],
  [
    'summary: mirror differs',
    [
      [
        "            && d.summary == {'version': s.version, 'at': s.at, 'headline': s.headline, 'ask': s.ask,\n                 'answer': s.answer, 'recAction': s.recommendation == null ? null : s.recommendation.action,\n                 'confidence': s.confidence}\n",
        '',
      ],
    ],
  ],
  [
    'summary: version doc differs',
    [
      [
        '          && d.headline == s.headline && d.ask == s.ask && d.answer == s.answer\n          && d.recommendation == s.recommendation && d.confidence == s.confidence\n          && d.details == s.details && d.noVisualWhy == s.noVisualWhy && d.basis == s.basis\n',
        '',
      ],
    ],
  ],
  [
    'summary: version doc under any id',
    [["return vid == d.threadId + '_' + string(d.version)\n          && ", 'return ']],
  ],
  // Thread attachments and image visuals (slice 4).
  [
    'summary: image of another thread',
    [["v.kind == 'image' ? summaryAtt(v.attachment, t)", "v.kind == 'image' ? true"]],
  ],
  [
    'summary: image pair of another thread',
    [['summaryAtt(v.before, t) && summaryAtt(v.after, t)', 'true']],
  ],
  [
    'attachment: any agent',
    [
      [
        '&& summaryAtt(aid, d.threadId) && t.fetchedBy == me() &&',
        '&& summaryAtt(aid, d.threadId) &&',
      ],
    ],
  ],
  [
    'attachment: another member',
    [
      [
        't.fetchedBy == me() && d.memberUid == t.memberUid\n            && d.by == me()',
        't.fetchedBy == me()\n            && d.by == me()',
      ],
    ],
  ],
  ['attachment: any id', [['&& summaryAtt(aid, d.threadId) && t.fetchedBy', '&& t.fetchedBy']]],
  [
    'attachment: any image',
    [
      [
        "\n                && (d.kind != 'image' || d.content.matches('data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+'))",
        '',
      ],
    ],
  ],
  ['attachment: http links', [["d.url.matches('https://[^ ]+')", "d.url.matches('[a-z]+:.+')"]]],
  [
    'attachment: untracked',
    [["\n            && inboxDocTracked(d, ['thread.attached'], d.memberUid, d.threadId);", ';']],
  ],
  [
    'attachment: mutable',
    [
      [
        'allow create: if isActiveAgent(wid) && inboxAttOk(request.resource.data);',
        'allow create: if isActiveAgent(wid) && inboxAttOk(request.resource.data);\n        allow update, delete: if true;',
      ],
    ],
  ],
  [
    'attachment: read by anyone',
    [
      [
        'match /inboxAttachments/{aid} {\n        allow read: if inboxReader(resource.data);',
        'match /inboxAttachments/{aid} {\n        allow read: if signedIn();',
      ],
    ],
  ],
  // Development plans (item OE8FmrTaIxFVGcaeGG3N, slice 6): New thread and send back.
  [
    'new thread: for any agent',
    [
      [
        '(a || (inboxOwner(d) && activeAgentDoc(get(agentPath(wid, d.fetchedBy)))))',
        '(a || inboxOwner(d))',
      ],
    ],
  ],
  [
    'new thread: any state',
    [
      [
        "(a || p == null ? d.state == 'investigating' && d.waiting == null",
        '(a || p == null ? true',
      ],
    ],
  ],
  [
    'new thread: agent other than its event',
    [["\n          && inboxEvOf(d).data.get('agentUid', d.fetchedBy) == d.fetchedBy", '']],
  ],
  [
    'new thread: steps approved at will',
    [
      [
        "d.state == (e.type == 'thread.created' && !(d.type in outcomeHuman()) ? 'approved' : 'proposed')",
        "d.state in ['approved', 'proposed']",
      ],
    ],
  ],
  [
    'plans: agent plan starts active',
    [
      ["d.state == (a ? 'proposed' : 'active')", "d.state in ['proposed', 'active']"],
      ["&& p.state == 'proposed' && p.proposedBy == me()", '&& p.proposedBy == me()'],
    ],
  ],
  [
    'new thread: step executor free',
    [
      [
        "\n                && inboxProposalOk(d, getAfter(inboxDoc('inboxThreads', d.threadId)).data)",
        '',
      ],
    ],
  ],
  [
    'send back: an agent at a gate',
    [
      [
        "&& (c.type in outcomeHuman() || r.state == 'blocked' ? inboxOwner(r)\n",
        "&& (c.type in outcomeHuman() ? inboxOwner(r) || isActiveAgent(wid) : r.state == 'blocked' ? inboxOwner(r)\n",
      ],
    ],
  ],
  ['send back: any count', [['&& d.sentBack.n == n', '']]],
  ['send back: any target', [['\n            && d.sentBack.to == e.outcomeId', '\n           ']]],
  [
    'send back: never blocks',
    [["d.state == (n >= 3 ? 'blocked' : 'active')", "d.state == 'active'"]],
  ],
  ['send back: any cursor', [['&& d.cursor == e.to && e.from', '&& e.from']]],
  [
    'send back: gate stays passed',
    [["d.state == 'proposed' && d.decision == null\n", 'd.decision == null\n']],
  ],
  [
    'gate: summary version of any type',
    [["\n                      && d.decision.get('summaryVersion', 1) is int", '']],
  ],
  // Long steps (item OE8FmrTaIxFVGcaeGG3N, slice 6b): progress by the executor, in bounds.
  [
    'step progress: any agent',
    [
      [
        "e.type == 'step.progress' && isActiveAgent(wid) && r.executor == me()\n",
        "e.type == 'step.progress' && isActiveAgent(wid)\n",
      ],
    ],
  ],
  [
    'step progress: any percent',
    [
      [
        '|| (d.progress.percent is int && d.progress.percent >= 0 && d.progress.percent <= 100))',
        '|| true)',
      ],
    ],
  ],
  [
    'step progress: other fields too',
    [["&& touched(['progress']) && d.progress.keys()", '&& d.progress.keys()']],
  ],
  [
    'step progress: not running',
    [
      [
        "(turn ? r.state == 'running' : r.type == 'keepgreen' && r.state == 'done')\n              && r.type in outcomeLong()",
        'turn',
      ],
    ],
  ],
  // Keep green (slice 6c): re-checks on its done step only, with a known check; a plan blocked
  // by a failed step goes back by the member only, the failed step reset.
  [
    'keep green: progress on any done step',
    [["r.type == 'keepgreen' && r.state == 'done'", "r.state == 'done'"]],
  ],
  [
    'keep green: any check',
    [
      [
        "\n              && d.progress.get('check', null) in [null, 'green', 'rechecking', 'blocked']",
        '',
      ],
    ],
  ],
  [
    'send back: a blocked plan by the agent',
    [["|| r.state == 'blocked' ? inboxOwner(r)", '? inboxOwner(r)']],
  ],
  [
    'send back: a failed step stays failed',
    [
      [
        "r.state in ['done', 'running', 'failed'] && pa.cursor",
        "r.state in ['done', 'running'] && pa.cursor",
      ],
    ],
  ],
  [
    'summary: deletes newer versions',
    [
      [
        '\n          && resource.data.version <= getAfter(inboxSummaryDoc(resource.data.threadId)).data.version - 20;',
        ';',
      ],
    ],
  ],
  // Scheduled tasks (slice 2): only the member activates, edits, pauses, deletes his schedules
  // and decides his runs; agents only propose, as the thread's home agent, with the outcome;
  // runs are the scheduler's; the Off switch is the member's own.
  [
    'schedule: agent proposes it active',
    [
      [
        "return d.state == 'proposed' && d.activeFrom == null && d.agentUid == me()",
        'return d.agentUid == me()',
      ],
    ],
  ],
  [
    'schedule: proposal not by the home agent',
    [
      [
        '&& d.proposal.by == me() && t.fetchedBy == me() && t.memberUid',
        '&& d.proposal.by == me() && t.memberUid',
      ],
    ],
  ],
  [
    'schedule: proposal without its outcome',
    [["\n          && existsAfter(inboxDoc('inboxOutcomes', d.proposal.outcomeId))", '']],
  ],
  [
    'schedule: outcome without its schedule',
    [
      [
        "(d.type in outcomeSingle() || (d.type == 'schedule'\n            && getAfter(inboxDoc('schedules', d.fields.scheduleId)).data.proposal.outcomeId == oid))",
        "(d.type in outcomeSingle() || d.type == 'schedule')",
      ],
    ],
  ],
  ["schedule: change of someone else's schedule", [['(x.memberUid == d.memberUid && ', '(']]],
  ['schedule: change of a schedule another agent runs', [['&& x.agentUid == me() && ', '&& ']]],
  [
    'schedule: member makes one for a revoked agent',
    [['\n              && activeAgentDoc(get(agentPath(wid, d.agentUid)))', '']],
  ],
  [
    'schedule: any time of day',
    [["\n          && r.at is string && r.at.matches('([01][0-9]|2[0-3]):[0-5][0-9]')", '']],
  ],
  [
    'schedule: another member edits',
    [
      [
        'return inboxOwner(r) && schedOk(d) && d.version == r.version + 1',
        'return isMember(wid) && schedOk(d) && d.version == r.version + 1',
      ],
    ],
  ],
  [
    'schedule: activated without approving its outcome',
    [["? e.type == 'outcome.approved' && r.replaces == null", '? r.replaces == null']],
  ],
  [
    'schedule: a new rule keeps activeFrom',
    [
      [
        'd.activeFrom == r.activeFrom && d.rule == r.rule && (',
        'd.activeFrom == r.activeFrom && (',
      ],
    ],
  ],
  ['schedule: resume keeps activeFrom', [["(r.state == 'active' || d.state != 'active')", 'true']]],
  [
    'schedule: another member deletes',
    [
      [
        "allow delete: if inboxOwner(resource.data)\n          && inboxTracked('del-schedule-",
        "allow delete: if isMember(wid)\n          && inboxTracked('del-schedule-",
      ],
    ],
  ],
  [
    'schedule: delete untracked',
    [
      [
        "\n          && inboxTracked('del-schedule-' + sid, ['schedule.deleted', 'outcome.rejected', 'outcome.approved'], me());",
        ';',
      ],
    ],
  ],
  [
    'run: decided by another member',
    [
      [
        "return inboxOwner(r) && r.state == 'cantRun'",
        "return isMember(wid) && r.state == 'cantRun'",
      ],
    ],
  ],
  ['run: decided from any state', [["&& r.state == 'cantRun'\n", '\n']]],
  ['run: try later in the past', [['&& d.laterAt > request.time\n', '\n']]],
  [
    'run: try later unbounded',
    [["\n              && d.laterAt <= request.time + duration.value(35, 'd')", '']],
  ],
  [
    'run: decided in someone else’s name',
    [['d.decision.by == me() && d.decision.at', 'd.decision.at']],
  ],
  [
    'run: choice and state differ',
    [
      [
        "\n          && d.state == {'runNow': 'runNow', 'later': 'later', 'skip': 'skipped'}[c]",
        '',
      ],
    ],
  ],
  [
    "off: another member's switch",
    [
      [
        "return uid == me() && isMember(wid)\n          && exactKeys(d, ['all', 'agents', 'since'",
        "return isMember(wid)\n          && exactKeys(d, ['all', 'agents', 'since'",
      ],
    ],
  ],
  [
    'off: agents write it',
    [
      [
        "return uid == me() && isMember(wid)\n          && exactKeys(d, ['all', 'agents', 'since'",
        "return (isMember(wid) || isActiveAgent(wid))\n          && exactKeys(d, ['all', 'agents', 'since'",
      ],
      [
        "'plan.sent_back', 'step.progress']));",
        "'plan.sent_back', 'step.progress', 'agents.on']));",
      ],
    ],
  ],
  ['off: since in the past', [['\n          && d.since == (off ? request.time : null)', '']]],
];

// A search text that no longer matches (the rules were refactored) would check nothing: it is
// reported as a STALE failure with its name, and the rest of the suite still runs.
const isStale = (edits) => edits.find(([find, rep]) => !original.includes(find) || find === rep);

const runSuite = (rulesFile, verbose = false) =>
  new Promise((resolve) => {
    // MUTATE_FILES="rules/inbox.test.ts" runs only those test files (a quick check of new mutations).
    const files = process.env.MUTATE_FILES?.split(',').map((f) => f.trim()) ?? [];
    // MUTATE_SUITE_CMD replaces the vitest command (a seam for the script tests).
    const [cmd, ...args] = process.env.MUTATE_SUITE_CMD
      ? ['sh', '-c', process.env.MUTATE_SUITE_CMD]
      : ['npx', 'vitest', 'run', '-c', 'vitest.rules.config.ts', '--reporter=dot', ...files];
    let out = '';
    child = spawn(cmd, args, {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HIVE_RULES_FILE: rulesFile },
    });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      child = null;
      if (code !== 0 && verbose) console.error(out.split('\n').slice(-40).join('\n'));
      resolve(code === 0);
    });
  });
assertWellFormed(MUTATIONS);
// The suite must pass on the unmutated rules, or "a test failed" proves nothing.
writeFileSync(TEMP_RULES, original);
if (!(await runSuite(TEMP_RULES, true))) {
  console.error('The rules suite fails on the unmutated rules: fix it before mutating.');
  process.exit(2);
}

// MUTATE_ONLY="name one,name two" runs just those mutations (the full run takes about 2 hours).
const only = process.env.MUTATE_ONLY?.split(',').map((n) => n.trim());
const results = [];
{
  for (const [name, edits] of MUTATIONS) {
    if (only && !only.includes(name)) continue;
    const missing = isStale(edits);
    if (missing) {
      results.push([name, 'STALE']);
      console.log(`STALE     ${name}: ${JSON.stringify(missing[0].slice(0, 80))}`);
      continue;
    }
    writeFileSync(TEMP_RULES, applyEdits(original, edits));
    const caught = !(await runSuite(TEMP_RULES));
    results.push([name, caught ? 'caught' : 'SURVIVED']);
    console.log(`${caught ? 'caught  ' : 'SURVIVED'}  ${name}`);
  }
}
const bad = results.filter(([, r]) => r !== 'caught');
console.log(`\n${results.length - bad.length}/${results.length} mutations caught`);
if (bad.length) {
  for (const [n, r] of bad) console.log(`  ${r}: ${n}`);
  process.exit(1);
}
