import React, { useState } from 'react';
import {
  Film,
  Sparkles,
  Download,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Sliders,
} from 'lucide-react';
import {
  WAN_MODEL_ADAPTERS,
  HARDWARE_PROFILES,
  calculateFastWanMetrics,
  type ColabRuntimeSession,
  type VideoJob,
  type WanModelId,
  type CameraMotionType,
} from '../utils/colabEngine';

interface VideoStudioViewProps {
  session: ColabRuntimeSession;
  jobs: VideoJob[];
  selectedModel: WanModelId;
  onSelectModel: (m: WanModelId) => void;
  onCreateJob: (payload: Record<string, any>) => Promise<VideoJob>;
  onOptimizePrompt: (payload: {
    prompt: string;
    cameraMotion: CameraMotionType;
    model: WanModelId;
  }) => Promise<{ cinematicPrompt: string; negativePrompt: string; thinkingSummaryVi: string }>;
}

const CAMERA_LABELS: Record<CameraMotionType, string> = {
  dolly_in: 'Dolly In (Tiến sát chủ thể)',
  pan_right: 'Pan Right (Lia ngang phải)',
  pan_left: 'Pan Left (Lia ngang trái)',
  tilt_up: 'Tilt Up (Ngước máy lên)',
  orbit_360: 'Orbit 360° (Xoay quanh chủ thể)',
  fpv_drone: 'FPV Drone (Bay xuyên cảnh)',
  static: 'Static (Khóa cố định chân máy)',
};

export const VideoStudioView: React.FC<VideoStudioViewProps> = ({
  session,
  jobs,
  selectedModel,
  onSelectModel,
  onCreateJob,
  onOptimizePrompt,
}) => {
  const adapter =
    WAN_MODEL_ADAPTERS[selectedModel] ||
    WAN_MODEL_ADAPTERS['FastVideo/FastWan2.1-T2V-1.3B-Diffusers'];

  const [prompt, setPrompt] = useState<string>('');
  const [negativePrompt, setNegativePrompt] = useState<string>(
    'Bright tones, overexposed, static, blurred details, subtitles, worst quality, low quality'
  );
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16' | '1:1'>('16:9');
  const [durationSec, setDurationSec] = useState<number>(adapter.distilled ? 4 : 5);
  const [cameraMotion, setCameraMotion] = useState<CameraMotionType>('dolly_in');
  const [inferenceSteps, setInferenceSteps] = useState<number>(adapter.defaultSteps);
  const [guidanceScale, setGuidanceScale] = useState<number>(adapter.defaultGuidanceScale);
  const [flowShift, setFlowShift] = useState<number>(adapter.defaultFlowShift);
  const [seed, setSeed] = useState<number>(428899);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [directorNote, setDirectorNote] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const handleModelSwitch = (m: WanModelId) => {
    onSelectModel(m);
    const spec = WAN_MODEL_ADAPTERS[m];
    setInferenceSteps(spec.defaultSteps);
    setGuidanceScale(spec.defaultGuidanceScale);
    setFlowShift(spec.defaultFlowShift);
    setDurationSec(spec.distilled ? 4 : 5);
  };

  const metrics = calculateFastWanMetrics({
    model: selectedModel,
    hardwareTarget: session.hardwareTarget,
    resolution: '480p',
    aspectRatio,
    durationSec,
    fps: 16,
    inferenceSteps,
  });

  const hwProfile = HARDWARE_PROFILES[session.hardwareTarget] || HARDWARE_PROFILES.tpu_v5e;

  const activeOrLatestJob =
    jobs.find((j) => j.id === selectedJobId) ||
    jobs.find((j) => j.status === 'DIFFUSING' || j.status === 'DISPATCHED' || j.status === 'QUEUED') ||
    jobs.find((j) => j.status === 'COMPLETED') ||
    jobs[0] ||
    null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!prompt.trim()) {
      setFormError('Vui lòng nhập mô tả cảnh video (Prompt) trước khi tạo.');
      return;
    }

    setIsSubmitting(true);
    try {
      const created = await onCreateJob({
        model: selectedModel,
        hardwareTarget: session.hardwareTarget,
        prompt: prompt.trim(),
        negativePrompt: negativePrompt.trim(),
        aspectRatio,
        durationSec,
        fps: 16,
        inferenceSteps,
        guidanceScale,
        flowShift,
        cameraMotion,
        seed,
      });
      setSelectedJobId(created.id);
    } catch (err: any) {
      setFormError(err?.message || 'Không thể gửi yêu cầu tạo video.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAiOptimize = async () => {
    if (!prompt.trim()) {
      setFormError('Hãy nhập ý tưởng ngắn gọn trước khi bấm Tối ưu Prompt.');
      return;
    }
    setFormError(null);
    setIsOptimizing(true);
    try {
      const res = await onOptimizePrompt({
        prompt: prompt.trim(),
        cameraMotion,
        model: selectedModel,
      });
      if (res.cinematicPrompt) setPrompt(res.cinematicPrompt);
      if (res.negativePrompt) setNegativePrompt(res.negativePrompt);
      if (res.thinkingSummaryVi) setDirectorNote(res.thinkingSummaryVi);
    } catch (err: any) {
      setFormError(err?.message || 'Lỗi khi gọi Gemini AI Director.');
    } finally {
      setIsOptimizing(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left 7 cols: Video Generation Form */}
      <form
        onSubmit={handleSubmit}
        className="lg:col-span-7 rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-100">Tạo Video Wan Trực Tiếp</h2>
            <p className="text-xs text-slate-400">
              Gửi job trực tiếp vào SQLite Queue — không cần copy cell hay mở notebook thủ công.
            </p>
          </div>
          <span className="px-2.5 py-1 rounded-md border border-slate-700 bg-slate-950 text-[11px] font-mono text-amber-300">
            {hwProfile.label} · {hwProfile.torchDtype}
          </span>
        </div>

        {formError && (
          <div
            role="alert"
            className="rounded-lg border border-rose-500/40 bg-rose-950/30 px-3.5 py-2.5 text-xs text-rose-200 flex items-center gap-2"
          >
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{formError}</span>
          </div>
        )}

        {/* 1. Model Adapter Selection */}
        <div className="space-y-1.5">
          <label htmlFor="video-model-select" className="block text-xs font-semibold text-slate-300">
            1. Chọn Model Adapter
          </label>
          <select
            id="video-model-select"
            value={selectedModel}
            onChange={(e) => handleModelSwitch(e.target.value as WanModelId)}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
          >
            {Object.values(WAN_MODEL_ADAPTERS).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-slate-400">{adapter.notesVi}</p>
        </div>

        {/* 2. Prompt & AI Director */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="video-prompt-input" className="text-xs font-semibold text-slate-300">
              2. Kịch bản Cảnh quay (Prompt)
            </label>
            <button
              type="button"
              onClick={handleAiOptimize}
              disabled={isOptimizing}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 text-[11px] font-semibold transition-colors disabled:opacity-50"
            >
              <Sparkles className="w-3 h-3" />
              <span>{isOptimizing ? 'Đang viết lại...' : 'Tối ưu Prompt chuẩn Điện ảnh'}</span>
            </button>
          </div>
          <textarea
            id="video-prompt-input"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Mô tả góc máy, chủ thể, hành động, ánh sáng và màu phim..."
            className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs text-slate-100 leading-relaxed focus:border-amber-500 focus:outline-none"
          />
          {directorNote && (
            <p className="text-[11px] text-emerald-400">
              AI Director: {directorNote}
            </p>
          )}
        </div>

        {/* 3. Aspect Ratio, Duration/Frames, Camera Motion */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="video-aspect-select" className="block text-xs font-medium text-slate-300 mb-1">
              Tỷ lệ khung hình
            </label>
            <select
              id="video-aspect-select"
              value={aspectRatio}
              onChange={(e) => setAspectRatio(e.target.value as '16:9' | '9:16' | '1:1')}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
            >
              <option value="16:9">
                16:9 Ngang ({adapter.defaultWidth16x9}×{adapter.defaultHeight16x9})
              </option>
              <option value="9:16">
                9:16 Dọc ({adapter.defaultWidth9x16}×{adapter.defaultHeight9x16})
              </option>
              <option value="1:1">1:1 Vuông (640×640)</option>
            </select>
          </div>

          <div>
            <label htmlFor="video-duration-select" className="block text-xs font-medium text-slate-300 mb-1">
              Thời lượng / Số Frame
            </label>
            <select
              id="video-duration-select"
              value={durationSec}
              onChange={(e) => setDurationSec(Number(e.target.value))}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
            >
              <option value={4}>~3.8 giây (61 frames @ 16fps — Chuẩn FastWan)</option>
              <option value={5}>~5.0 giây (81 frames @ 16fps — Chuẩn Wan 2.1)</option>
            </select>
          </div>

          <div>
            <label htmlFor="video-camera-select" className="block text-xs font-medium text-slate-300 mb-1">
              Chuyển động Camera
            </label>
            <select
              id="video-camera-select"
              value={cameraMotion}
              onChange={(e) => setCameraMotion(e.target.value as CameraMotionType)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
            >
              {(Object.keys(CAMERA_LABELS) as CameraMotionType[]).map((cam) => (
                <option key={cam} value={cam}>
                  {CAMERA_LABELS[cam]}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 4. Steps, CFG, Flow Shift, Seed */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
          <div>
            <label htmlFor="video-steps-input" className="block text-[11px] font-medium text-slate-400 mb-1">
              Inference Steps
            </label>
            <input
              id="video-steps-input"
              type="number"
              min={1}
              max={50}
              value={inferenceSteps}
              onChange={(e) => setInferenceSteps(Number(e.target.value))}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-mono text-slate-100"
            />
          </div>

          <div>
            <label htmlFor="video-cfg-input" className="block text-[11px] font-medium text-slate-400 mb-1">
              Guidance (CFG)
            </label>
            <input
              id="video-cfg-input"
              type="number"
              step={0.5}
              min={1}
              max={12}
              value={guidanceScale}
              onChange={(e) => setGuidanceScale(Number(e.target.value))}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-mono text-slate-100"
            />
          </div>

          <div>
            <label htmlFor="video-flow-input" className="block text-[11px] font-medium text-slate-400 mb-1">
              Flow Shift
            </label>
            <input
              id="video-flow-input"
              type="number"
              step={0.5}
              min={1}
              max={7}
              value={flowShift}
              onChange={(e) => setFlowShift(Number(e.target.value))}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-mono text-slate-100"
            />
          </div>

          <div>
            <label htmlFor="video-seed-input" className="block text-[11px] font-medium text-slate-400 mb-1">
              Seed cố định
            </label>
            <div className="flex items-center gap-1">
              <input
                id="video-seed-input"
                type="number"
                value={seed}
                onChange={(e) => setSeed(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs font-mono text-slate-100"
              />
              <button
                type="button"
                aria-label="Ngẫu nhiên hóa Seed"
                onClick={() => setSeed(Math.floor(100000 + Math.random() * 900000))}
                className="p-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Negative prompt collapsible */}
        <details className="text-xs text-slate-400">
          <summary className="cursor-pointer hover:text-slate-200 font-medium inline-flex items-center gap-1.5">
            <Sliders className="w-3.5 h-3.5" />
            <span>Tùy chỉnh Negative Prompt</span>
          </summary>
          <input
            type="text"
            aria-label="Negative Prompt"
            value={negativePrompt}
            onChange={(e) => setNegativePrompt(e.target.value)}
            className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200"
          />
        </details>

        {/* Honest Estimation Bar + Generate Button */}
        <div className="pt-2 border-t border-slate-800 flex flex-wrap items-center justify-between gap-4">
          <div className="text-[11px] font-mono text-slate-400 space-y-0.5">
            <div>
              Khung xuất: <strong className="text-slate-200">{metrics.width}×{metrics.height}</strong> ·{' '}
              <strong className="text-slate-200">{metrics.latentFrames} frames</strong> @ 16fps
            </div>
            <div>
              VRAM dự kiến: <strong className="text-amber-300">~{metrics.estimatedVramGb} GB (Ước tính)</strong> · Thời gian ~{metrics.estimatedDurationSec}s
            </div>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="px-5 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold inline-flex items-center gap-2 transition-colors disabled:opacity-50"
          >
            <Film className="w-4 h-4" />
            <span>{isSubmitting ? 'Đang đẩy vào hàng đợi...' : 'Generate Video'}</span>
          </button>
        </div>
      </form>

      {/* Right 5 cols: Live Progress, MP4 Preview Player & Job Selector */}
      <section className="lg:col-span-5 rounded-xl border border-slate-800 bg-slate-900/60 p-5 flex flex-col justify-between space-y-4">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-slate-100">Tiến độ & Preview MP4</h3>
            {activeOrLatestJob && (
              <span
                className={`px-2 py-0.5 rounded text-[11px] font-mono font-semibold ${
                  activeOrLatestJob.isMock
                    ? 'bg-slate-800 text-amber-300 border border-amber-500/30'
                    : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                }`}
              >
                {activeOrLatestJob.isMock ? 'MOCK FFmpeg' : 'REAL WAN JOB'}
              </span>
            )}
          </div>

          {!activeOrLatestJob ? (
            <div className="rounded-lg border border-dashed border-slate-800 bg-slate-950/60 aspect-video flex flex-col items-center justify-center p-6 text-center space-y-2">
              <Film className="w-8 h-8 text-slate-600" />
              <p className="text-xs text-slate-400">
                Nhập Prompt bên trái và bấm <strong>Generate Video</strong> để bắt đầu.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Video Player or Progress Box */}
              {activeOrLatestJob.status === 'COMPLETED' && activeOrLatestJob.videoUrl ? (
                <div className="space-y-2.5">
                  <video
                    key={activeOrLatestJob.videoUrl}
                    src={activeOrLatestJob.videoUrl}
                    controls
                    autoPlay
                    loop
                    className="w-full rounded-lg border border-slate-700 bg-black aspect-video"
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-emerald-400 inline-flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Hoàn tất ({((activeOrLatestJob.fileSizeBytes || 0) / 1024).toFixed(0)} KB)
                    </span>
                    <a
                      href={`${activeOrLatestJob.videoUrl}?download=1`}
                      download={`${activeOrLatestJob.id}.mp4`}
                      className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold inline-flex items-center gap-1.5"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download .MP4</span>
                    </a>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-5 space-y-3">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="text-amber-300 font-semibold">
                      {activeOrLatestJob.status} · {activeOrLatestJob.id}
                    </span>
                    <span className="text-slate-300">
                      Step {activeOrLatestJob.currentStep}/{activeOrLatestJob.inferenceSteps} (
                      {activeOrLatestJob.progressPct}%)
                    </span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-amber-500 transition-all duration-300"
                      style={{ width: `${Math.max(6, activeOrLatestJob.progressPct)}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-slate-400">
                    {activeOrLatestJob.status === 'QUEUED'
                      ? session.workerConnected
                        ? 'Đang chờ đến lượt trên Colab Worker...'
                        : 'Đã lưu bền vững vào SQLite Queue. Ngay khi Colab Runtime kết nối, job này sẽ tự động chạy.'
                      : 'Đang suy luận trên Worker...'}
                  </p>
                </div>
              )}

              {/* Job Metadata Summary */}
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs space-y-1">
                <div className="font-mono text-[11px] text-slate-400">
                  {activeOrLatestJob.model} · {activeOrLatestJob.metrics.width}×
                  {activeOrLatestJob.metrics.height} · Seed {activeOrLatestJob.seed}
                </div>
                <p className="text-slate-300 line-clamp-2">{activeOrLatestJob.prompt}</p>
              </div>
            </div>
          )}
        </div>

        {/* Recent Jobs Quick Switcher */}
        {jobs.length > 1 && (
          <div className="space-y-2 pt-3 border-t border-slate-800">
            <div className="text-xs font-semibold text-slate-300">Các job gần đây ({jobs.length})</div>
            <div className="space-y-1.5 max-h-[160px] overflow-y-auto">
              {jobs.slice(0, 6).map((j) => (
                <button
                  key={j.id}
                  type="button"
                  onClick={() => setSelectedJobId(j.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg border text-xs flex items-center justify-between transition-colors ${
                    activeOrLatestJob?.id === j.id
                      ? 'border-amber-500/60 bg-amber-500/10 text-slate-100'
                      : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700'
                  }`}
                >
                  <span className="font-mono truncate max-w-[180px]">{j.id}</span>
                  <span className="font-mono text-[11px]">
                    {j.status} ({j.progressPct}%)
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
