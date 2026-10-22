import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Header } from '@/components/layout/Header';
import { Onboarding } from '@/pages/Onboarding';

describe('FairShare branding', () => {
  it('uses the shared logo on onboarding', () => {
    const { container } = render(<MemoryRouter><Onboarding /></MemoryRouter>);
    expect(container.querySelector('img')).toHaveAttribute('src', '/favicon.svg');
    expect(screen.getByRole('heading', { name: 'FairShare' })).toBeInTheDocument();
  });

  it('uses the shared logo beside the app title', () => {
    const { container } = render(<MemoryRouter><Header title="FairShare" /></MemoryRouter>);
    expect(container.querySelector('img')).toHaveAttribute('src', '/favicon.svg');
  });

  it('does not add branding to page titles with back navigation', () => {
    const { container } = render(<MemoryRouter><Header title="Settings" showBack /></MemoryRouter>);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('button', { name: 'Go back' })).toBeInTheDocument();
  });
});
