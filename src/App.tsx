import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
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
  HARDWARE_PROFILES,
  type ColabRuntimeSession,
  type ColabWorkerSnapshot,
  type VideoJob,
  type WanModelId,
  type HardwareTargetId,
  type CameraMotionType,
} from './utils/colabEngine';
import { OverviewView } from './components/OverviewView';
import { VideoStudioView } from './components/VideoStudioView';
import { SettingsView } from './components/SettingsView';

type ActiveTab = 'overview' | 'studio' | 'settings';
const STUDIO_SESSION_TOKEN = 'wan_studio_ui_session_v2';

const DEFAULT_SESSION: ColabRuntimeSession = {
  sessionId: 'wan-worker',
  accountEmail: 'chu.maitv99@gmail.com',
  displayName: 'Chu Mai',
  hardwareTarget: 'tpu_v5e',
  hardwareLabel: HARDWARE_PROFILES.tpu_v5e.label,
  state: 'DISCONNECTED',
  cliBinaryAvailable: false,
  adcAuthenticated: false,
  workerConnected: false,
  workerId: null,
  gpuNameReported: null,
  vramUsedGb: null,
  vramTotalGb: 16.0,
  vramIsMeasured: false,
  computeUnitsUsed: 0,
  computeUnitsLimit: 100,
  activeJobsCount: 0,
  completedJobsCount: 0,
  lastHeartbeatAt: null,
  startedAt: null,
  lastError: null,
};

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview');
  const [appUrl, setAppUrl] = useState<string>(window.location.origin);
  const [maskedWorkerToken, setMaskedWorkerToken] = useState<string>('wh_wan_••••••••••••');
  const [selectedModel, setSelectedModel] = useState<WanModelId>(
    'FastVideo/FastWan2.1-T2V-1.3B-Diffusers'
  );
  const [session, setSession] = useState<ColabRuntimeSession>(DEFAULT_SESSION);
  const [workers, setWorkers] = useState<ColabWorkerSnapshot[]>([]);
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [apiKeys, setApiKeys] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [settings, setSettings] = useState({
    enforceApiKey: true,
    maxJobRetries: 2,
    leaseTimeoutSec: 180,
  });

  // Google OAuth & Drive state
  const [googleUser, setGoogleUser] = useState<User | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [driveFiles, setDriveFiles] = useState<DriveColabFile[]>([]);

  // CLI & E2E state
  const [isControllingCli, setIsControllingCli] = useState(false);
  const [isRunningE2E, setIsRunningE2E] = useState(false);
  const [e2eSteps, setE2eSteps] = useState<string[] | null>(null);
  const [e2eModeLabel, setE2eModeLabel] = useState<string>('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const syncedUserEmailRef = useRef<string | null>(null);

  const safeParseJson = async (res: Response): Promise<Record<string, any> | null> => {
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return null;
    }
    try {
      return await res.json();
    } catch {
      return null;
    }
  };

  const fetchClusterState = useCallback(async () => {
    try {
      const res = await fetch('/api/cluster/state', {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      const data = await safeParseJson(res);
      if (!data) return;
      if (data.appUrl) setAppUrl(data.appUrl);
      if (data.maskedWorkerAuthToken) setMaskedWorkerToken(data.maskedWorkerAuthToken);
      if (data.session) setSession(data.session);
      if (Array.isArray(data.workers)) setWorkers(data.workers);
      if (Array.isArray(data.jobs)) setJobs(data.jobs);
      if (Array.isArray(data.apiKeys)) setApiKeys(data.apiKeys);
      if (Array.isArray(data.logs)) setLogs(data.logs);
      if (data.settings) setSettings(data.settings);
    } catch {
      // Ignore transient network/warmup errors during polling
    }
  }, []);

  useEffect(() => {
    fetchClusterState();
    const timer = setInterval(fetchClusterState, 2200);
    return () => clearInterval(timer);
  }, [fetchClusterState]);

  const refreshDriveFiles = useCallback(async () => {
    try {
      const files = await listColabFilesFromDrive();
      setDriveFiles(files);
    } catch {
      // Ignore if not signed into Drive
    }
  }, []);

  useEffect(() => {
    const unsubscribe = initAuth(
      async (user, token) => {
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
                accessToken: token,
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
            accessToken: result.accessToken,
          }),
        });
        await fetchClusterState();
        await refreshDriveFiles();
        setToastMessage(`Đã đăng nhập Google OAuth & tự động đồng bộ Colab ADC (${result.user.email}).`);
      }
    } catch (err: any) {
      setToastMessage(err?.message || 'Đăng nhập Google không thành công.');
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

  const handleCliAction = async (action: 'start' | 'stop' | 'check', hw?: HardwareTargetId) => {
    setIsControllingCli(true);
    try {
      const res = await fetch(`/api/colab/cli/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Wan-Studio-Session': STUDIO_SESSION_TOKEN,
        },
        body: JSON.stringify({
          hardwareTarget: hw || session.hardwareTarget,
          modelId: selectedModel,
        }),
      });
      const data = (await safeParseJson(res)) || {};
      if (data.session) setSession(data.session);
      if (Array.isArray(data.logs)) setLogs(data.logs);
      if (!res.ok || data.ok === false) {
        setToastMessage(data.error || data.message || `Thao tác CLI '${action}' có cảnh báo.`);
      } else {
        setToastMessage(data.message || `Đã thực thi Colab CLI '${action}' thành công.`);
      }
    } catch (err: any) {
      setToastMessage(err?.message || `Lỗi khi gọi Colab CLI '${action}'.`);
    } finally {
      setIsControllingCli(false);
    }
  };

  const handleUpdateSettings = async (payload: Record<string, any>) => {
    const res = await fetch('/api/settings/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Wan-Studio-Session': STUDIO_SESSION_TOKEN,
      },
      body: JSON.stringify(payload),
    });
    const data = (await safeParseJson(res)) || {};
    if (!res.ok) {
      setToastMessage(data.error || 'Không thể lưu cài đặt.');
      return;
    }
    if (data.session) setSession(data.session);
    if (data.settings) setSettings(data.settings);
    setToastMessage('Đã cập nhật cấu hình hệ thống.');
  };

  const handleRevealWorkerToken = async (): Promise<string> => {
    const res = await fetch('/api/settings/worker-token', {
      headers: { 'X-Wan-Studio-Session': STUDIO_SESSION_TOKEN },
    });
    const data = (await safeParseJson(res)) || {};
    return data.workerAuthToken || '';
  };

  const handleRunE2ETest = async (_mode: 'mock' | 'real_gpu' = 'real_gpu') => {
    setIsRunningE2E(true);
    setE2eSteps(null);
    setE2eModeLabel('Real TPU v5e-1 Wan Inference Test');
    try {
      const res = await fetch('/api/e2e/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Wan-Studio-Session': STUDIO_SESSION_TOKEN,
        },
        body: JSON.stringify({ mode: 'real_gpu' }),
      });
      const data = (await safeParseJson(res)) || {};
      if (Array.isArray(data.stepsLog)) setE2eSteps(data.stepsLog);
      if (Array.isArray(data.jobs)) setJobs(data.jobs);
      if (Array.isArray(data.logs)) setLogs(data.logs);
      if (data.session) setSession(data.session);

      if (!res.ok || !data.ok) {
        setToastMessage(data.error || 'Chưa có Colab TPU v5e-1 Worker thật kết nối.');
      } else {
        setToastMessage(`Real TPU v5e-1 Wan E2E hoàn tất: Job ${data.jobId}.`);
      }
    } catch (err: any) {
      setToastMessage(err?.message || 'Lỗi khi chạy E2E.');
    } finally {
      setIsRunningE2E(false);
    }
  };

  const queuedOrActiveCount = jobs.filter(
    (j) =>
      j.status === 'QUEUED' ||
      j.status === 'DISPATCHED' ||
      j.status === 'DIFFUSING' ||
      j.status === 'ENCODING'
  ).length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Navigation Bar: WAN Studio · Tổng quan | Tạo video | Cài đặt */}
      <header className="flex items-center justify-between gap-6 px-6 py-3.5 border-b border-slate-800/90 bg-slate-950/95 sticky top-0 z-40 backdrop-blur-md">
        <a
          href="#overview"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('overview');
          }}
          className="text-base font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0 flex items-center gap-2"
        >
          <span>WAN Studio</span>
          <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 text-amber-400">
            Colab Orchestrator
          </span>
        </a>

        <nav
          aria-label="Điều hướng chính"
          className="flex items-center gap-6 text-sm font-medium text-slate-400"
        >
          <button
            type="button"
            onClick={() => setActiveTab('overview')}
            className={`transition-colors whitespace-nowrap pb-0.5 ${
              activeTab === 'overview'
                ? 'text-amber-400 border-b-2 border-amber-400'
                : 'hover:text-slate-100'
            }`}
          >
            Tổng quan
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('studio')}
            className={`transition-colors whitespace-nowrap pb-0.5 ${
              activeTab === 'studio'
                ? 'text-amber-400 border-b-2 border-amber-400'
                : 'hover:text-slate-100'
            }`}
          >
            Tạo video
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('settings')}
            className={`transition-colors whitespace-nowrap pb-0.5 ${
              activeTab === 'settings'
                ? 'text-amber-400 border-b-2 border-amber-400'
                : 'hover:text-slate-100'
            }`}
          >
            Cài đặt
          </button>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs font-mono text-slate-400 hidden sm:inline">
            {googleUser?.email || session.accountEmail}
          </span>
          <button
            type="button"
            onClick={() => setActiveTab('studio')}
            className="px-3.5 py-1.5 text-xs font-bold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 transition-colors"
          >
            + Tạo video
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-[1340px] w-full mx-auto px-6 py-6 space-y-6">
        {/* 4 Summary KPI Cards matching the Review Specification */}
        <section
          aria-label="Trạng thái tổng quan hệ thống"
          className="grid grid-cols-2 lg:grid-cols-4 gap-4"
        >
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <div className="text-xs text-slate-400">Colab Runtime</div>
            <div className="text-sm font-bold text-slate-100 mt-1">
              {session.gpuNameReported || session.hardwareLabel}
            </div>
            <div className="text-[11px] font-mono text-amber-400 mt-0.5">
              {HARDWARE_PROFILES[session.hardwareTarget]?.torchDtype}
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <div className="text-xs text-slate-400">Trạng thái</div>
            <div
              className={`text-sm font-bold mt-1 ${
                session.workerConnected
                  ? 'text-emerald-400'
                  : session.state === 'ERROR'
                  ? 'text-rose-400'
                  : 'text-slate-200'
              }`}
            >
              {session.workerConnected
                ? 'Đã kết nối (READY)'
                : session.state === 'DISCONNECTED'
                ? 'Chưa kết nối'
                : session.state}
            </div>
            <div className="text-[11px] font-mono text-slate-400 mt-0.5">
              {workers.length} Worker Online
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <div className="text-xs text-slate-400">Hàng đợi (SQLite)</div>
            <div className="text-sm font-bold text-slate-100 mt-1 font-mono">
              {queuedOrActiveCount} jobs đang chờ/chạy
            </div>
            <div className="text-[11px] font-mono text-slate-400 mt-0.5">
              Tổng cộng: {jobs.length} jobs
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <div className="text-xs text-slate-400">Compute Units</div>
            <div className="text-sm font-bold text-slate-100 mt-1 font-mono">
              {session.computeUnitsUsed > 0
                ? `${session.computeUnitsUsed} / ${session.computeUnitsLimit ?? 100} CU`
                : '—'}
            </div>
            <div className="text-[11px] font-mono text-slate-400 mt-0.5">
              Ngân sách: {session.computeUnitsLimit ?? 100} CU
            </div>
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
          <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-amber-400">{e2eModeLabel}</span>
              <button
                type="button"
                onClick={() => setE2eSteps(null)}
                className="text-xs text-slate-400 hover:text-white"
              >
                Ẩn kết quả
              </button>
            </div>
            <ul className="space-y-1 text-xs font-mono text-slate-300">
              {e2eSteps.map((s, idx) => (
                <li key={idx}>{s}</li>
              ))}
            </ul>
          </div>
        )}

        {activeTab === 'overview' && (
          <OverviewView
            session={session}
            workers={workers}
            jobs={jobs}
            logs={logs}
            googleUser={googleUser}
            isSigningIn={isSigningIn}
            isControllingCli={isControllingCli}
            onGoogleLogin={handleGoogleLogin}
            onGoogleLogout={handleGoogleLogout}
            onChangeHardwareTarget={async (hw) => {
              await handleUpdateSettings({ hardwareTarget: hw });
            }}
            onStartRuntime={async () => {
              await handleCliAction('start');
            }}
            onStopRuntime={async () => {
              await handleCliAction('stop');
            }}
            onCheckRuntimeStatus={async () => {
              await handleCliAction('check');
            }}
            onOpenVideoStudio={() => setActiveTab('studio')}
            onOpenSettings={() => setActiveTab('settings')}
            onClearJobs={async () => {
              const res = await fetch('/api/jobs', { method: 'DELETE' });
              const data = await res.json();
              if (Array.isArray(data.jobs)) setJobs(data.jobs);
              await fetchClusterState();
            }}
          />
        )}

        {activeTab === 'studio' && (
          <VideoStudioView
            session={session}
            jobs={jobs}
            selectedModel={selectedModel}
            onSelectModel={setSelectedModel}
            onCreateJob={async (payload) => {
              const res = await fetch('/v1/video/generations', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Wan-Studio-Session': STUDIO_SESSION_TOKEN,
                },
                body: JSON.stringify(payload),
              });
              const data = await res.json();
              if (!res.ok) {
                throw new Error(data.error || 'Lỗi tạo video.');
              }
              if (Array.isArray(data.jobs)) setJobs(data.jobs);
              setToastMessage(`Đã thêm job ${data.id} vào hàng đợi SQLite.`);
              return data.job;
            }}
            onOptimizePrompt={async (payload: {
              prompt: string;
              cameraMotion: CameraMotionType;
              model: WanModelId;
            }) => {
              const res = await fetch('/api/ai/director', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              });
              const data = await res.json();
              if (!res.ok) {
                throw new Error(data.error || 'Lỗi khi tối ưu prompt.');
              }
              return data.result;
            }}
          />
        )}

        {activeTab === 'settings' && (
          <SettingsView
            appUrl={appUrl}
            session={session}
            maskedWorkerToken={maskedWorkerToken}
            selectedModel={selectedModel}
            apiKeys={apiKeys}
            settings={settings}
            driveFiles={driveFiles}
            isRunningE2E={isRunningE2E}
            onUpdateSettings={handleUpdateSettings}
            onRevealWorkerToken={handleRevealWorkerToken}
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
            onRunE2ETest={handleRunE2ETest}
            onUploadNotebookToDrive={async (filename, nbJson) => {
              await uploadColabNotebookToDrive(filename, nbJson);
              await refreshDriveFiles();
              setToastMessage(`Đã lưu ${filename} lên Google Drive.`);
            }}
            onDeleteDriveFile={async (file) => {
              await deleteDriveFileById(file.id);
              await refreshDriveFiles();
            }}
          />
        )}
      </main>
    </div>
  );
}
