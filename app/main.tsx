import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, Route, ShieldCheck, Waypoints } from 'lucide-react';
import { api } from '@/lib/api';
const Workspace = React.lazy(() => import('./workspace'));
import './globals.css';
import './premium.css';

function App() {
  const [session, setSession] = useState<{
    authenticated: boolean;
    needsSetup: boolean;
  } | null>(null);
  const [password, setPassword] = useState(''),
    [confirm, setConfirm] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api('session')
      .then(setSession)
      .catch((e) => setError(e.message));
  }, []);
  if (session?.authenticated)
    return (
      <React.Suspense
        fallback={<main className="loading-page">Loading workspace…</main>}
      >
        <Workspace
          onLogout={async () => {
            await api('logout', {});
            setSession({ authenticated: false, needsSetup: false });
            setPassword('');
          }}
        />
      </React.Suspense>
    );
  return (
    <div className="auth-page">
      <div className="auth-story">
        <a className="brand" href="/">
          <span className="brand-symbol">
            <Waypoints size={23} />
          </span>
          waypoint
          <span className="brand-dot">•</span>
        </a>
        <div>
          <span className="auth-intro">
            Your infrastructure, beautifully connected.
          </span>
          <h1 className="max-w-5xl">
            A clear path.
            <br />
            For every request.
          </h1>
          <p>
            Connect your domains to your services.
            <br />
            Less configuration. More clarity.
          </p>
          <div className="auth-path">
            <span>
              <Waypoints /> Domain
            </span>
            <ArrowRight />
            <span>
              <Route /> Route
            </span>
            <ArrowRight />
            <span>Service</span>
          </div>
        </div>
        <span className="auth-caption">
          Your infrastructure. On your own terms.
        </span>
      </div>
      <main className="auth-main">
        <div className="auth-card">
          <div className="intro-icon">
            <ShieldCheck size={27} />
          </div>
          <span className="auth-kicker">Your private workspace</span>
          <h2>
            {session?.needsSetup ? 'Welcome to Waypoint.' : 'Welcome back.'}
          </h2>
          <p>
            {session?.needsSetup
              ? 'Set an admin password to start building your network.'
              : 'Sign in to your reverse proxy workspace.'}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (session?.needsSetup && password !== confirm) {
                setError('The passwords do not match.');
                return;
              }
              setBusy(true);
              setError('');
              try {
                await api('login', { password });
                setSession({ authenticated: true, needsSetup: false });
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="field">
              Admin password
              <input
                type="password"
                minLength={session?.needsSetup ? 12 : 1}
                maxLength={1024}
                required
                autoComplete={
                  session?.needsSetup ? 'new-password' : 'current-password'
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  session?.needsSetup
                    ? 'At least 12 characters'
                    : 'Enter your password'
                }
              />
            </label>
            {session?.needsSetup && (
              <label className="field">
                Confirm password
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Enter it once more"
                />
              </label>
            )}
            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
            <button
              className="btn primary auth-submit"
              disabled={busy || !session}
            >
              {busy
                ? 'Opening workspace…'
                : !session
                  ? 'Connecting…'
                  : session.needsSetup
                    ? 'Create workspace'
                    : 'Open workspace'}
              <ArrowRight size={17} />
            </button>
          </form>
          <p className="auth-note">
            <ShieldCheck size={15} /> Self-hosted. Configuration stays on this
            device.
          </p>
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
