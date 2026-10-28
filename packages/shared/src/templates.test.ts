import { describe, expect, it } from 'vitest';
import { stepSchema } from './schema';
import {
  describeProcess,
  gatePositions,
  stepsFor,
  TEMPLATES,
  templateById,
  templateLabel,
  DEFAULT_TEMPLATE_ID,
} from './templates';

describe('templates', () => {
  it('has five templates plus Blank', () => {
    expect(TEMPLATES.map((t) => t.name)).toEqual([
      'Build a system',
      'Content pipeline',
      'Research to decision',
      'Feature delivery',
      'Client proposal',
      'Blank',
    ]);
    expect(templateById(DEFAULT_TEMPLATE_ID)?.name).toBe('Build a system');
  });

  it('Build a system has 10 steps with gates at 3, 5, 9 and 10', () => {
    const t = templateById('build-a-system')!;
    expect(t.steps).toHaveLength(10);
    expect(gatePositions(t.steps)).toEqual([3, 5, 9, 10]);
    expect(t.steps.map((s) => s.name)).toEqual([
      'Intake',
      'Discover',
      'Go / no-go',
      'Spec',
      'Approve spec',
      'Plan',
      'Build',
      'Verify',
      'Accept',
      'Release',
    ]);
  });

  it('follows the step names of the other templates', () => {
    const names = (id: string) => templateById(id)!.steps.map((s) => s.name);
    expect(names('content-pipeline')).toEqual(['Ideas', 'Pick', 'Draft', 'Approve', 'Publish']);
    expect(names('research-to-decision')).toEqual(['Brief', 'Research', 'Review', 'Plan', 'Done']);
    expect(names('feature-delivery')).toEqual(['Spec', 'Build', 'Review PR', 'Deploy', 'Verify']);
    expect(names('client-proposal')).toEqual(['Discovery', 'Scope', 'Sign-off', 'Pilot', 'Report']);
  });

  it('every template makes valid steps with unique ids and the creator at each gate', () => {
    for (const t of TEMPLATES) {
      const steps = stepsFor(t, 'uid1');
      expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
      for (const s of steps) {
        expect(stepSchema.safeParse(s).success, `${t.id}/${s.id}`).toBe(true);
        if (s.kind === 'human') expect(s.gate?.deciderUids).toEqual(['uid1']);
        expect(s.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('describes a process in plain words', () => {
    expect(describeProcess(templateById('build-a-system')!.steps)).toBe(
      '10 steps, gates at 3, 5, 9 and 10',
    );
    expect(describeProcess(templateById('feature-delivery')!.steps)).toBe('5 steps, gate at 3');
    expect(describeProcess(templateById('blank')!.steps)).toBe('1 step, no gates');
  });
});

describe('templateLabel', () => {
  it('names real templates and calls Blank or unknown a custom process', () => {
    expect(templateLabel('build-a-system')).toBe(templateById('build-a-system')?.name);
    expect(templateLabel('blank')).toBe('Custom process');
    expect(templateLabel('nope')).toBe('Custom process');
  });
});
