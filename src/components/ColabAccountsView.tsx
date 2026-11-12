import React, { useState } from 'react';
import {
  RefreshCw,
  Play,
  Square,
  Plus,
  ExternalLink,
  Trash2,
  FolderGit2,
  AlertTriangle,
  Zap,
  LogOut,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import {
  evaluateAccountLifecycle,
  generateColabNotebookJson,
  RUN_DURATION_SEC,
  COOLDOWN_DURATION_SEC,
  type ColabAccount,
  type WanModelId,
} from '../utils/colabEngine';
import type { DriveColabFile } from '../services/googleWorkspace';

interface ColabAccountsViewProps {
  accounts: ColabAccount[];
  appUrl: string;
  workerAuthToken: string;
  selectedModel: WanModelId;
  googleUser: User | null;
  isSigningIn: boolean;
  driveFiles: DriveColabFile[];
  isLoadingDrive: boolean;
  driveError: string | null;
  onGoogleLogin: () => Promise<void>;
  onGoogleLogout: () => Promise<void>;
  onRefreshDriveFiles: () => Promise<void>;
  onUploadNotebookToDrive: (filename: string, notebookJson: string) => Promise<void>;
  onDeleteDriveFile: (file: DriveColabFile) => Promise<void>;
  onRotatePool: () => Promise<void>;
  onPrewarmPool: (accountId?: string) => Promise<void>;
  onStartAccount: (accountId: string) => Promise<void>;
  onStopAccount: (accountId: string) => Promise<void>;
  onAddAccount: (payload: {
    email: string;
    displayName: string;
    gpuType: ColabAccount['gpuType'];
    warpProxyEnabled: boolean;
  }) => Promise<void>;
  onDeleteAccount: (accountId: string) => Promise<void>;
}

function formatDurationHms(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return `${String(hrs).padStart(2, '0')}h ${String(mins).padStart(2, '0')}m ${String(
    secs
  ).padStart(2, '0')}s`;
}

export const ColabAccountsView: React.FC<ColabAccountsViewProps> = ({
  accounts,
  appUrl,
  workerAuthToken,
  selectedModel,
  googleUser,
  isSigningIn,
  driveFiles,
  isLoadingDrive,
  driveError,
  onGoogleLogin,
  onGoogleLogout,
  onRefreshDriveFiles,
  onUploadNotebookToDrive,
  onDeleteDriveFile,
  onRotatePool,
  onPrewarmPool,
  onStartAccount,
  onStopAccount,
  onAddAccount,
  onDeleteAccount,
}) => {
  const [showAddModal, setShowAddModal] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newGpuType, setNewGpuType] = useState<ColabAccount['gpuType']>('TPU v5e-1 (16GB HBM)');
  const [newWarpProxy, setNewWarpProxy] = useState(true);
  const [addError, setAddError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [statusFeedback, setStatusFeedback] = useState<string | null>(null);

  const [confirmDialog, setConfirmDialog] = useState<{
    type: 'upload_notebook' | 'delete_file';
    title: string;
    description: string;
    targetFile?: DriveColabFile;
  } | null>(null);

  const handleConfirmAction = async () => {
    if (!confirmDialog) return;
    const current = confirmDialog;
    setConfirmDialog(null);
    setActionBusy(current.type);
    try {
      if (current.type === 'upload_notebook') {
        const nbJson = generateColabNotebookJson({
          serverUrl: appUrl,
          workerId: `colab-tpu-${Date.now().toString().slice(-4)}`,
          workerToken: workerAuthToken,
          modelId: selectedModel,
          runtimeType: 'tpu_v5e',
        });
        await onUploadNotebookToDrive('Wan2.1_1.3B_Colab_TPU_v5e_Worker.ipynb', nbJson);
        setStatusFeedback(
          'Đã tạo tệp Wan2.1_1.3B_Colab_TPU_v5e_Worker.ipynb trên Google Drive. Bấm "Mở trong Google Colab" bên dưới để chạy!'
        );
      } else if (current.type === 'delete_file' && current.targetFile) {
        await onDeleteDriveFile(current.targetFile);
        setStatusFeedback(`Đã xóa tệp "${current.targetFile.name}" khỏi Google Drive.`);
      }
    } catch (err: any) {
      setStatusFeedback(err?.message || 'Thao tác trên Google Drive không thành công.');
    } finally {
      setActionBusy(null);
    }
  };

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail.trim() || !newEmail.includes('@')) {
      setAddError('Vui lòng nhập địa chỉ email Google Colab hợp lệ.');
      return;
    }
    setAddError(null);
    try {
      await onAddAccount({
        email: newEmail.trim(),
        displayName: newDisplayName.trim() || newEmail.split('@')[0],
        gpuType: newGpuType,
        warpProxyEnabled: newWarpProxy,
      });
      setNewEmail('');
      setNewDisplayName('');
      setShowAddModal(false);
      setStatusFeedback(`Đã thêm ${newEmail.trim()} vào Pool.`);
    } catch (err: any) {
      setAddError(err?.message || 'Không thể thêm tài khoản.');
    }
  };

  return (
    <div className="space-y-6">
      {/* Section 1: Google OAuth & Google Drive Notebook */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Google OAuth & Notebook Colab TPU v5e-1 trên Google Drive
            </h2>
            <p className="text-xs text-slate-400">
              Đẩy thẳng file <code className="text-amber-300 font-mono">Wan2.1_1.3B_Colab_TPU_v5e_Worker.ipynb</code> lên Drive và mở trực tiếp bằng Google Colab.
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {!googleUser ? (
              <button
                type="button"
                onClick={onGoogleLogin}
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
                    {isSigningIn ? 'Đang xác thực...' : 'Sign in with Google'}
                  </span>
                </div>
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-xs font-mono text-emerald-400">{googleUser.email}</span>
                <button
                  type="button"
                  onClick={() =>
                    setConfirmDialog({
                      type: 'upload_notebook',
                      title: 'Tạo Notebook TPU v5e-1 trên Google Drive',
                      description: `Tạo tệp "Wan2.1_1.3B_Colab_TPU_v5e_Worker.ipynb" (${selectedModel}) trên Google Drive của ${googleUser.email}?`,
                    })
                  }
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
                >
                  <FolderGit2 className="w-3.5 h-3.5" />
                  <span>Đẩy Notebook TPU v5e-1 lên Drive</span>
                </button>
                <button
                  type="button"
                  onClick={onGoogleLogout}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 text-xs font-medium transition-colors whitespace-nowrap shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Đăng xuất</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {googleUser ? (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-300">
                File Notebook trên Google Drive ({driveFiles.length})
              </span>
              <button
                type="button"
                onClick={onRefreshDriveFiles}
                disabled={isLoadingDrive}
                className="inline-flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300"
              >
                <RefreshCw className={`w-3 h-3 ${isLoadingDrive ? 'animate-spin' : ''}`} />
                <span>Làm mới</span>
              </button>
            </div>

            {driveError && (
              <div className="text-xs text-rose-400 bg-rose-950/40 border border-rose-800/50 rounded-lg p-2.5">
                {driveError}
              </div>
            )}

            {driveFiles.length === 0 ? (
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3.5 text-xs text-slate-400">
                Bấm nút <strong>"Đẩy Notebook TPU v5e-1 lên Drive"</strong> ở góc phải để tạo file `.ipynb` và mở trực tiếp trên Google Colab.
              </div>
            ) : (
              <div className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950">
                {driveFiles.map((file) => (
                  <div
                    key={file.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-xs"
                  >
                    <span className="font-medium text-slate-100">{file.name}</span>
                    <div className="flex items-center gap-2">
                      <a
                        href={file.colabUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span>Mở trong Google Colab</span>
                      </a>
                      <button
                        type="button"
                        onClick={() =>
                          setConfirmDialog({
                            type: 'delete_file',
                            title: 'Xóa tệp khỏi Google Drive',
                            description: `Xóa vĩnh viễn tệp "${file.name}" khỏi Google Drive?`,
                            targetFile: file,
                          })
                        }
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-rose-400 hover:bg-rose-950/50 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3.5 text-xs text-slate-400">
            Bấm <strong>Sign in with Google</strong> để đồng bộ tài khoản vào Pool và đẩy file `.ipynb` lên Google Drive.
          </div>
        )}
      </div>

      {/* Section 2: Colab Account Rotator Pool */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Pool Tài khoản Colab (Xoay vòng 3h Chạy · 2h35m Pre-warm · 16h Nghỉ)
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                setActionBusy('prewarm');
                try {
                  await onPrewarmPool();
                  setStatusFeedback('Đã bật Pre-warm cho tài khoản kế nhiệm.');
                } catch (err: any) {
                  setStatusFeedback(err?.message || 'Cần thêm tài khoản thứ 2 ở trạng thái READY để Pre-warm.');
                } finally {
                  setActionBusy(null);
                }
              }}
              disabled={actionBusy !== null || accounts.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-200 text-xs font-medium transition-colors whitespace-nowrap disabled:opacity-40"
            >
              <Zap className="w-3.5 h-3.5 text-amber-400" />
              <span>Pre-warm</span>
            </button>

            <button
              type="button"
              onClick={async () => {
                setActionBusy('rotate');
                try {
                  await onRotatePool();
                  setStatusFeedback('Đã xoay vòng sang tài khoản kế nhiệm.');
                } catch (err: any) {
                  setStatusFeedback(err?.message || 'Cần ít nhất 1 tài khoản READY/PREWARMING để xoay vòng.');
                } finally {
                  setActionBusy(null);
                }
              }}
              disabled={actionBusy !== null || accounts.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 text-xs font-semibold transition-colors whitespace-nowrap disabled:opacity-40"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${actionBusy === 'rotate' ? 'animate-spin' : ''}`} />
              <span>Rotate</span>
            </button>

            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Thêm TK Colab</span>
            </button>
          </div>
        </div>

        {statusFeedback && (
          <div className="rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2 text-xs text-amber-300 flex items-center justify-between">
            <span>{statusFeedback}</span>
            <button
              type="button"
              onClick={() => setStatusFeedback(null)}
              className="text-slate-400 hover:text-slate-200 text-xs"
            >
              Đóng
            </button>
          </div>
        )}

        {accounts.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-6 text-center text-xs text-slate-400">
            Chưa có tài khoản trong Pool. Bấm <strong>Sign in with Google</strong> hoặc <strong>Thêm TK Colab</strong>.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {accounts.map((acc) => {
              const lifecycle = evaluateAccountLifecycle(acc);
              const runPct = Math.min(
                100,
                Math.round((acc.activeRunSeconds / RUN_DURATION_SEC) * 100)
              );
              const cooldownPct = Math.min(
                100,
                Math.round((acc.cooldownRemainingSeconds / COOLDOWN_DURATION_SEC) * 100)
              );

              return (
                <div
                  key={acc.id}
                  className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-100">{acc.displayName}</h3>
                      <div className="text-xs font-mono text-slate-400">
                        {acc.email} · {acc.gpuType}
                      </div>
                    </div>
                    <span
                      className={`font-mono text-xs font-semibold ${
                        acc.state === 'ACTIVE'
                          ? 'text-emerald-400'
                          : acc.state === 'PREWARMING'
                          ? 'text-amber-400'
                          : acc.state === 'READY'
                          ? 'text-sky-400'
                          : 'text-slate-500'
                      }`}
                    >
                      {acc.state}
                    </span>
                  </div>

                  {acc.state === 'ACTIVE' && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 tabular-nums">
                        <span>Chạy: {formatDurationHms(acc.activeRunSeconds)} / 03h 00m</span>
                        <span>
                          Pre-warm sau:{' '}
                          {lifecycle.prewarmTriggerInSec > 0
                            ? formatDurationHms(lifecycle.prewarmTriggerInSec)
                            : 'Đã bật'}
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-900 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-emerald-500"
                          style={{ width: `${runPct}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {acc.state === 'COOLDOWN' && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 tabular-nums">
                        <span>Cooldown:</span>
                        <span>{formatDurationHms(acc.cooldownRemainingSeconds)} / 16h 00m</span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-900 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-slate-600"
                          style={{ width: `${cooldownPct}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/80 text-xs">
                    <div className="text-slate-400 font-mono tabular-nums">
                      HBM/VRAM: {acc.vramUsedGb}/{acc.vramTotalGb}GB · Đã xuất: {acc.completedJobs} cảnh
                    </div>

                    <div className="flex items-center gap-1.5">
                      {acc.state !== 'ACTIVE' ? (
                        <button
                          type="button"
                          onClick={() => onStartAccount(acc.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-emerald-300 text-xs font-medium"
                        >
                          <Play className="w-3 h-3" />
                          <span>Đặt ACTIVE</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onStopAccount(acc.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-rose-950/60 text-rose-300 text-xs font-medium"
                        >
                          <Square className="w-3 h-3" />
                          <span>Cooldown</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onDeleteAccount(acc.id)}
                        aria-label={`Xóa tài khoản ${acc.email}`}
                        className="p-1.5 rounded-lg text-rose-400 hover:bg-rose-950/50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add Account Modal */}
      {showAddModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-colab-modal-title"
          className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <form
            onSubmit={handleCreateAccount}
            className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 id="add-colab-modal-title" className="text-sm font-semibold text-slate-100">
                Thêm Tài khoản Google Colab
              </h3>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-slate-200 text-xs"
              >
                Đóng
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label htmlFor="colab-email-input" className="block text-xs text-slate-300 mb-1">
                  Email Google Colab
                </label>
                <input
                  id="colab-email-input"
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="colab.node02@gmail.com"
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                />
              </div>

              <div>
                <label htmlFor="colab-name-input" className="block text-xs text-slate-300 mb-1">
                  Tên gợi nhớ
                </label>
                <input
                  id="colab-name-input"
                  type="text"
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                  placeholder="Colab Node #02"
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                />
              </div>

              <div>
                <label htmlFor="colab-gpu-select" className="block text-xs text-slate-300 mb-1">
                  Phần cứng Colab
                </label>
                <select
                  id="colab-gpu-select"
                  value={newGpuType}
                  onChange={(e) => setNewGpuType(e.target.value as ColabAccount['gpuType'])}
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                >
                  <option value="TPU v5e-1 (16GB HBM)">TPU v5e-1 (16GB HBM) — Khuyến nghị cho Wan 2.1 1.3B (~8.2GB)</option>
                  <option value="Tesla T4 (15GB)">Tesla T4 (15GB) — GPU</option>
                  <option value="NVIDIA L4 (24GB)">NVIDIA L4 (24GB) — Colab Pro</option>
                </select>
              </div>
            </div>

            {addError && <p className="text-xs text-rose-400">{addError}</p>}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="px-3 py-1.5 rounded-lg border border-slate-700 text-xs text-slate-300"
              >
                Hủy
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-lg bg-amber-500 text-slate-950 text-xs font-semibold"
              >
                Lưu
              </button>
            </div>
          </form>
        </div>
      )}

      {confirmDialog && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="drive-confirm-title"
          className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-4">
            <div className="flex items-center gap-2 text-amber-400">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <h3 id="drive-confirm-title" className="text-sm font-semibold text-slate-100">
                {confirmDialog.title}
              </h3>
            </div>
            <p className="text-xs text-slate-300">{confirmDialog.description}</p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDialog(null)}
                className="px-3 py-1.5 rounded-lg border border-slate-700 text-xs text-slate-300"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={handleConfirmAction}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold ${
                  confirmDialog.type === 'delete_file'
                    ? 'bg-rose-600 text-white'
                    : 'bg-amber-500 text-slate-950'
                }`}
              >
                Xác nhận
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
