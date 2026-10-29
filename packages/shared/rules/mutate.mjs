// Rules mutation check: weakens one security rule at a time and asserts the rules suite
// catches it (at least one test fails). Proves the deny tests fail for the right reason.
// MUTATE_ONLY="name,name" limits the run. Run inside the emulator:  pnpm test:rules:mutate   (from the repo root)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { assertWellFormed } from './mutate-lib.mjs';

const RULES = new URL('../../../firestore.rules', import.meta.url);
const original = readFileSync(RULES, 'utf8');

/** [name, find, replace] — `find` must occur in the rules (all occurrences are replaced). */
const AGENT_TYPES = "'item.claimed', 'item.released', 'item.completed', 'item.updated',";
/**
 * [name, [[find, replace], …]]. Every `find` must occur in the rules (all occurrences are
 * replaced). Where a promise is enforced by two independent layers, the mutation removes both.
 */
const MUTATIONS = [
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
        '((inboxOwner(wid, resource.data) && inboxDecide(',
        '(((inboxOwner(wid, resource.data) || isActiveAgent(wid)) && inboxDecide(',
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
];

// A search text that no longer matches (the rules were refactored) would check nothing: it is
// reported as a STALE failure with its name, and the rest of the suite still runs.
const isStale = (edits) => edits.find(([find, rep]) => !original.includes(find) || find === rep);

const runSuite = (verbose = false) => {
  try {
    // MUTATE_FILES="rules/inbox.test.ts" runs only those test files (a quick check of new mutations).
    const files = process.env.MUTATE_FILES?.split(',').map((f) => f.trim()) ?? [];
    execFileSync(
      'npx',
      ['vitest', 'run', '-c', 'vitest.rules.config.ts', '--reporter=dot', ...files],
      {
        cwd: new URL('..', import.meta.url),
        stdio: 'pipe',
      },
    );
    return true;
  } catch (e) {
    if (verbose)
      console.error(
        String(e.stdout ?? '')
          .split('\n')
          .slice(-40)
          .join('\n'),
      );
    return false;
  }
};
assertWellFormed(MUTATIONS);
// The suite must pass on the unmutated rules, or "a test failed" proves nothing.
if (!runSuite(true)) {
  console.error('The rules suite fails on the unmutated rules: fix it before mutating.');
  process.exit(2);
}

// MUTATE_ONLY="name one,name two" runs just those mutations (the full run takes about 2 hours).
const only = process.env.MUTATE_ONLY?.split(',').map((n) => n.trim());
const results = [];
try {
  for (const [name, edits] of MUTATIONS) {
    if (only && !only.includes(name)) continue;
    const missing = isStale(edits);
    if (missing) {
      results.push([name, 'STALE']);
      console.log(`STALE     ${name}: ${JSON.stringify(missing[0].slice(0, 80))}`);
      continue;
    }
    writeFileSync(
      RULES,
      edits.reduce((src, [find, rep]) => src.split(find).join(rep), original),
    );
    const caught = !runSuite();
    results.push([name, caught ? 'caught' : 'SURVIVED']);
    console.log(`${caught ? 'caught  ' : 'SURVIVED'}  ${name}`);
  }
} finally {
  writeFileSync(RULES, original);
}
const bad = results.filter(([, r]) => r !== 'caught');
console.log(`\n${results.length - bad.length}/${results.length} mutations caught`);
if (bad.length) {
  for (const [n, r] of bad) console.log(`  ${r}: ${n}`);
  process.exit(1);
}
