import { TEMPLATES } from '@hive/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProcessStrip } from './ProcessStrip';
import { TemplateGallery } from './TemplateGallery';

describe('ProcessStrip', () => {
  it('says where the gates are, not just shows them', () => {
    render(<ProcessStrip steps={TEMPLATES[0]!.steps} />);
    expect(screen.getByRole('img', { name: '10 steps, gates at 3, 5, 9 and 10' })).toBeTruthy();
  });
});

describe('TemplateGallery', () => {
  it('lists five templates plus Blank, each with its process, and picks one', () => {
    const pick = vi.fn();
    render(<TemplateGallery value={null} onValueChange={pick} />);
    expect(screen.getAllByRole('radio')).toHaveLength(6);
    expect(screen.getAllByRole('img')).toHaveLength(6);
    fireEvent.click(screen.getByRole('radio', { name: /Client proposal/ }));
    expect(pick).toHaveBeenCalledWith(expect.objectContaining({ id: 'client-proposal' }));
  });
  it('marks the chosen template', () => {
    render(<TemplateGallery value="blank" onValueChange={() => undefined} />);
    expect(screen.getByRole('radio', { name: /Blank/ }).getAttribute('aria-checked')).toBe('true');
  });
});
