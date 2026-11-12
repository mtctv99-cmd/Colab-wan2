import React, { useState } from 'react';
import type { User } from 'firebase/auth';
import {
  Play,
  Square,
  RefreshCw,
  Cpu,
  AlertTriangle,
  CheckCircle2,
  Film,
  Download,
  Trash2,
  ArrowRight,
  Terminal,
  ShieldCheck,
} from 'lucide-react';
import {
  HARDWARE_PROFILES,
  type ColabRuntimeSession,
  type ColabWorkerSnapshot,
  type VideoJob,
  type HardwareTargetId,
} from '../utils/colabEngine';

interface OrchestratorLogItem {
  id: number;
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  source: string;
  message: string;
}

interface OverviewViewProps {
  session: ColabRuntimeSession;
  workers: ColabWorkerSnapshot[];
  jobs: VideoJob[];
  logs: OrchestratorLogItem[];
  googleUser: User | null;
  isSigningIn: boolean;
  isControllingCli: boolean;
  onGoogleLogin: () => Promise<void>;
  onGoogleLogout: () => Promise<void>;
  onChangeHardwareTarget: (hw: HardwareTargetId) => Promise<void>;
  onStartRuntime: () => Promise<void>;
  onStopRuntime: () => Promise<void>;
  onCheckRuntimeStatus: () => Promise<void>;
  onOpenVideoStudio: () => void;
  onOpenSettings: () => void;
  onClearJobs: () => Promise<void>;
}

export const OverviewView: React.FC<OverviewViewProps> = ({
  session,
  workers,
  jobs,
  logs,
  googleUser,
  isSigningIn,
  isControllingCli,
  onGoogleLogin,
  onGoogleLogout,
  onChangeHardwareTarget,
  onStartRuntime,
  onStopRuntime,
  onCheckRuntimeStatus,
  onOpenVideoStudio,
  onOpenSettings,
  onClearJobs,
}) => {
  const [previewJob, setPreviewJob] = useState<VideoJob | null>(null);
  const hwProfile = HARDWARE_PROFILES[session.hardwareTarget] || HARDWARE_PROFILES.tpu_v5e;

  return (
    <div className="space-y-6">
      {/* Row 1: Colab Runtime Control + Account & Auth Status */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left 7 cols: Điều khiển Colab Runtime */}
        <section className="lg:col-span-7 rounded-xl border border-slate-800 bg-slate-900/60 p-5 flex flex-col justify-between space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-amber-400" />
                <h2 className="text-base font-bold text-slate-100">Điều khiển Colab Runtime</h2>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                 Quản lý phiên thực thi thông qua <code className="font-mono text-slate-300">google-colab-cli</code> và kết nối WebSocket Worker có xác thực Bearer Token.
              </p>
            </div>

            <span
              className={`px-2.5 py-1 rounded-md text-xs font-mono font-semibold border ${
                session.workerConnected
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : session.state === 'PROVISIONING' || session.state === 'BOOTSTRAPPING'
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                  : session.state === 'ERROR'
                  ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                  : 'border-slate-700 bg-slate-800/80 text-slate-400'
              }`}
            >
              {session.workerConnected ? `ONLINE · ${session.workerId}` : session.state}
            </span>
          </div>

          {/* Hardware Selector (Locked to TPU v5e-1 XLA BF16) */}
          <div className="space-y-2">
            <label
              htmlFor="overview-hw-select"
              className="block text-xs font-medium text-slate-300"
            >
              Cấu hình Phần cứng & Kiểu dữ liệu Suy luận (Precision Profile)
            </label>
            <div className="grid grid-cols-1 gap-2.5">
              {(['tpu_v5e'] as HardwareTargetId[]).map((hwKey) => {
                const prof = HARDWARE_PROFILES[hwKey];
                return (
                  <button
                    key={hwKey}
                    type="button"
                    onClick={() => onChangeHardwareTarget(hwKey)}
                    className="text-left p-3 rounded-lg border transition-colors border-amber-500 bg-amber-500/10 text-slate-100 flex items-center justify-between"
                  >
                    <div>
                      <div className="text-xs font-semibold text-slate-100">{prof.label}</div>
                      <div className="text-[11px] font-mono text-amber-400 mt-0.5">
                        {prof.torchDtype} Native · --tpu v5e-1 (torch_xla PJRT)
                      </div>
                    </div>
                    <span className="px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-[10px] font-mono font-bold text-amber-300">
                      MẶC ĐỊNH TPU
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-slate-400">{hwProfile.notesVi}</p>
          </div>

          {/* Action Buttons: Start Runtime | Stop | Kiểm tra */}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={onStartRuntime}
              disabled={isControllingCli}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold transition-colors disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>{isControllingCli ? 'Đang thực thi CLI...' : 'Start Runtime'}</span>
            </button>

            <button
              type="button"
              onClick={onStopRuntime}
              disabled={isControllingCli}
              className="flex items-center gap-2 px-3.5 py-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition-colors disabled:opacity-50"
            >
              <Square className="w-3.5 h-3.5" />
              <span>Stop</span>
            </button>

            <button
              type="button"
              onClick={onCheckRuntimeStatus}
              disabled={isControllingCli}
              className="flex items-center gap-2 px-3.5 py-2 rounded-lg border border-slate-700 bg-slate-950 hover:border-slate-600 text-slate-300 text-xs font-semibold transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isControllingCli ? 'animate-spin' : ''}`} />
              <span>Kiểm tra</span>
            </button>

            <button
              type="button"
              onClick={onOpenVideoStudio}
              className="ml-auto flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 text-xs font-semibold transition-colors"
            >
              <span>Sang trang Tạo video</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Honest CLI / Error Diagnostic Banner */}
          {session.lastError && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 flex items-start gap-2.5 text-xs text-amber-200">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-semibold text-amber-300">Trạng thái Colab CLI thực tế:</div>
                <p className="text-slate-300 leading-relaxed">{session.lastError}</p>
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="text-amber-400 hover:underline font-medium inline-flex items-center gap-1 mt-1"
                >
                  <span>Mở Cài đặt CLI & Xác thực ADC</span>
                  <ArrowRight className="w-3 h-3" />
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Right 5 cols: Trạng thái Xác thực & Phần cứng thực */}
        <section className="lg:col-span-5 rounded-xl border border-slate-800 bg-slate-900/60 p-5 flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <h2 className="text-base font-bold text-slate-100">Xác thực & Môi trường</h2>
              </div>
              {googleUser ? (
                <button
                  type="button"
                  onClick={onGoogleLogout}
                  className="text-xs text-slate-400 hover:text-rose-400 transition-colors"
                >
                  Đăng xuất Google
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onGoogleLogin}
                  disabled={isSigningIn}
                  className="px-3 py-1 rounded-md bg-amber-500 text-slate-950 text-xs font-semibold hover:bg-amber-400"
                >
                  {isSigningIn ? 'Đang kết nối...' : 'Đăng nhập Google'}
                </button>
              )}
            </div>

            <div className="divide-y divide-slate-800/80 text-xs border border-slate-800 rounded-lg bg-slate-950/60">
              <div className="px-3.5 py-2.5 flex items-center justify-between">
                <span className="text-slate-400">Tài khoản Google OAuth</span>
                <span className="font-mono text-slate-200">
                  {googleUser?.email || session.accountEmail}
                </span>
              </div>
              <div className="px-3.5 py-2.5 flex items-center justify-between">
                <span className="text-slate-400">Binary `google-colab-cli` (Linux)</span>
                <span
                  className={`font-mono font-semibold ${
                    session.cliBinaryAvailable ? 'text-emerald-400' : 'text-amber-400'
                  }`}
                >
                  {session.cliBinaryAvailable ? 'Đã cài đặt' : 'Chưa cài trên host'}
                </span>
              </div>
              <div className="px-3.5 py-2.5 flex items-center justify-between">
                <span className="text-slate-400">Ủy quyền Colab ADC (`--auth=adc`)</span>
                <span
                  className={`font-mono font-semibold ${
                    session.adcAuthenticated ? 'text-emerald-400' : 'text-amber-400'
                  }`}
                >
                  {session.adcAuthenticated ? 'Đã nạp ADC JSON' : 'Chưa nạp ADC'}
                </span>
              </div>
              <div className="px-3.5 py-2.5 flex items-center justify-between">
                <span className="text-slate-400">GPU / TPU đo thực tế</span>
                <span className="font-mono text-slate-200">
                  {session.workerConnected && session.gpuNameReported
                    ? session.gpuNameReported
                    : '— (Chưa có Worker nối vào)'}
                </span>
              </div>
              <div className="px-3.5 py-2.5 flex items-center justify-between">
                <span className="text-slate-400">Bộ nhớ VRAM / HBM</span>
                <span className="font-mono text-slate-200">
                  {session.vramUsedGb !== null
                    ? `${session.vramUsedGb} / ${session.vramTotalGb} GB (${
                        session.vramIsMeasured ? 'Đo thực tế' : 'Ước tính'
                      })`
                    : `— / ${session.vramTotalGb} GB`}
                </span>
              </div>
              <div className="px-3.5 py-2.5 flex items-center justify-between">
                <span className="text-slate-400">Heartbeat gần nhất</span>
                <span className="font-mono text-slate-300">
                  {session.lastHeartbeatAt
                    ? new Date(session.lastHeartbeatAt).toLocaleTimeString('vi-VN')
                    : '—'}
                </span>
              </div>
            </div>
          </div>

          <div className="text-[11px] text-slate-400 flex items-center justify-between pt-1">
            <span>Database: SQLite WAL (`.data/wan_orchestrator.db`)</span>
            <span className="text-emerald-400 font-mono flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Bearer Auth Bật
            </span>
          </div>
        </section>
      </div>

      {/* Row 2: Active & Recent Jobs (SQLite Queue) + Live Orchestrator Logs */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left 7 cols: Hàng đợi & Job gần đây */}
        <section className="lg:col-span-7 rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-100">
                Hàng đợi & Job Tạo Video ({jobs.length})
              </h3>
              <p className="text-xs text-slate-400">
                Tự động khôi phục (Lease Timeout & Retry) khi Colab Worker ngắt kết nối giữa chừng.
              </p>
            </div>
            {jobs.length > 0 && (
              <button
                type="button"
                onClick={onClearJobs}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-700 hover:border-rose-500/50 text-xs text-slate-300 hover:text-rose-300 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Xóa lịch sử</span>
              </button>
            )}
          </div>

          {jobs.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-800 bg-slate-950/50 p-8 text-center space-y-2">
              <p className="text-xs text-slate-400">
                Hàng đợi SQLite đang trống (0 jobs).
              </p>
              <button
                type="button"
                onClick={onOpenVideoStudio}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-amber-500 text-slate-950 text-xs font-bold hover:bg-amber-400 transition-colors"
              >
                <Film className="w-3.5 h-3.5" />
                <span>Tạo video mới ngay</span>
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-2 pr-3 font-medium">Job / Nguồn</th>
                    <th className="py-2 px-3 font-medium">Model & Khung hình</th>
                    <th className="py-2 px-3 font-medium">Trạng thái</th>
                    <th className="py-2 pl-3 text-right font-medium">Kết quả</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {jobs.slice(0, 8).map((job) => (
                    <tr key={job.id} className="hover:bg-slate-950/40">
                      <td className="py-2.5 pr-3 align-top">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono font-semibold text-slate-200">{job.id}</span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold ${
                              job.isMock
                                ? 'bg-slate-800 text-amber-300 border border-amber-500/30'
                                : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                            }`}
                          >
                            {job.isMock ? 'MOCK FFmpeg' : 'REAL WAN'}
                          </span>
                        </div>
                        <p className="text-slate-400 line-clamp-1 max-w-[240px] mt-0.5">
                          {job.prompt}
                        </p>
                      </td>
                      <td className="py-2.5 px-3 align-top font-mono text-[11px] text-slate-300">
                        <div>
                          {job.metrics.width}×{job.metrics.height} · {job.metrics.latentFrames}f
                        </div>
                        <div className="text-slate-500">
                          {job.inferenceSteps} steps · Retry {job.retryCount}/{job.maxRetries}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 align-top">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-[11px] font-mono font-semibold ${
                            job.status === 'COMPLETED'
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : job.status === 'FAILED'
                              ? 'bg-rose-500/15 text-rose-300'
                              : job.status === 'QUEUED'
                              ? 'bg-slate-800 text-slate-300'
                              : 'bg-amber-500/15 text-amber-300'
                          }`}
                        >
                          {job.status} ({job.progressPct}%)
                        </span>
                        {job.error && (
                          <p className="text-[11px] text-rose-400 mt-1 max-w-[180px] line-clamp-2">
                            {job.error}
                          </p>
                        )}
                      </td>
                      <td className="py-2.5 pl-3 align-top text-right">
                        {job.status === 'COMPLETED' && job.videoUrl ? (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setPreviewJob(job)}
                              className="px-2.5 py-1 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold inline-flex items-center gap-1"
                            >
                              <Film className="w-3 h-3" />
                              <span>Xem MP4</span>
                            </button>
                            <a
                              href={`${job.videoUrl}?download=1`}
                              download={`${job.id}.mp4`}
                              className="px-2 py-1 rounded border border-slate-700 hover:border-slate-500 text-slate-200 inline-flex items-center gap-1"
                            >
                              <Download className="w-3 h-3" />
                            </a>
                          </div>
                        ) : (
                          <span className="text-slate-500 font-mono">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Right 5 cols: Nhật ký Orchestrator & Lỗi */}
        <section className="lg:col-span-5 rounded-xl border border-slate-800 bg-slate-900/60 p-5 flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-amber-400" />
              <h3 className="text-sm font-bold text-slate-100">Nhật ký Orchestrator & Lỗi</h3>
            </div>
            <span className="text-[11px] font-mono text-slate-400">
              {workers.length} Worker Socket
            </span>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 h-[280px] overflow-y-auto space-y-2 font-mono text-[11px]">
            {logs.length === 0 ? (
              <div className="text-slate-500">Chưa có bản ghi log nào.</div>
            ) : (
              logs.map((item) => (
                <div key={item.id} className="leading-relaxed border-b border-slate-900 pb-1.5">
                  <span className="text-slate-500">
                    [{new Date(item.timestamp).toLocaleTimeString('vi-VN')}]
                  </span>{' '}
                  <span
                    className={
                      item.level === 'ERROR'
                        ? 'text-rose-400 font-semibold'
                        : item.level === 'WARN'
                        ? 'text-amber-400 font-semibold'
                        : 'text-emerald-400'
                    }
                  >
                    [{item.source}]
                  </span>{' '}
                  <span className="text-slate-300">{item.message}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* Inline Video Preview Modal */}
      {previewJob && previewJob.videoUrl && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Xem video ${previewJob.id}`}
          className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-2xl w-full p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-bold text-slate-100">
                  Preview Video · {previewJob.id}{' '}
                  <span className="text-xs font-mono text-amber-400">
                    ({previewJob.isMock ? 'MOCK FFmpeg testsrc2' : 'REAL WAN Inference'})
                  </span>
                </h4>
                <p className="text-xs text-slate-400 line-clamp-1 mt-0.5">{previewJob.prompt}</p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewJob(null)}
                className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200"
              >
                Đóng
              </button>
            </div>

            <video
              src={previewJob.videoUrl}
              controls
              autoPlay
              loop
              className="w-full rounded-lg bg-black aspect-video"
            />
          </div>
        </div>
      )}
    </div>
  );
};
