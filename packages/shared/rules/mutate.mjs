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
  [
    'agent cliVersion unbounded',
    [["&& strOrNull(request.resource.data.get('cliVersion', null), 40))", '&& true)']],
  ],
  [
    'cliVersion without presence',
    [
      [
        "&& request.resource.data.lastSeenAt == request.time\n            && strOrNull(request.resource.data.get('seenHost', null), 80)",
        "&& strOrNull(request.resource.data.get('seenHost', null), 80)",
      ],
    ],
  ],
  [
    'agents may decide',
    [
      [
        "allow create: if canProject(wid, pid)\n            && (exactKeys(request.resource.data, ['workspaceId', 'projectId', 'itemId', 'itemTitle',",
        "allow create: if (canProject(wid, pid) || projectAgent(wid, pid))\n            && (exactKeys(request.resource.data, ['workspaceId', 'projectId', 'itemId', 'itemTitle',",
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
      [
        '&& request.resource.data.at == request.time\n          && request.resource.data.data is map',
        '&& request.resource.data.data is map',
      ],
    ],
  ],
  [
    'event actor not checked',
    [
      ['&& e.data.actor.id == me() && e.data.at', '&& e.data.at'],
      ['&& request.resource.data.actor.id == me()\n', '\n'],
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
        'allow update, delete: if false;\n\n        // Calendar writes (item w9SAf)',
        'allow update, delete: if true;\n\n        // Calendar writes (item w9SAf)',
      ],
    ],
  ],
  [
    'agents emit human events',
    [
      [
        "request.resource.data.actor.type == 'human' && isMemberAfter(wid)",
        '(isMemberAfter(wid) || isActiveAgent(wid))',
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
        "&& nextOk(d, r, p)\n              && trackedFor(wid, d.lastEventId, ['item.completed']",
        "&& trackedFor(wid, d.lastEventId, ['item.completed']",
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
      ['(claimIt(wid, pid, iid, r, p, true)', '(claimIt(wid, pid, iid, r, p, false)'],
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
        "changed(['title', 'summary', 'type', 'order', 'updatedAt', 'lastEventId'])",
        "changed(['title', 'summary', 'type', 'order', 'updatedAt', 'lastEventId', 'stepId', 'status', 'gate', 'claim'])",
      ],
    ],
  ],
  [
    'groups by members',
    [
      [
        "allow create, update: if isAdmin(wid)\n          && exactKeys(request.resource.data, ['name', 'memberUids'",
        "allow create, update: if isMember(wid)\n          && exactKeys(request.resource.data, ['name', 'memberUids'",
      ],
    ],
  ],
  [
    'agents by members',
    [
      [
        'allow create: if (isAdmin(wid) || memberConnects(request.resource.data)) && verified()\n          && aid != me()',
        'allow create: if isMember(wid) && verified()\n          && aid != me()',
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
        "&& resource.data.email == request.auth.token.get('email', '').lower()\n          && tracked",
        '&& tracked',
      ],
    ],
  ],
  [
    'expired invites ok',
    [
      ['&& resource.data.expiresAt > request.time\n', '\n'],
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
      [
        'str(request.resource.data.content, 0, 921600)',
        'str(request.resource.data.content, 0, 2000000)',
      ],
      ['request.resource.data.bytes <= 921600', 'request.resource.data.bytes <= 2000000'],
    ],
  ],
  // Inbox (item 4PEHrOW5IfXBQWgOK9wo)
  [
    'inbox: other members read',
    [
      [
        'function inboxOwner(wid, d) { return isMember(wid) && d.memberUid == me(); }',
        'function inboxOwner(wid, d) { return isMember(wid); }',
      ],
    ],
  ],
  [
    'inbox: for anyone',
    [
      [
        'function inboxMember(wid, uid) { return uid is string && uid in get(wsPath(wid)).data.memberRoles; }',
        'function inboxMember(wid, uid) { return uid is string; }',
      ],
    ],
  ],
  [
    'inbox: agents decide outcomes',
    [
      [
        '((inboxOwner(wid, resource.data)\n                && (inboxDecide(',
        '(((inboxOwner(wid, resource.data) || isActiveAgent(wid))\n                && (inboxDecide(',
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
      ['&& inboxOutcomeOf(wid, d.lastEventId).executor == me()', ''],
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
        "'plan.proposed', 'outcome.started']));",
        "'plan.proposed', 'outcome.started', 'outcome.approved']));",
      ],
      [
        'return (inboxOwner(wid, r) && inboxPlanLive(p)',
        'return ((inboxOwner(wid, r) || isActiveAgent(wid)) && inboxPlanLive(p)',
      ],
      ['return (inboxOwner(wid, r)\n', 'return ((inboxOwner(wid, r) || isActiveAgent(wid))\n'],
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
  ['plans: done step reordered', [['inboxPlanFirstFree(wid, r)))))', '0))))']]],
  [
    'plans: agent edits steps',
    [
      [
        "'plan.proposed', 'outcome.started']));",
        "'plan.proposed', 'outcome.started', 'plan.edited']));",
      ],
      ['return (inboxOwner(wid, r)\n', 'return ((inboxOwner(wid, r) || isActiveAgent(wid))\n'],
    ],
  ],
  [
    'plans: nine steps',
    [['request.resource.data.steps.size() <= 8', 'request.resource.data.steps.size() <= 9']],
  ],
  [
    'plans: step on another thread',
    [
      [
        '&& d.planId is string && p.threadId == d.threadId && p.memberUid',
        '&& d.planId is string && p.memberUid',
      ],
      [
        "inboxTrackedThread(wid, d.lastEventId, ['plan.proposed'], d.memberUid, d.threadId))",
        "inboxTracked(wid, d.lastEventId, ['plan.proposed'], d.memberUid))",
      ],
    ],
  ],
  [
    'inbox: plan-only type proposed alone',
    [
      [
        '&& request.resource.data.type in outcomeSingle()',
        '&& request.resource.data.type in outcomeTypes()',
      ],
    ],
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
    [["&& getAfter(inboxDoc(wid, 'inboxSubjects', sid)).data.memberUid == member;", ';']],
  ],
  [
    'inbox: agent rewrites more than a subject area',
    [
      [
        "&& changed(['area', 'label', 'labelSuggested', 'labelBy', 'updatedAt', 'lastEventId'])",
        '',
      ],
    ],
  ],
  [
    'inbox: agent sets an area outside a filing',
    [
      [
        "inboxTracked(wid, request.resource.data.lastEventId, ['thread.filed'], resource.data.memberUid)\n          && inboxEv(wid, request.resource.data.lastEventId).data.subjectId == sid;",
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
    [["&& !(resource.data.get('labelBy', null) == 'member')))", '&& true))']],
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
    [["&& (d.label in inboxLabelList(wid) || ('label' in r && d.label == r.label))", '']],
  ],
  [
    'inbox: label change without its event',
    [["&& inboxEv(wid, request.resource.data.lastEventId).data.type == 'subject.label'))", '))']],
  ],
  [
    'inbox: people create labelled subjects',
    [
      [
        "&& inboxNoLabel(request.resource.data)\n                && request.resource.data.createdBy == me_('human')",
        "&& request.resource.data.createdBy == me_('human')",
      ],
    ],
  ],
  [
    'inbox: members edit the label list',
    [
      [
        "allow create, update: if cid == 'labels' && isAdmin(wid)",
        "allow create, update: if cid == 'labels' && isMember(wid)",
      ],
    ],
  ],
  [
    'inbox: agents edit the label list',
    [
      [
        "allow create, update: if cid == 'labels' && isAdmin(wid)",
        "allow create, update: if cid == 'labels' && (isAdmin(wid) || isActiveAgent(wid))",
      ],
    ],
  ],
  [
    'inbox: unbounded label list',
    [['request.resource.data.labels.size() <= 12', 'request.resource.data.labels.size() <= 100']],
  ],
  [
    'inbox: people write agent events',
    [
      [
        "'relation.removed',\n                  'thread.flagged', 'thread.due'])",
        "'relation.removed',\n                  'thread.flagged', 'thread.due', 'outcome.done'])",
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
    'inbox: an item link without the item',
    [['|| inboxItemMade(wid, request.resource.data))', '|| true)']],
  ],
  [
    "inbox: linking another member's thread",
    [["&& get(inboxDoc(wid, 'inboxThreads', e.threadId)).data.memberUid == me()", '']],
  ],
  [
    'inbox: agents decide relations',
    [
      [
        "'outcome.failed', 'relation.proposed', 'thread.flagged', 'thread.due']));",
        "'outcome.failed', 'relation.proposed', 'thread.flagged', 'thread.due', 'relation.accepted']));",
      ],
      [
        "allow update: if inboxOwner(wid, resource.data)\n          && changed(['state', 'note', 'decision'",
        "allow update: if (inboxOwner(wid, resource.data) || isActiveAgent(wid))\n          && changed(['state', 'note', 'decision'",
      ],
      [
        "['relation.accepted', 'relation.created', 'relation.rejected', 'relation.removed'], me())",
        "['relation.accepted', 'relation.created', 'relation.rejected', 'relation.removed'], resource.data.memberUid)",
      ],
    ],
  ],
  [
    "inbox: relate another member's subject",
    [['&& inboxSubjectOf(wid, d.a, d.memberUid) && inboxSubjectOf(wid, d.b, d.memberUid);', ';']],
  ],
  ['inbox: relation id forged', [["&& d.a < d.b && rid == 'rel-' + d.a + '-' + d.b", '']]],
  ['inbox: urgent not a boolean', [['&& request.resource.data.urgent is bool', '']]],
  [
    'inbox: agents propose a related link',
    [
      [
        "&& request.resource.data.state == 'proposed'\n                && request.resource.data.proposedBy == me_('agent')",
        "&& request.resource.data.proposedBy == me_('agent')",
      ],
    ],
  ],
  // Decision data (item kt3E7u9EliL3q2veDDI0)
  [
    'inbox: any confidence',
    [["|| request.resource.data.confidence in ['high', 'medium', 'low'])", '|| true)']],
  ],
  [
    'inbox: unbounded checks',
    [
      [
        '(request.resource.data.checks is list && request.resource.data.checks.size() <= 6))',
        '(request.resource.data.checks is list))',
      ],
    ],
  ],
  [
    'inbox: outcomes with any keys',
    [
      [
        "'proposedBy', 'executor', 'decision', 'result', 'createdAt', 'updatedAt', 'lastEventId',\n               'confidence', 'checks'])",
        "'proposedBy', 'executor', 'decision', 'result', 'createdAt', 'updatedAt', 'lastEventId',\n               'confidence', 'checks', 'score'])",
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
  [
    'inbox: due rewrites more',
    [
      [
        "changed(['due', 'updatedAt', 'lastEventId'])",
        "changed(['due', 'state', 'updatedAt', 'lastEventId'])",
      ],
    ],
  ],
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
    [["&& d.question.keys().hasOnly(['text', 'by', 'at', 'answer', 'answeredAt', 'options'])", '']],
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
  [
    'inbox: member rewrites fields while asking',
    [["changed(['state', 'revise', 'updatedAt', 'lastEventId'])", 'true']],
  ],
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
    [['(inboxOwner(wid, resource.data) && inboxRecheckAsked(', '(inboxRecheckAsked(']],
  ],
  [
    'recheck: ask while pending',
    [["|| r.recheck.requestedAt + duration.value(30, 'm') <= request.time)", '|| true)']],
  ],
  [
    'recheck: ask with nothing open',
    [
      [
        "return changed(['recheck', 'updatedAt', 'lastEventId'])\n            && r.state in ['yourCall', 'waiting']",
        "return changed(['recheck', 'updatedAt', 'lastEventId'])",
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
    [['\n            && inboxEv(wid, d.lastEventId).data.data.result == d.recheck.result;', ';']],
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
        "\n            && getAfter(inboxDoc(wid, 'inboxThreads', r.threadId)).data.lastEventId == d.lastEventId",
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
    [['&& !inboxAtCursor(get(inboxPlanDoc(wid, r.planId)).data, oid)', '']],
  ],
  [
    'recheck: checkedAt with any result',
    [["&& e.data.data.result == 'still_good' && oid in e.data.data.checked", '']],
  ],
  [
    'recheck: checkedAt with other changes',
    [["changed(['checkedAt', 'updatedAt', 'lastEventId'])", 'true']],
  ],
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
  // Ask the agent (item w6O2KOw4ys70TQv9I1xD).
  [
    'instruct: another member asks',
    [['(inboxOwner(wid, resource.data) && inboxInstructed(', '(inboxInstructed(']],
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
        "return changed(['suggestedChips', 'updatedAt', 'lastEventId'])\n            && r.fetchedBy == me()",
        "return changed(['suggestedChips', 'updatedAt', 'lastEventId'])",
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
