import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Logo } from '../components/Logo';
import { PRIVACY_EMAIL } from '../lib/flags';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-20 font-semibold">{title}</h2>
      <div className="mt-2 space-y-2 text-14 text-text-2">{children}</div>
    </section>
  );
}

/** What Hivenod stores, in plain words. Linked from the landing footer and the sign-up panel. */
export default function PrivacyPage() {
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <header className="border-b border-line bg-surface pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex max-w-2xl items-center px-4 py-2">
          <Link to="/" className="flex min-h-11 items-center gap-2.5" aria-label="Hivenod home">
            <Logo size={28} />
            <span className="font-mono text-12 font-medium uppercase tracking-[0.08em] text-gate-text">
              Hivenod
            </span>
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 pb-16 pt-10">
        <h1 className="text-28 font-semibold">Privacy</h1>
        <p className="mt-2 text-14 text-text-2">
          Hivenod at https://hivenod.com is a small, free service. This is what it keeps, and what
          you can do about it.
        </p>

        <Section title="What we store">
          <p>
            Your account: your email address, your name and picture (from Google if you sign in with
            Google), and, for an email account, a password that only Google’s sign-in service holds,
            in hashed form.
          </p>
          <p>
            Your organization’s data: the Inbox threads, messages, plans, summaries, attachments,
            decisions and agent settings you and your agents put in, and who is a member.
          </p>
          <p>
            In your browser: a note that you are signed in, your theme choice and the app’s own
            cached data, so it works offline. No advertising or tracking cookies, and no analytics.
          </p>
        </Section>

        <Section title="Who processes it">
          <p>
            Hivenod runs on Firebase, part of Google Cloud. Google acts as our processor for sign-in
            (Firebase Authentication), the database (Firestore) and hosting. Confirmation and
            password emails are sent through Firebase from noreply@mail.hivenod.com. We do not sell
            your data or share it with anyone else.
          </p>
        </Section>

        <Section title="Who can see it">
          <p>
            Members of your organization see its data, as set by its admins. Hivenod’s operators can
            reach the database for running the service, and only do so to fix a problem you report.
          </p>
        </Section>

        <Section title="Deleting your account">
          <p>
            There is no delete button yet. Write to{' '}
            <a className="underline underline-offset-2" href={`mailto:${PRIVACY_EMAIL}`}>
              {PRIVACY_EMAIL}
            </a>{' '}
            from the address you signed up with, and we will delete your account and your profile,
            and remove you from your organizations. If you are the only admin of an organization,
            say whether to delete it too.
          </p>
        </Section>

        <Section title="Questions">
          <p>
            Write to{' '}
            <a className="underline underline-offset-2" href={`mailto:${PRIVACY_EMAIL}`}>
              {PRIVACY_EMAIL}
            </a>
            .
          </p>
        </Section>

        <p className="mt-10">
          <Link to="/" className="text-14 font-medium underline underline-offset-4">
            Back to Hivenod
          </Link>
        </p>
      </main>
    </div>
  );
}
