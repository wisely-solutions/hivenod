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

/** [name, find, replace] — `find` must occur in the rules (all occurrences are replaced). */
const AGENT_TYPES = "'item.claimed', 'item.released', 'item.completed', 'item.updated',";
/**
 * [name, [[find, replace], …]]. Every `find` must occur in the rules (all occurrences are
 * replaced). Where a promise is enforced by two independent layers, the mutation removes both.
 */
const MUTATIONS = [
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
    'agents may decide',
    [
      [
        "return canProject(wid, pid)\n            && (exactKeys(d, ['workspaceId', 'projectId', 'itemId', 'itemTitle',",
        "return (canProject(wid, pid) || projectAgent(wid, pid))\n            && (exactKeys(d, ['workspaceId', 'projectId', 'itemId', 'itemTitle',",
      ],
      [AGENT_TYPES, AGENT_TYPES + " 'decision.approved', 'decision.sentBack', 'decision.stopped',"],
    ],
  ],
  [
    'non-deciders may decide',
    [
      ['&& me() in stepOf(p, r.stepId).gate.deciderUids', ''],
      ['&& me() in stepOf(p, d.stepId).gate.deciderUids', ''],
    ],
  ],
  [
    'gate rule ignored',
    [
      [
        'let valid = approvedSet.intersection(g.deciderUids.toSet());\n      return valid.hasAll',
        'let valid = approvedSet.intersection(g.deciderUids.toSet());\n      return true || valid.hasAll',
      ],
    ],
  ],
  ['atLeast ignores n', [['valid.size() >= g.n', 'valid.size() >= 1']]],
  ['all needs only one', [['&& valid.hasAll(g.deciderUids)));', '&& valid.size() >= 1));']]],
  ['mustInclude ignored', [['return valid.hasAll(g.mustInclude) && (', 'return (']]],
  [
    'non-deciders count to n',
    [['let valid = approvedSet.intersection(g.deciderUids.toSet());', 'let valid = approvedSet;']],
  ],
  ['majority ignored', [['valid * 2 > g.deciderUids.size()', 'valid >= 1']]],
  ['claims never stale', [["duration.value(10, 'm')", "duration.value(0, 'm')"]]],
  [
    'claims never expire',
    [["|| r.claim.heartbeatAt < request.time - duration.value(10, 'm')", '|| true']],
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
    'event scope not checked',
    [['.data.itemId == iid;\n    }', '.data.itemId == iid || true;\n    }']],
  ],
  [
    'events editable',
    [
      [
        'allow update, delete: if false;\n      }\n\n      // ---------- calendar (Inbox item w9SAf; removed',
        'allow update, delete: if true;\n      }\n\n      // ---------- calendar (Inbox item w9SAf; removed',
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
  ['agents unscoped', [["&& (a.projectIds == '*' || pid in a.projectIds);", '&& true;']]],
  [
    'agents skip steps',
    [
      [
        "&& nextOk(d, r, p)\n              && itemTracked(wid, d, ['item.completed']",
        "&& itemTracked(wid, d, ['item.completed']",
      ],
    ],
  ],
  // ----- per-item paths (card st5INNZj) -----
  [
    'paths: jumps over unskipped steps',
    [['return j > i && gap0(p, i, j, k, g);', 'return j > i;']],
  ],
  [
    'paths: agents skip gates',
    [
      [
        "function skipped(s, k, g) { return s.id in (s.kind == 'agent' ? k : g); }",
        'function skipped(s, k, g) { return s.id in k || s.id in g; }',
      ],
    ],
  ],
  [
    'paths: anyone skips a gate',
    [["? type == 'human' && me() in stepOf(p, st).gate.deciderUids", '? true']],
  ],
  [
    'paths: non-deciders settle requests',
    [
      [
        "&& me() in stepOf(p, st).gate.deciderUids\n              && d.get('pathRequests', {})",
        "\n              && d.get('pathRequests', {})",
      ],
    ],
  ],
  [
    'paths: agents ask again after a refusal',
    [["&& (type == 'human' || !(st in r.get('pathRefused', [])))", '']],
  ],
  ['paths: unshaped items decided', [['              && !unshaped(r)\n', '\n']]],
  [
    'paths: unshaped items worked',
    [
      ['(claimIt(r, p, true, d)', '(claimIt(r, p, false, d)'],
      ["(shaping ? run.data.get('job', '') == 'shape' : agentAllowedAtStep(p, r.stepId))", 'true'],
    ],
  ],
  [
    'paths: steps behind change',
    [
      [
        '&& hasStep(p, st) && p.stepIndex[st] > p.stepIndex[r.stepId]\n              && d.get',
        '&& hasStep(p, st)\n              && d.get',
      ],
    ],
  ],
  [
    'proposals: anyone accepts',
    [
      [
        'allow update: if isMember(wid) && canSetStepAgents(wid, get(projPath(wid, pid)).data)',
        'allow update: if isMember(wid)',
      ],
    ],
  ],
  [
    'agents act at human steps',
    [
      [
        ": stepOf(p, r.stepId).kind == 'agent'\n                  // Releasing",
        ': true\n                  // Releasing',
      ],
    ],
  ],
  [
    'gate may arrive pre-approved',
    [
      [
        "&& d.gate == {'stepId': p.steps[idx].id, 'approvals': {}, 'rejections': {}})",
        '&& d.gate != null)',
      ],
    ],
  ],
  [
    'heartbeat events uncoalesced',
    [["request.time >= resource.data.heartbeatEventAt + duration.value(5, 'm')", 'true']],
  ],
  [
    'heartbeats never need events',
    [["request.time < resource.data.heartbeatEventAt + duration.value(6, 'm')", 'true']],
  ],
  [
    'item heartbeat decoupled',
    [['&& getAfter(runPath(wid, r.claim.runId)).data.heartbeatAt == request.time', '']],
  ],
  [
    'claims for others',
    [
      [
        '&& d.claim.agentUid == me() && d.claim.heartbeatAt == request.time\n              && d.status',
        '&& d.claim.heartbeatAt == request.time\n              && d.status',
      ],
      [
        '&& run != null && run.data.agentUid == me() && run.data.itemId == iid',
        '&& run != null && run.data.itemId == iid',
      ],
      [
        'return it.claim.runId == rid && it.claim.agentUid == me() &&',
        'return it.claim.runId == rid &&',
      ],
    ],
  ],
  [
    'claim without run',
    [
      [
        "&& run != null && run.data.agentUid == me() && run.data.itemId == iid\n              && run.data.projectId == pid && run.data.stepId == r.stepId\n              && run.data.status == 'running'\n",
        '\n',
      ],
    ],
  ],
  ['send back forward', [['&& p.stepIndex[d.stepId] < p.stepIndex[r.stepId]', '']]],
  ['send back count free', [['&& d.sendBackCount == r.sendBackCount + 1', '']]],
  [
    'decision optional',
    [
      [
        'let dec = getAfter(decisionPath(wid, pid, request.resource.data.lastEventId));\n            return dec != null && dec.data.itemId == iid && dec.data.outcome == outcome\n              && dec.data.byUid == me()\n              &&',
        'return ',
      ],
      // The item rules route by the decision's outcome: without a decision, take it from the event.
      [
        "let outcome = dec == null ? '' : dec.data.outcome;",
        "let outcome = dec == null ? getAfter(eventPath(wid, request.resource.data.lastEventId)).data.type.split('[.]')[1] : dec.data.outcome;",
      ],
    ],
  ],
  ['double voting', [['&& !(me() in r.gate.approvals) && !(me() in r.gate.rejections)', '']]],
  [
    'humans move items',
    [
      [
        "touched(['title', 'summary', 'type', 'order'])",
        "changed(['title', 'summary', 'type', 'order', 'updatedAt', 'lastEventId', 'stepId', 'status', 'gate', 'claim'])",
      ],
    ],
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
  // The project delete rule is now a flat `if false` (projects are archived; only an organization
  // delete removes them). The old admin-plus-tracked-event rule no longer exists.
  [
    'project delete by members',
    [
      [
        'only an organization delete removes them.\n        allow delete: if false;',
        'only an organization delete removes them.\n        allow delete: if isMember(wid);',
      ],
    ],
  ],
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
  ['log cap lifted', [['int(n) < 500', 'int(n) < 501']]],
  [
    'outsiders read',
    [['allow read: if isMember(wid) || isActiveAgent(wid);', 'allow read: if signedIn();']],
  ],
  ['untriaged findings claimable', [["&& !(r.type == 'finding' && r.triage == null)", '']]],
  [
    'attachments oversize',
    [
      ['str(d.content, 0, 921600)', 'str(d.content, 0, 2000000)'],
      ['d.bytes <= 921600', 'd.bytes <= 2000000'],
    ],
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
    'plans: agent decides a step',
    [
      [
        "'thread.instruction_answered', 'thread.chips_suggested', 'summary.written', 'thread.attached',\n                  'plan.sent_back']));",
        "'thread.instruction_answered', 'thread.chips_suggested', 'summary.written', 'thread.attached',\n                  'plan.sent_back', 'outcome.approved']));",
      ],
      [
        '|| (inboxOwner(r) && inboxPlanLive(p)',
        '|| ((inboxOwner(r) || isActiveAgent(wid)) && inboxPlanLive(p)',
      ],
      ['return (inboxOwner(r)\n', 'return ((inboxOwner(r) || isActiveAgent(wid))\n'],
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
  // Slice 9: cursorAt only ever takes the time of the write (decision insights trust the wait).
  [
    'plans: cursorAt any time',
    [["          && d.get('cursorAt', 0) in [r.get('cursorAt', 0), request.time]\n", '']],
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
  [
    'plans: agent edits steps',
    [
      [
        "'thread.instruction_answered', 'thread.chips_suggested', 'summary.written', 'thread.attached',\n                  'plan.sent_back']));",
        "'thread.instruction_answered', 'thread.chips_suggested', 'summary.written', 'thread.attached',\n                  'plan.sent_back', 'plan.edited']));",
      ],
      ['return (inboxOwner(r)\n', 'return ((inboxOwner(r) || isActiveAgent(wid))\n'],
    ],
  ],
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
    [['&& d.type in outcomeSingle()', '&& d.type in outcomeTypes()']],
  ],
  [
    'inbox: forged executor',
    [['&& d.executor == (d.type in outcomeImmediate() ? null : t.fetchedBy);', ';']],
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
        "'thread.instructed', 'thread.not_now', 'thread.created', 'plan.sent_back'])",
        "'thread.instructed', 'thread.not_now', 'thread.created', 'plan.sent_back', 'outcome.done'])",
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
  ['inbox: an item link without the item', [['|| inboxItemMade(d))', '|| true)']]],
  [
    "inbox: linking another member's thread",
    [["&& get(inboxDoc('inboxThreads', e.threadId)).data.memberUid == me()", '']],
  ],
  [
    'inbox: agents decide relations',
    [
      [
        "'thread.instruction_answered', 'thread.chips_suggested', 'summary.written', 'thread.attached',\n                  'plan.sent_back']));",
        "'thread.instruction_answered', 'thread.chips_suggested', 'summary.written', 'thread.attached',\n                  'plan.sent_back', 'relation.accepted']));",
      ],
      [
        "return inboxOwner(r)\n          && touched(['state', 'note', 'decision'",
        "return (inboxOwner(r) || isActiveAgent(wid))\n          && touched(['state', 'note', 'decision'",
      ],
      [
        "['relation.accepted', 'relation.created', 'relation.rejected', 'relation.removed'], me())",
        "['relation.accepted', 'relation.created', 'relation.rejected', 'relation.removed'], resource.data.memberUid)",
      ],
    ],
  ],
  [
    "inbox: relate another member's subject",
    [['&& inboxSubjectOf(d.a, d.memberUid) && inboxSubjectOf(d.b, d.memberUid);', ';']],
  ],
  ['inbox: relation id forged', [["&& d.a < d.b && rid == 'rel-' + d.a + '-' + d.b", '']]],
  ['inbox: urgent not a boolean', [['&& d.urgent is bool', '']]],
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
    [["['thread.due'], r.memberUid, tid)", "['thread.due', 'thread.flagged'], r.memberUid, tid)"]],
  ],
  ['inbox: due not a timestamp', [['&& (d.due == null || d.due is timestamp)', '']]],
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
    [['(inboxOwner(r) && inboxRecheckAsked(', '(inboxRecheckAsked(']],
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
  ['not now: another member', [['(inboxOwner(r) && inboxNotNow(', '(inboxNotNow(']]],
  ['not now: any time', [["n.until <= request.time + duration.value(48, 'h') && ", '']]],
  ['not now: past time', [['&& n.until > request.time', '']]],
  ['not now: other fields too', [["return changed(['notNow', 'lastEventId']) && ", 'return ']]],
  ['not now: nothing waits', [[" && r.state in ['needsYou', 'yourCall']", '']]],
  ["not now: key not the event's", [['&& e.key == n.key && e.until == n.until;', ';']]],
  // Ask the agent (item w6O2KOw4ys70TQv9I1xD).
  ['instruct: another member asks', [['(inboxOwner(r) && inboxInstructed(', '(inboxInstructed(']]],
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
    [["? inboxOwner(r) && c.state == 'proposed'", "? c.state == 'proposed'"]],
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
        "e.type == 'step.progress' && isActiveAgent(wid) && r.executor == me() && turn",
        "e.type == 'step.progress' && isActiveAgent(wid) && turn",
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
    [["&& touched(['progress']) && exactKeys(d.progress", '&& exactKeys(d.progress']],
  ],
  [
    'step progress: not running',
    [["\n              && r.state == 'running' && r.type in outcomeLong()", '\n             ']],
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
