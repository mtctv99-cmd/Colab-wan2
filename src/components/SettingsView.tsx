import React, { useState } from 'react';
import {
  Key,
  Shield,
  Terminal,
  Copy,
  Check,
  RefreshCw,
  Play,
  Trash2,
  UploadCloud,
  ChevronRight,
  ExternalLink,
} from 'lucide-react';
import {
  generateColabNotebookJson,
  generateFastWanWorkerScript,
  type ColabRuntimeSession,
  type WanModelId,
} from '../utils/colabEngine';
import type { DriveColabFile } from '../services/googleWorkspace';

interface ApiKeyItem {
  id: string;
  name: string;
  prefix: string;
  maskedKey: string;
  rpmLimit: number;
  scopes: string[];
  createdAt: string;
  expiresInDays: number;
  requestsCount: number;
}

interface SettingsViewProps {
  appUrl: string;
  session: ColabRuntimeSession;
  maskedWorkerToken: string;
  selectedModel: WanModelId;
  apiKeys: ApiKeyItem[];
  settings: {
    enforceApiKey: boolean;
    maxJobRetries: number;
    leaseTimeoutSec: number;
  };
  driveFiles: DriveColabFile[];
  isRunningE2E: boolean;
  onUpdateSettings: (payload: Record<string, any>) => Promise<void>;
  onRevealWorkerToken: () => Promise<string>;
  onCreateApiKey: (payload: { name: string; rpmLimit: number }) => Promise<{ fullSecret: string }>;
  onRevokeApiKey: (id: string) => Promise<void>;
  onRunE2ETest: (mode: 'mock' | 'real_gpu') => Promise<void>;
  onUploadNotebookToDrive: (filename: string, nbJson: string) => Promise<void>;
  onDeleteDriveFile: (file: DriveColabFile) => Promise<void>;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  appUrl,
  session,
  maskedWorkerToken,
  selectedModel,
  apiKeys,
  settings,
  driveFiles,
  isRunningE2E,
  onUpdateSettings,
  onRevealWorkerToken,
  onCreateApiKey,
  onRevokeApiKey,
  onRunE2ETest,
  onUploadNotebookToDrive,
  onDeleteDriveFile,
}) => {
  const [adcJson, setAdcJson] = useState('');
  const [savingAdc, setSavingAdc] = useState(false);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyRpm, setNewKeyRpm] = useState(60);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  const [maxRetries, setMaxRetries] = useState(settings.maxJobRetries);
  const [leaseTimeoutSec, setLeaseTimeoutSec] = useState(settings.leaseTimeoutSec);
  const [cuBudget, setCuBudget] = useState(session.computeUnitsLimit || 100);
  const [isUploadingDrive, setIsUploadingDrive] = useState(false);

  const copyText = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const handleSaveAdc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adcJson.trim()) return;
    setSavingAdc(true);
    try {
      await onUpdateSettings({ adcJsonContent: adcJson.trim() });
      setAdcJson('');
    } finally {
      setSavingAdc(false);
    }
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyName.trim()) return;
    const res = await onCreateApiKey({ name: newKeyName.trim(), rpmLimit: newKeyRpm });
    setCreatedSecret(res.fullSecret);
    setNewKeyName('');
  };

  const hwFlag =
    session.hardwareTarget === 't4'
      ? '--gpu T4'
      : session.hardwareTarget === 'l4'
      ? '--gpu L4'
      : '--tpu v5e-1';

  const cliCommandBlock = `# Cài CLI một lần trên server Linux
pip install google-colab-cli

# Kiểm tra kết nối tài khoản đã xác thực
colab --auth=adc sessions

# Cấp phát Colab Runtime (${session.hardwareLabel})
colab --auth=adc new -s wan-worker ${hwFlag}

# Kiểm tra phần cứng thật
colab --auth=adc status -s wan-worker

# Chạy bootstrap.py (torch_xla TPU / PyTorch Worker) từ server
colab --auth=adc exec -s wan-worker -f .data/bootstrap.py

# Giải phóng tài nguyên khi xong việc
colab --auth=adc stop -s wan-worker`;

  return (
    <div className="space-y-6">
      {/* Row 1: Colab CLI Authentication + API Security & Queue Policy */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left 6 cols: Xác thực Google Colab CLI */}
        <section className="lg:col-span-6 rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-amber-400" />
              <h2 className="text-base font-bold text-slate-100">
                1. Cấu hình Google Colab CLI (`--auth=adc`)
              </h2>
            </div>
            <button
              type="button"
              onClick={() => copyText('cli-cmds', cliCommandBlock)}
              className="px-2.5 py-1 rounded-md border border-slate-700 bg-slate-950 hover:border-slate-600 text-xs text-slate-200 inline-flex items-center gap-1.5"
            >
              {copiedId === 'cli-cmds' ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Đã sao chép</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy lệnh CLI</span>
                </>
              )}
            </button>
          </div>

          <pre className="rounded-lg border border-slate-800 bg-slate-950 p-3.5 text-[11px] font-mono text-slate-300 overflow-x-auto leading-relaxed">
            {cliCommandBlock}
          </pre>

          <form onSubmit={handleSaveAdc} className="space-y-2 pt-1">
            <label
              htmlFor="adc-json-input"
              className="block text-xs font-semibold text-slate-300"
            >
              Nạp thông tin ủy quyền ADC (`application_default_credentials.json`)
            </label>
            <textarea
              id="adc-json-input"
              rows={3}
              value={adcJson}
              onChange={(e) => setAdcJson(e.target.value)}
              placeholder='{"client_id": "...", "client_secret": "...", "refresh_token": "...", "type": "authorized_user"}'
              className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2.5 text-xs font-mono text-slate-200 focus:border-amber-500 focus:outline-none"
            />
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-400">
                Lưu an toàn tại <code className="font-mono">.data/colab_adc_credentials.json</code> phía server.
              </span>
              <button
                type="submit"
                disabled={savingAdc || !adcJson.trim()}
                className="px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold disabled:opacity-50"
              >
                {savingAdc ? 'Đang lưu...' : 'Lưu ADC Credential'}
              </button>
            </div>
          </form>
        </section>

        {/* Right 6 cols: Bảo mật Worker Token, Queue Recovery & Compute Units */}
        <section className="lg:col-span-6 rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-emerald-400" />
            <h2 className="text-base font-bold text-slate-100">
              2. Bảo mật WebSocket, Hàng đợi SQLite & Ngân sách
            </h2>
          </div>

          {/* Worker Bearer Token Management */}
          <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300">
                Worker WebSocket Bearer Token (`WORKER_AUTH_TOKEN`)
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    const tok = await onRevealWorkerToken();
                    setRevealedToken(tok);
                  }}
                  className="text-xs text-amber-400 hover:underline font-medium"
                >
                  {revealedToken ? 'Đã hiện' : 'Hiện Token'}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await onUpdateSettings({ rotateWorkerToken: true });
                    const tok = await onRevealWorkerToken();
                    setRevealedToken(tok);
                  }}
                  className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Đổi mới</span>
                </button>
              </div>
            </div>
            <div className="font-mono text-xs text-slate-200 bg-slate-900 px-3 py-1.5 rounded border border-slate-800 flex items-center justify-between">
              <span className="truncate">{revealedToken || maskedWorkerToken}</span>
              {revealedToken && (
                <button
                  type="button"
                  onClick={() => copyText('worker-tok', revealedToken)}
                  className="text-amber-400 hover:text-amber-300 text-[11px] ml-2 shrink-0"
                >
                  {copiedId === 'worker-tok' ? 'Đã chép' : 'Copy'}
                </button>
              )}
            </div>
          </div>

          {/* Enforce API Key Toggle + Retry / Lease / Compute Units */}
          <div className="space-y-3 pt-1">
            <label className="flex items-center justify-between cursor-pointer rounded-lg border border-slate-800 bg-slate-950/60 px-3.5 py-2.5">
              <div>
                <div className="text-xs font-semibold text-slate-200">
                  Bắt buộc xác thực API Key (`Authorization: Bearer sk-wan-...`)
                </div>
                <div className="text-[11px] text-slate-400">
                  Khóa các endpoint `/v1/*` trước các truy cập trái phép từ bên ngoài.
                </div>
              </div>
              <input
                type="checkbox"
                checked={settings.enforceApiKey}
                onChange={(e) => onUpdateSettings({ enforceApiKey: e.target.checked })}
                className="w-4 h-4 accent-amber-500"
              />
            </label>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label
                  htmlFor="setting-retries"
                  className="block text-[11px] font-medium text-slate-400 mb-1"
                >
                  Số lần Retry tối đa
                </label>
                <input
                  id="setting-retries"
                  type="number"
                  min={0}
                  max={5}
                  value={maxRetries}
                  onChange={(e) => setMaxRetries(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-mono text-slate-100"
                />
              </div>
              <div>
                <label
                  htmlFor="setting-lease"
                  className="block text-[11px] font-medium text-slate-400 mb-1"
                >
                  Lease Timeout (s)
                </label>
                <input
                  id="setting-lease"
                  type="number"
                  min={30}
                  max={600}
                  value={leaseTimeoutSec}
                  onChange={(e) => setLeaseTimeoutSec(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-mono text-slate-100"
                />
              </div>
              <div>
                <label
                  htmlFor="setting-cu"
                  className="block text-[11px] font-medium text-slate-400 mb-1"
                >
                  Ngân sách CU
                </label>
                <input
                  id="setting-cu"
                  type="number"
                  min={10}
                  max={1000}
                  value={cuBudget}
                  onChange={(e) => setCuBudget(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-mono text-slate-100"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() =>
                  onUpdateSettings({
                    maxJobRetries: maxRetries,
                    leaseTimeoutSec,
                    computeUnitsLimit: cuBudget,
                  })
                }
                className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-100"
              >
                Lưu cấu hình Hàng đợi & Ngân sách
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* Row 2: External App API Keys + Separated E2E Verification */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left 6 cols: Quản lý API Keys (SHA-256) */}
        <section className="lg:col-span-6 rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-bold text-slate-100">
              3. Quản lý API Keys cho App Ngoài ({apiKeys.length})
            </h3>
          </div>

          <form onSubmit={handleCreateKey} className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              aria-label="Tên API Key"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="Tên ứng dụng gọi vào (VD: App Phim Ngắn)"
              className="flex-1 min-w-[180px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
            />
            <input
              type="number"
              aria-label="Giới hạn RPM"
              value={newKeyRpm}
              onChange={(e) => setNewKeyRpm(Number(e.target.value))}
              className="w-24 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-mono text-slate-100"
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold"
            >
              Tạo API Key
            </button>
          </form>

          {createdSecret && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/20 p-3 flex items-center justify-between gap-2 text-xs">
              <div className="font-mono text-emerald-300 truncate">
                Key mới (chỉ hiện 1 lần): <strong>{createdSecret}</strong>
              </div>
              <button
                type="button"
                onClick={() => copyText('new-secret', createdSecret)}
                className="px-2.5 py-1 rounded bg-emerald-500 text-slate-950 font-bold shrink-0"
              >
                {copiedId === 'new-secret' ? 'Đã chép' : 'Copy Key'}
              </button>
            </div>
          )}

          {apiKeys.length === 0 ? (
            <p className="text-xs text-slate-500">Chưa có API Key nào được tạo.</p>
          ) : (
            <div className="divide-y divide-slate-800 border border-slate-800 rounded-lg bg-slate-950/50 text-xs">
              {apiKeys.map((k) => (
                <div key={k.id} className="px-3.5 py-2.5 flex items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-slate-200">{k.name}</div>
                    <div className="font-mono text-[11px] text-slate-400">
                      {k.maskedKey} · {k.requestsCount} requests
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Thu hồi ${k.name}`}
                    onClick={() => onRevokeApiKey(k.id)}
                    className="p-1.5 rounded hover:bg-rose-500/10 text-slate-400 hover:text-rose-400"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Right 6 cols: Kiểm thử Suy luận Wan Thực tế trên TPU v5e-1 */}
        <section className="lg:col-span-6 rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
          <h3 className="text-sm font-bold text-slate-100">
            4. Kiểm thử Suy luận Thực tế (Real TPU v5e-1 Wan Inference E2E)
          </h3>
          <p className="text-xs text-slate-400">
            Chỉ kiểm thử trên Colab TPU v5e-1 Worker thật đang kết nối và chạy `WanPipeline` thực tế (không dùng FFmpeg giả lập).
          </p>

          <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-4 flex flex-col justify-between space-y-3">
            <div>
              <div className="text-xs font-bold text-emerald-300">
                Real TPU v5e-1 Wan Inference E2E
              </div>
              <p className="text-[11px] text-slate-400 mt-1">
                Yêu cầu Colab TPU v5e-1 thật đang kết nối qua WebSocket. Chạy `WanPipeline` (`torch_xla` + `torch.bfloat16`) và đo thời gian suy luận + HBM thực tế.
              </p>
            </div>
            <button
              type="button"
              disabled={isRunningE2E}
              onClick={() => onRunE2ETest('real_gpu')}
              className="w-full py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>{isRunningE2E ? 'Đang kiểm tra Worker thật...' : 'Chạy Real TPU v5e-1 E2E'}</span>
            </button>
          </div>
        </section>
      </div>

      {/* Row 3: Advanced / Fallback Manual Notebook Tools (Collapsed by default per Review) */}
      <details className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 group">
        <summary className="cursor-pointer list-none flex items-center justify-between text-xs font-semibold text-slate-300 hover:text-slate-100">
          <div className="flex items-center gap-2">
            <ChevronRight className="w-4 h-4 text-amber-400 transition-transform group-open:rotate-90" />
            <span>
              Chế độ Advanced / Dự phòng: Xuất file Notebook `.ipynb` thủ công & Xem mã `bootstrap.py`
            </span>
          </div>
          <span className="text-[11px] font-mono text-slate-500">Dự phòng khi không dùng CLI</span>
        </summary>

        <div className="mt-4 pt-4 border-t border-slate-800 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-slate-400">
              Dành cho trường hợp bạn muốn đẩy file `.ipynb` lên Google Drive và bấm Run All thủ công.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={isUploadingDrive}
                onClick={async () => {
                  setIsUploadingDrive(true);
                  try {
                    const tok = revealedToken || (await onRevealWorkerToken());
                    const nbJson = generateColabNotebookJson({
                      serverUrl: appUrl,
                      workerId: `colab-${session.hardwareTarget}-01`,
                      workerToken: tok,
                      modelId: selectedModel,
                      hardwareTarget: session.hardwareTarget,
                    });
                    await onUploadNotebookToDrive(
                      `Wan_Worker_${session.hardwareTarget.toUpperCase()}.ipynb`,
                      nbJson
                    );
                  } finally {
                    setIsUploadingDrive(false);
                  }
                }}
                className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-amber-300 inline-flex items-center gap-1.5"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                <span>{isUploadingDrive ? 'Đang lưu lên Drive...' : 'Lưu .ipynb lên Google Drive'}</span>
              </button>

              <button
                type="button"
                onClick={async () => {
                  const tok = revealedToken || (await onRevealWorkerToken());
                  const py = generateFastWanWorkerScript({
                    serverUrl: appUrl,
                    workerId: `colab-${session.hardwareTarget}-01`,
                    workerToken: tok,
                    modelId: selectedModel,
                    hardwareTarget: session.hardwareTarget,
                  });
                  copyText('bootstrap-py', py);
                }}
                className="px-3.5 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-xs font-semibold text-slate-200 inline-flex items-center gap-1.5"
              >
                {copiedId === 'bootstrap-py' ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Đã chép bootstrap.py</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy bootstrap.py</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {driveFiles.length > 0 && (
            <div className="divide-y divide-slate-800 border border-slate-800 rounded-lg bg-slate-950/60 text-xs">
              {driveFiles.map((f) => (
                <div key={f.id} className="px-3.5 py-2 flex items-center justify-between">
                  <span className="font-mono text-slate-300">{f.name}</span>
                  <div className="flex items-center gap-2">
                    <a
                      href={`https://colab.research.google.com/drive/${f.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-amber-400 hover:underline inline-flex items-center gap-1"
                    >
                      <span>Mở Colab</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                    <button
                      type="button"
                      onClick={() => onDeleteDriveFile(f)}
                      className="text-slate-500 hover:text-rose-400"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </details>
    </div>
  );
};
