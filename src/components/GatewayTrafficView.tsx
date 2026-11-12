import React, { useMemo, useState } from 'react';
import { Plus, Trash2, Copy, Check, Play, Download, Eye } from 'lucide-react';
import type { VideoJob, WanModelId } from '../utils/colabEngine';

interface TrafficPoint {
  label: string;
  requests: number;
  diffusionSteps: number;
  gpuSeconds: number;
  avgLatencySec: number;
}

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

interface GatewayTrafficViewProps {
  traffic: Record<'24h' | '7d' | '30d', TrafficPoint[]>;
  apiKeys: ApiKeyItem[];
  jobs: VideoJob[];
  appUrl: string;
  selectedModel: WanModelId;
  isRunningE2E: boolean;
  onRunE2ETest: () => Promise<void>;
  onClearJobs: () => Promise<void>;
  onCreateApiKey: (payload: {
    name: string;
    rpmLimit: number;
    expiresInDays: number;
    scopes: string[];
  }) => Promise<{ fullSecret?: string } | null>;
  onRevokeApiKey: (id: string) => Promise<void>;
}

export const GatewayTrafficView: React.FC<GatewayTrafficViewProps> = ({
  traffic,
  apiKeys,
  jobs,
  appUrl,
  selectedModel,
  isRunningE2E,
  onRunE2ETest,
  onClearJobs,
  onCreateApiKey,
  onRevokeApiKey,
}) => {
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [rpmLimit, setRpmLimit] = useState(60);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [apiDocTab, setApiDocTab] = useState<'single' | 'batch' | 'poll'>('single');
  const [previewJob, setPreviewJob] = useState<VideoJob | null>(null);

  const series = traffic['24h'] || [];
  const totals = useMemo(() => {
    return series.reduce(
      (acc, p) => {
        acc.requests += p.requests;
        acc.diffusionSteps += p.diffusionSteps;
        acc.gpuSeconds += p.gpuSeconds;
        return acc;
      },
      { requests: 0, diffusionSteps: 0, gpuSeconds: 0 }
    );
  }, [series]);

  const handleSubmitKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyName.trim()) return;
    const res = await onCreateApiKey({
      name: keyName.trim(),
      rpmLimit,
      expiresInDays,
      scopes: ['video.generations', 'models.read', 'workers.status'],
    });
    setKeyName('');
    setShowKeyModal(false);
    if (res?.fullSecret) {
      setRevealedSecret(res.fullSecret);
    }
  };

  const handleCopySecret = async () => {
    if (!revealedSecret) return;
    try {
      await navigator.clipboard.writeText(revealedSecret);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    } catch {
      // Ignore
    }
  };

  const defaultSteps =
    selectedModel === 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers' ? 4 : 30;

  const singleShotSnippet = `curl -X POST "${appUrl}/v1/video/generations" \\
  -H "Authorization: Bearer ${revealedSecret || 'sk-wan-...'}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${selectedModel}",
    "prompt": "a lone cyberpunk detective walking through a rainy neon-lit alley in Tokyo at night, 35mm film grain",
    "negative_prompt": "Bright tones, overexposed, static, blurred details, subtitles, low quality",
    "camera_motion": "dolly_in",
    "enhance_prompt": false,
    "num_inference_steps": ${defaultSteps},
    "guidance_scale": 5.0,
    "flow_shift": 3.0,
    "seed": 42,
    "lock_xla_shape": true,
    "vae_tiling": true,
    "vae_slicing": true,
    "wait": true
  }'`;

  const batchScenesSnippet = `curl -X POST "${appUrl}/v1/video/scenes/batch" \\
  -H "Authorization: Bearer ${revealedSecret || 'sk-wan-...'}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${selectedModel}",
    "inferenceSteps": ${defaultSteps},
    "scenes": [
      { "prompt": "Scene 1: Wide establishing shot of rainy Tokyo alley at midnight", "cameraMotion": "dolly_in", "seed": 101 },
      { "prompt": "Scene 2: Close-up of detective looking at holographic map under neon sign", "cameraMotion": "pan_right", "seed": 102 }
    ]
  }'`;

  const pollDownloadSnippet = `# 1. Kiểm tra danh sách model & tham số hỗ trợ:
curl "${appUrl}/v1/models"

# 2. Kiểm tra tiến độ Job (current_step / total_steps & video_url):
curl "${appUrl}/v1/video/generations/<JOB_ID>"

# 3. Phát trực tiếp hoặc tải file .mp4 đã xuất:
curl -L "${appUrl}/v1/videos/<JOB_ID>.mp4?download=1" -o scene_01.mp4`;

  return (
    <div className="space-y-6">
      {/* Section 1: API Keys & Production Endpoint Spec */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-5 rounded-xl border border-slate-800 bg-slate-900/70 p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h2 className="text-base font-semibold text-slate-100">
              API Keys cho App Ngoài ({apiKeys.length})
            </h2>
            <button
              type="button"
              onClick={() => setShowKeyModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Tạo API Key</span>
            </button>
          </div>

          {revealedSecret && (
            <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3.5 space-y-2">
              <div className="text-xs font-semibold text-amber-300">API Key vừa tạo:</div>
              <div className="flex items-center justify-between gap-2 bg-slate-950 rounded-lg px-3 py-2 border border-slate-800">
                <code className="text-xs font-mono text-emerald-400 break-all">
                  {revealedSecret}
                </code>
                <button
                  type="button"
                  onClick={handleCopySecret}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 whitespace-nowrap"
                >
                  {copiedKey ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedKey ? 'Đã chép' : 'Copy'}</span>
                </button>
              </div>
            </div>
          )}

          {apiKeys.length === 0 ? (
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-5 text-center text-xs text-slate-400">
              Bấm <strong>Tạo API Key</strong> để lấy mã <code className="font-mono">sk-wan-...</code> gắn vào ứng dụng tạo video của bạn.
            </div>
          ) : (
            <div className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950">
              {apiKeys.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-xs"
                >
                  <div>
                    <div className="font-semibold text-slate-100">{item.name}</div>
                    <div className="font-mono text-slate-400 tabular-nums">
                      {item.maskedKey} · {item.rpmLimit} RPM · {item.requestsCount} reqs
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRevokeApiKey(item.id)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-rose-400 hover:bg-rose-950/50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Xóa</span>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Supported Model Features Checklist */}
          <div className="rounded-lg border border-slate-800 bg-slate-950 p-3.5 space-y-2 text-xs">
            <div className="font-semibold text-slate-200">
              Tính năng Model & API hỗ trợ sẵn sàng cho App ngoài:
            </div>
            <div className="grid grid-cols-2 gap-1.5 font-mono text-[11px] text-slate-300">
              <div>• FastWan 1.3B (4 steps)</div>
              <div>• Wan 2.1 1.3B (30 steps)</div>
              <div>• lock_xla_shape (832x480x81)</div>
              <div>• vae_tiling + vae_slicing</div>
              <div>• flow_shift (UniPC 3.0)</div>
              <div>• seed & guidance_scale</div>
              <div>• camera_motion (7 quỹ đạo)</div>
              <div>• enhance_prompt (Gemini 4)</div>
              <div>• wait: true (Đợi nhận MP4)</div>
              <div>• Batch Multi-Scene Film</div>
            </div>
          </div>
        </div>

        {/* Right Column: Full API Reference Tabs */}
        <div className="lg:col-span-7 rounded-xl border border-slate-800 bg-slate-900/70 p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
            <h2 className="text-base font-semibold text-slate-100">
              Chuẩn Giao tiếp API cho App Ngoài (Production)
            </h2>
            <div className="flex items-center gap-1 p-1 bg-slate-950 rounded-lg border border-slate-800 text-xs">
              <button
                type="button"
                onClick={() => setApiDocTab('single')}
                className={`px-2.5 py-1 rounded font-medium ${
                  apiDocTab === 'single' ? 'bg-slate-800 text-amber-300' : 'text-slate-400'
                }`}
              >
                1. Tạo 1 Cảnh (Sync/Async)
              </button>
              <button
                type="button"
                onClick={() => setApiDocTab('batch')}
                className={`px-2.5 py-1 rounded font-medium ${
                  apiDocTab === 'batch' ? 'bg-slate-800 text-amber-300' : 'text-slate-400'
                }`}
              >
                2. Tạo Chuỗi Cảnh Phim Ngắn
              </button>
              <button
                type="button"
                onClick={() => setApiDocTab('poll')}
                className={`px-2.5 py-1 rounded font-medium ${
                  apiDocTab === 'poll' ? 'bg-slate-800 text-amber-300' : 'text-slate-400'
                }`}
              >
                3. Poll & Tải .MP4
              </button>
            </div>
          </div>

          <pre className="rounded-xl border border-slate-800 bg-slate-950 p-3.5 text-[11px] font-mono text-slate-200 overflow-x-auto leading-relaxed">
            <code>
              {apiDocTab === 'single'
                ? singleShotSnippet
                : apiDocTab === 'batch'
                ? batchScenesSnippet
                : pollDownloadSnippet}
            </code>
          </pre>
        </div>
      </div>

      {/* Section 2: Jobs Log, Inline MP4 Player & E2E Test Trigger */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-4">
            <h3 className="text-base font-semibold text-slate-100">
              Nhật ký Video Đã Tạo (/v1/video/generations) — {jobs.length} Jobs
            </h3>
            <span className="text-xs font-mono text-slate-400 tabular-nums">
              Steps: {totals.diffusionSteps} · TPU/GPU Time: {(totals.gpuSeconds / 60).toFixed(1)}m
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRunE2ETest}
              disabled={isRunningE2E}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold transition-colors disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              <span>{isRunningE2E ? 'Đang tạo video E2E...' : 'Chạy Kiểm thử Tạo Video (.MP4)'}</span>
            </button>
            {jobs.length > 0 && (
              <button
                type="button"
                onClick={onClearJobs}
                className="px-3 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs text-slate-300"
              >
                Xóa lịch sử
              </button>
            )}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 font-medium">
                <th className="py-2 pr-4">Job ID</th>
                <th className="py-2 px-4">Worker & Tài khoản</th>
                <th className="py-2 px-4">Thông số (XLA / Steps / Seed / FlowShift)</th>
                <th className="py-2 px-4">Trạng thái</th>
                <th className="py-2 pl-4 text-right">File Video (.MP4)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
              {jobs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-400 font-sans">
                    Chưa có request nào. Bấm <strong>Chạy Kiểm thử Tạo Video (.MP4)</strong> để kiểm tra toàn bộ quy trình sinh file `.mp4` (832x480 · 81 frames) và phát thử ngay tại đây.
                  </td>
                </tr>
              ) : (
                jobs.slice(0, 10).map((j) => (
                  <tr key={j.id} className="hover:bg-slate-950/50">
                    <td className="py-2.5 pr-4 text-slate-100 font-semibold">{j.id}</td>
                    <td className="py-2.5 px-4 text-slate-300">
                      {j.workerId} · {j.accountEmail}
                    </td>
                    <td className="py-2.5 px-4 text-slate-400">
                      {j.metrics.width}x{j.metrics.height} · {j.metrics.latentFrames}f@{j.fps}fps ·{' '}
                      {j.inferenceSteps} steps · flow={j.flowShift ?? 3.0} · seed={j.seed}
                    </td>
                    <td className="py-2.5 px-4">
                      <span
                        className={
                          j.status === 'COMPLETED'
                            ? 'text-emerald-400 font-semibold'
                            : j.status === 'FAILED'
                            ? 'text-rose-400 font-semibold'
                            : 'text-amber-400 font-semibold'
                        }
                      >
                        {j.status} ({j.progressPct}%)
                      </span>
                    </td>
                    <td className="py-2.5 pl-4 text-right">
                      {j.videoUrl ? (
                        <div className="inline-flex items-center gap-2 font-sans">
                          <button
                            type="button"
                            onClick={() => setPreviewJob(j)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 text-xs font-medium"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>Xem MP4</span>
                          </button>
                          <a
                            href={`${j.videoUrl}?download=1`}
                            download={`${j.id}.mp4`}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 text-xs font-medium"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>
                              Tải ({j.fileSizeBytes ? `${Math.round(j.fileSizeBytes / 1024)}KB` : 'MP4'})
                            </span>
                          </a>
                        </div>
                      ) : (
                        <span className="text-slate-500">Đang chờ...</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Inline MP4 Video Preview Modal */}
      {previewJob && previewJob.videoUrl && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="preview-mp4-title"
          className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div className="w-full max-w-3xl rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 id="preview-mp4-title" className="text-sm font-semibold text-slate-100">
                  Xem trước Video Đã Xuất: {previewJob.id}.mp4
                </h3>
                <p className="text-xs font-mono text-slate-400">
                  {previewJob.metrics.width}x{previewJob.metrics.height} · {previewJob.metrics.latentFrames}{' '}
                  frames @ {previewJob.fps}fps · URL: {appUrl}{previewJob.videoUrl}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewJob(null)}
                className="px-3 py-1 rounded-lg border border-slate-700 text-xs text-slate-300 hover:bg-slate-800"
              >
                Đóng
              </button>
            </div>

            <div className="rounded-lg overflow-hidden bg-black border border-slate-800">
              <video
                src={previewJob.videoUrl}
                controls
                autoPlay
                loop
                className="w-full max-h-[420px] object-contain mx-auto"
              />
            </div>

            <div className="text-xs text-slate-300 font-mono bg-slate-950 p-3 rounded-lg border border-slate-800">
              Prompt: {previewJob.enhancedPrompt || previewJob.prompt}
            </div>
          </div>
        </div>
      )}

      {showKeyModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-key-modal-title"
          className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <form
            onSubmit={handleSubmitKey}
            className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-4"
          >
            <h3 id="create-key-modal-title" className="text-sm font-semibold text-slate-100">
              Tạo API Key Mới
            </h3>
            <div className="space-y-3">
              <div>
                <label htmlFor="new-key-name" className="block text-xs text-slate-300 mb-1">
                  Tên gợi nhớ (App ngoài)
                </label>
                <input
                  id="new-key-name"
                  type="text"
                  required
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  placeholder="short-film-app"
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="new-key-rpm" className="block text-xs text-slate-300 mb-1">
                    Giới hạn RPM
                  </label>
                  <select
                    id="new-key-rpm"
                    value={rpmLimit}
                    onChange={(e) => setRpmLimit(Number(e.target.value))}
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                  >
                    <option value={30}>30 RPM</option>
                    <option value={60}>60 RPM</option>
                    <option value={120}>120 RPM</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="new-key-exp" className="block text-xs text-slate-300 mb-1">
                    Thời hạn
                  </label>
                  <select
                    id="new-key-exp"
                    value={expiresInDays}
                    onChange={(e) => setExpiresInDays(Number(e.target.value))}
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                  >
                    <option value={30}>30 ngày</option>
                    <option value={90}>90 ngày</option>
                    <option value={0}>Không hết hạn</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowKeyModal(false)}
                className="px-3 py-1.5 rounded-lg border border-slate-700 text-xs text-slate-300"
              >
                Hủy
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-lg bg-amber-500 text-slate-950 text-xs font-semibold"
              >
                Tạo Key
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
