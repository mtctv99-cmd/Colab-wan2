import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { CheckCircle2, Play, ExternalLink } from 'lucide-react';
import {
  initAuth,
  googleSignIn,
  logoutGoogle,
  listColabFilesFromDrive,
  uploadColabNotebookToDrive,
  deleteDriveFileById,
  type DriveColabFile,
} from './services/googleWorkspace';
import {
  generateColabNotebookJson,
  type ColabAccount,
  type ColabWorkerSnapshot,
  type VideoJob,
  type WanModelId,
} from './utils/colabEngine';
import { ColabAccountsView } from './components/ColabAccountsView';
import { WorkerHubView } from './components/WorkerHubView';
import { GatewayTrafficView } from './components/GatewayTrafficView';

type ActiveSection = 'accounts' | 'workers' | 'gateway';

export default function App() {
  const [activeSection, setActiveSection] = useState<ActiveSection>('accounts');
  const [appUrl, setAppUrl] = useState<string>(window.location.origin);
  const [workerAuthToken, setWorkerAuthToken] = useState<string>('wh_fastwan_colab_cluster_99');
  const [selectedModel, setSelectedModel] = useState<WanModelId>(
    'FastVideo/FastWan2.1-T2V-1.3B-Diffusers'
  );
  const [accounts, setAccounts] = useState<ColabAccount[]>([]);
  const [workers, setWorkers] = useState<ColabWorkerSnapshot[]>([]);
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [apiKeys, setApiKeys] = useState<any[]>([]);
  const [traffic, setTraffic] = useState<any>({ '24h': [], '7d': [], '30d': [] });

  // Google OAuth & Google Drive state
  const [googleUser, setGoogleUser] = useState<User | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [driveFiles, setDriveFiles] = useState<DriveColabFile[]>([]);
  const [isLoadingDrive, setIsLoadingDrive] = useState(false);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // E2E Test state
  const [isRunningE2E, setIsRunningE2E] = useState(false);
  const [e2eSteps, setE2eSteps] = useState<string[] | null>(null);
  const syncedUserEmailRef = useRef<string | null>(null);

  const fetchClusterState = useCallback(async () => {
    try {
      const res = await fetch('/api/cluster/state');
      if (!res.ok) return;
      const data = await res.json();
      if (data.appUrl) setAppUrl(data.appUrl);
      if (data.workerAuthToken) setWorkerAuthToken(data.workerAuthToken);
      if (Array.isArray(data.accounts)) setAccounts(data.accounts);
      if (Array.isArray(data.workers)) setWorkers(data.workers);
      if (Array.isArray(data.jobs)) setJobs(data.jobs);
      if (Array.isArray(data.apiKeys)) setApiKeys(data.apiKeys);
      if (data.traffic) setTraffic(data.traffic);
    } catch (e) {
      console.error('Cluster state fetch error:', e);
    }
  }, []);

  useEffect(() => {
    fetchClusterState();
    const timer = setInterval(fetchClusterState, 2200);
    return () => clearInterval(timer);
  }, [fetchClusterState]);

  const refreshDriveFiles = useCallback(async () => {
    setIsLoadingDrive(true);
    setDriveError(null);
    try {
      const files = await listColabFilesFromDrive();
      setDriveFiles(files);
    } catch (err: any) {
      if (err?.message !== 'NO_ACCESS_TOKEN') {
        setDriveError(err?.message || 'Không thể tải danh sách tệp từ Google Drive.');
      }
    } finally {
      setIsLoadingDrive(false);
    }
  }, []);

  // Auto-sync signed-in Google User into Colab Pool immediately
  useEffect(() => {
    const unsubscribe = initAuth(
      async (user) => {
        setGoogleUser(user);
        refreshDriveFiles();
        if (user.email && syncedUserEmailRef.current !== user.email) {
          syncedUserEmailRef.current = user.email;
          try {
            await fetch('/api/accounts/oauth-sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                email: user.email,
                displayName: user.displayName,
                photoURL: user.photoURL,
              }),
            });
            await fetchClusterState();
          } catch {
            // Ignore
          }
        }
      },
      () => {
        setGoogleUser(null);
        setDriveFiles([]);
        syncedUserEmailRef.current = null;
      }
    );
    return () => unsubscribe();
  }, [refreshDriveFiles, fetchClusterState]);

  const handleGoogleLogin = async () => {
    setIsSigningIn(true);
    setDriveError(null);
    try {
      const result = await googleSignIn();
      if (result) {
        setGoogleUser(result.user);
        syncedUserEmailRef.current = result.user.email;
        await fetch('/api/accounts/oauth-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: result.user.email,
            displayName: result.user.displayName,
            photoURL: result.user.photoURL,
          }),
        });
        await fetchClusterState();
        await refreshDriveFiles();
        setToastMessage(`Đã kết nối Google OAuth (${result.user.email}) vào Pool TPU v5e-1.`);
      }
    } catch (err: any) {
      setDriveError(err?.message || 'Đăng nhập Google OAuth không thành công.');
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleGoogleLogout = async () => {
    await logoutGoogle();
    setGoogleUser(null);
    setDriveFiles([]);
    syncedUserEmailRef.current = null;
    setToastMessage('Đã đăng xuất Google OAuth.');
  };

  const handleRunE2ETest = async () => {
    setIsRunningE2E(true);
    setE2eSteps(null);
    try {
      const res = await fetch('/api/e2e/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cleanAfter: false }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Kiểm thử E2E thất bại');
      }
      if (Array.isArray(data.jobs)) setJobs(data.jobs);
      if (data.traffic) setTraffic(data.traffic);
      setE2eSteps(data.stepsLog || []);
      setToastMessage(
        `Test E2E thành công: Đã kết nối WebSocket Worker -> Nhận request /v1/video/generations -> Hoàn tất Job ${data.jobId} (100%).`
      );
    } catch (err: any) {
      setToastMessage(err?.message || 'Lỗi khi chạy Test E2E.');
    } finally {
      setIsRunningE2E(false);
    }
  };

  const activeColabAccount = accounts.find((a) => a.state === 'ACTIVE');

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Bar: 3 clean zones */}
      <header className="flex items-center justify-between gap-8 px-6 py-3.5 border-b border-slate-800/90 bg-slate-950/95 sticky top-0 z-40 backdrop-blur-md">
        <a
          href="#accounts"
          onClick={(e) => {
            e.preventDefault();
            setActiveSection('accounts');
          }}
          className="text-base font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
        >
          Wan2.1 Colab TPU Hub
        </a>

        <nav
          aria-label="Điều hướng chính"
          className="flex items-center gap-6 text-sm font-medium text-slate-400 overflow-x-auto"
        >
          <button
            type="button"
            onClick={() => setActiveSection('accounts')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
              activeSection === 'accounts'
                ? 'text-amber-400 border-b-2 border-amber-400'
                : 'hover:text-slate-100'
            }`}
          >
            1. Tài khoản & Drive ({accounts.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('workers')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
              activeSection === 'workers'
                ? 'text-amber-400 border-b-2 border-amber-400'
                : 'hover:text-slate-100'
            }`}
          >
            2. Colab TPU v5e-1 Notebook ({workers.length} Online)
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('gateway')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
              activeSection === 'gateway'
                ? 'text-amber-400 border-b-2 border-amber-400'
                : 'hover:text-slate-100'
            }`}
          >
            3. API Gateway & Test E2E ({apiKeys.length} Keys)
          </button>
        </nav>

        <div className="flex items-center shrink-0">
          {!googleUser ? (
            <button
              type="button"
              onClick={handleGoogleLogin}
              disabled={isSigningIn}
              className="gsi-material-button"
            >
              <div className="gsi-material-button-state"></div>
              <div className="gsi-material-button-content-wrapper">
                <div className="gsi-material-button-icon">
                  <svg
                    version="1.1"
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 48 48"
                    style={{ display: 'block' }}
                  >
                    <path
                      fill="#EA4335"
                      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                    ></path>
                    <path
                      fill="#4285F4"
                      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                    ></path>
                    <path
                      fill="#FBBC05"
                      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                    ></path>
                    <path
                      fill="#34A853"
                      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                    ></path>
                    <path fill="none" d="M0 0h48v48H0z"></path>
                  </svg>
                </div>
                <span className="gsi-material-button-contents">
                  {isSigningIn ? 'Đang kết nối...' : 'Sign in with Google'}
                </span>
              </div>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setActiveSection('accounts')}
              className="px-3.5 py-1.5 text-xs font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0"
            >
              {googleUser.email}
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 max-w-[1340px] w-full mx-auto px-6 py-6 space-y-6">
        {/* Compact 3-Step Workflow Strip + Status */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <button
              type="button"
              onClick={() => setActiveSection('accounts')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors ${
                googleUser || accounts.length > 0
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
              }`}
            >
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>
                <strong>Bước 1:</strong>{' '}
                {googleUser
                  ? `Đã đăng nhập (${googleUser.email})`
                  : 'Đăng nhập Google / Thêm TK Colab'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSection('workers')}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-950 hover:border-amber-500/50 text-slate-200 transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>
                <strong>Bước 2:</strong> Tải/Đẩy file <code className="font-mono">.ipynb</code> lên
                Colab chọn <strong>v5e-1 TPU</strong> & bấm Run All
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSection('gateway')}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-950 hover:border-amber-500/50 text-slate-200 transition-colors"
            >
              <Play className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>
                <strong>Bước 3:</strong> Tạo API Key & Gắn{' '}
                <code className="font-mono text-amber-300">/v1/video/generations</code> vào App ngoài
              </span>
            </button>
          </div>

          <div className="flex items-center gap-5 text-xs font-mono tabular-nums">
            <div>
              <span className="text-slate-500">Active Node: </span>
              <span className="text-emerald-400 font-semibold">
                {activeColabAccount ? activeColabAccount.email : 'Chưa có'}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Workers: </span>
              <span className="text-slate-100 font-semibold">{workers.length} Online</span>
            </div>
            <button
              type="button"
              onClick={handleRunE2ETest}
              disabled={isRunningE2E}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 font-sans font-semibold transition-colors whitespace-nowrap disabled:opacity-50"
            >
              {isRunningE2E ? 'Đang chạy E2E...' : 'Chạy Test E2E'}
            </button>
          </div>
        </section>

        {toastMessage && (
          <div
            role="status"
            className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200 flex items-center justify-between gap-4"
          >
            <span>{toastMessage}</span>
            <button
              type="button"
              onClick={() => setToastMessage(null)}
              className="text-xs font-medium text-amber-300 hover:text-white whitespace-nowrap"
            >
              Đóng
            </button>
          </div>
        )}

        {e2eSteps && (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/20 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-emerald-400">
                Kết quả Kiểm thử End-to-End (WebSocket Worker ↔ /v1/video/generations)
              </span>
              <button
                type="button"
                onClick={() => setE2eSteps(null)}
                className="text-xs text-slate-400 hover:text-white"
              >
                Ẩn
              </button>
            </div>
            <ul className="space-y-1 text-xs font-mono text-slate-300">
              {e2eSteps.map((s, idx) => (
                <li key={idx}>{s}</li>
              ))}
            </ul>
          </div>
        )}

        {activeSection === 'accounts' && (
          <ColabAccountsView
            accounts={accounts}
            appUrl={appUrl}
            workerAuthToken={workerAuthToken}
            selectedModel={selectedModel}
            googleUser={googleUser}
            isSigningIn={isSigningIn}
            driveFiles={driveFiles}
            isLoadingDrive={isLoadingDrive}
            driveError={driveError}
            onGoogleLogin={handleGoogleLogin}
            onGoogleLogout={handleGoogleLogout}
            onRefreshDriveFiles={refreshDriveFiles}
            onUploadNotebookToDrive={async (filename, nbJson) => {
              await uploadColabNotebookToDrive(filename, nbJson);
              await refreshDriveFiles();
            }}
            onDeleteDriveFile={async (file) => {
              await deleteDriveFileById(file.id);
              await refreshDriveFiles();
            }}
            onRotatePool={async () => {
              const res = await fetch('/api/workers/colab/rotate', { method: 'POST' });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || 'Không thể xoay vòng tài khoản.');
              if (Array.isArray(data.accounts)) setAccounts(data.accounts);
              if (Array.isArray(data.workers)) setWorkers(data.workers);
            }}
            onPrewarmPool={async (accountId) => {
              const res = await fetch('/api/workers/colab/prewarm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accountId }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || 'Không thể kích hoạt Pre-warm.');
              if (Array.isArray(data.accounts)) setAccounts(data.accounts);
              if (Array.isArray(data.workers)) setWorkers(data.workers);
            }}
            onStartAccount={async (accountId) => {
              const res = await fetch('/api/workers/colab/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accountId }),
              });
              const data = await res.json();
              if (Array.isArray(data.accounts)) setAccounts(data.accounts);
              if (Array.isArray(data.workers)) setWorkers(data.workers);
            }}
            onStopAccount={async (accountId) => {
              const res = await fetch('/api/workers/colab/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accountId }),
              });
              const data = await res.json();
              if (Array.isArray(data.accounts)) setAccounts(data.accounts);
              if (Array.isArray(data.workers)) setWorkers(data.workers);
            }}
            onAddAccount={async (payload) => {
              const res = await fetch('/api/accounts/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || 'Lỗi thêm tài khoản.');
              if (Array.isArray(data.accounts)) setAccounts(data.accounts);
            }}
            onDeleteAccount={async (accountId) => {
              const res = await fetch(`/api/accounts/${accountId}`, { method: 'DELETE' });
              const data = await res.json();
              if (Array.isArray(data.accounts)) setAccounts(data.accounts);
              if (Array.isArray(data.workers)) setWorkers(data.workers);
            }}
          />
        )}

        {activeSection === 'workers' && (
          <WorkerHubView
            workers={workers}
            appUrl={appUrl}
            workerAuthToken={workerAuthToken}
            selectedModel={selectedModel}
            onSelectModel={setSelectedModel}
          />
        )}

        {activeSection === 'gateway' && (
          <GatewayTrafficView
            traffic={traffic}
            apiKeys={apiKeys}
            jobs={jobs}
            appUrl={appUrl}
            selectedModel={selectedModel}
            isRunningE2E={isRunningE2E}
            onRunE2ETest={handleRunE2ETest}
            onClearJobs={async () => {
              const res = await fetch('/api/jobs', { method: 'DELETE' });
              const data = await res.json();
              if (Array.isArray(data.jobs)) setJobs(data.jobs);
              if (data.traffic) setTraffic(data.traffic);
            }}
            onCreateApiKey={async (payload) => {
              const res = await fetch('/api/apikeys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              });
              const data = await res.json();
              if (Array.isArray(data.apiKeys)) setApiKeys(data.apiKeys);
              return { fullSecret: data.fullSecret };
            }}
            onRevokeApiKey={async (id) => {
              const res = await fetch(`/api/apikeys/${id}`, { method: 'DELETE' });
              const data = await res.json();
              if (Array.isArray(data.apiKeys)) setApiKeys(data.apiKeys);
            }}
          />
        )}
      </main>
    </div>
  );
}
