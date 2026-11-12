export type RuntimeSessionState =
  | 'DISCONNECTED'
  | 'PROVISIONING'
  | 'BOOTSTRAPPING'
  | 'READY'
  | 'BUSY'
  | 'STOPPING'
  | 'ERROR';

export type WanModelId =
  | 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers'
  | 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers'
  | 'Wan-AI/Wan2.2-T2V-1.3B-Diffusers';

export type HardwareTargetId = 'tpu_v5e' | 't4' | 'l4';

export type CommercialPresetId =
  | 'kling-1.6-pro'
  | 'veo-2-cinema'
  | 'sora-motion'
  | 'fastwan-turbo';

export type CameraMotionType =
  | 'static'
  | 'pan_right'
  | 'pan_left'
  | 'tilt_up'
  | 'dolly_in'
  | 'orbit_360'
  | 'fpv_drone';

export type ColabAcceleratorType =
  | 'TPU v5e-1 (16GB HBM · XLA BF16)'
  | 'Tesla T4 (15GB · FP16)'
  | 'NVIDIA L4 (24GB · BF16)';

export interface ModelAdapterSpec {
  id: WanModelId;
  label: string;
  family: 'fastwan-2.1' | 'wan-2.1' | 'wan-2.2';
  pipelineClass: 'AutoPipelineForText2Video' | 'WanPipeline';
  defaultSteps: number;
  defaultGuidanceScale: number;
  defaultFlowShift: number;
  defaultFrames: number;
  defaultFps: 16 | 24;
  defaultWidth16x9: number;
  defaultHeight16x9: number;
  defaultWidth9x16: number;
  defaultHeight9x16: number;
  defaultWidth1x1: number;
  defaultHeight1x1: number;
  distilled: boolean;
  notesVi: string;
}

export const WAN_MODEL_ADAPTERS: Record<WanModelId, ModelAdapterSpec> = {
  'FastVideo/FastWan2.1-T2V-1.3B-Diffusers': {
    id: 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers',
    label: 'FastWan 2.1 1.3B (Distilled · 3 Steps · 832×448 · 61f)',
    family: 'fastwan-2.1',
    pipelineClass: 'WanPipeline',
    defaultSteps: 3,
    defaultGuidanceScale: 1.0,
    defaultFlowShift: 3.0,
    defaultFrames: 61,
    defaultFps: 16,
    defaultWidth16x9: 832,
    defaultHeight16x9: 448,
    defaultWidth9x16: 448,
    defaultHeight9x16: 832,
    defaultWidth1x1: 640,
    defaultHeight1x1: 640,
    distilled: true,
    notesVi:
      'Cấu hình gốc theo Model Card FastVideo: 3 steps, 61 frames (~3.8s @ 16fps), 832×448 (chưng cất Sparse-Distillation).',
  },
  'Wan-AI/Wan2.1-T2V-1.3B-Diffusers': {
    id: 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers',
    label: 'Wan 2.1 1.3B Standard (30 Steps · 832×480 · 81f)',
    family: 'wan-2.1',
    pipelineClass: 'WanPipeline',
    defaultSteps: 30,
    defaultGuidanceScale: 5.0,
    defaultFlowShift: 3.0,
    defaultFrames: 81,
    defaultFps: 16,
    defaultWidth16x9: 832,
    defaultHeight16x9: 480,
    defaultWidth9x16: 480,
    defaultHeight9x16: 832,
    defaultWidth1x1: 640,
    defaultHeight1x1: 640,
    distilled: false,
    notesVi:
      'Bản chuẩn Wan-AI: 30 steps, 81 frames (~5.0s @ 16fps), 832×480, chất lượng chi tiết và chuyển động cao nhất.',
  },
  'Wan-AI/Wan2.2-T2V-1.3B-Diffusers': {
    id: 'Wan-AI/Wan2.2-T2V-1.3B-Diffusers',
    label: 'Wan 2.2 1.3B Adapter (Experimental · 24 Steps · 832×480 · 81f)',
    family: 'wan-2.2',
    pipelineClass: 'AutoPipelineForText2Video',
    defaultSteps: 24,
    defaultGuidanceScale: 4.5,
    defaultFlowShift: 3.5,
    defaultFrames: 81,
    defaultFps: 16,
    defaultWidth16x9: 832,
    defaultHeight16x9: 480,
    defaultWidth9x16: 480,
    defaultHeight9x16: 832,
    defaultWidth1x1: 640,
    defaultHeight1x1: 640,
    distilled: false,
    notesVi:
      'Adapter mở rộng cho kiến trúc Wan 2.2 (tự động fallback về Wan 2.1 1.3B nếu checkpoint chưa cache).',
  },
};

export interface HardwareProfile {
  id: HardwareTargetId;
  label: ColabAcceleratorType;
  cliFlag: string;
  torchDtype: 'torch.float16' | 'torch.bfloat16';
  deviceBackend: 'cuda' | 'xla';
  useCpuOffload: boolean;
  vramTotalGb: number;
  computeUnitsPerHour: number;
  notesVi: string;
}

export const HARDWARE_PROFILES: Record<HardwareTargetId, HardwareProfile> = {
  tpu_v5e: {
    id: 'tpu_v5e',
    label: 'TPU v5e-1 (16GB HBM · XLA BF16)',
    cliFlag: '--tpu v5e-1',
    torchDtype: 'torch.bfloat16',
    deviceBackend: 'xla',
    useCpuOffload: false,
    vramTotalGb: 16.0,
    computeUnitsPerHour: 3.15,
    notesVi:
      'Mặc định ưu tiên: TPU v5e-1 dùng torch_xla (xm.xla_device + xm.mark_step) + torch.bfloat16 + khóa khung tĩnh (Static XLA Shape) để chỉ compile graph ở cảnh đầu tiên.',
  },
  t4: {
    id: 't4',
    label: 'Tesla T4 (15GB · FP16)',
    cliFlag: '--gpu T4',
    torchDtype: 'torch.float16', // T4 (SM 7.5) does NOT support native bfloat16
    deviceBackend: 'cuda',
    useCpuOffload: true,
    vramTotalGb: 15.0,
    computeUnitsPerHour: 1.96,
    notesVi:
      'T4 không hỗ trợ BF16 native -> Tự động dùng torch.float16 + enable_model_cpu_offload() + enable_vae_tiling().',
  },
  l4: {
    id: 'l4',
    label: 'NVIDIA L4 (24GB · BF16)',
    cliFlag: '--gpu L4',
    torchDtype: 'torch.bfloat16', // L4 (Ada SM 8.9) supports native bfloat16 & 24GB VRAM
    deviceBackend: 'cuda',
    useCpuOffload: false,
    vramTotalGb: 24.0,
    computeUnitsPerHour: 4.82,
    notesVi:
      'L4 hỗ trợ BF16 native trên 24GB VRAM -> Giữ toàn bộ pipeline trên GPU (không cần CPU offload) + enable_vae_tiling().',
  },
};

export interface ColabRuntimeSession {
  sessionId: string;
  accountEmail: string;
  displayName: string;
  avatarUrl?: string;
  hardwareTarget: HardwareTargetId;
  hardwareLabel: ColabAcceleratorType;
  state: RuntimeSessionState;
  cliBinaryAvailable: boolean;
  adcAuthenticated: boolean;
  workerConnected: boolean;
  workerId: string | null;
  gpuNameReported: string | null;
  vramUsedGb: number | null; // null when no real hardware telemetry yet
  vramTotalGb: number;
  vramIsMeasured: boolean;
  computeUnitsUsed: number;
  computeUnitsLimit: number | null;
  activeJobsCount: number;
  completedJobsCount: number;
  lastHeartbeatAt: string | null;
  startedAt: string | null;
  lastError: string | null;
}

export interface ColabWorkerSnapshot {
  workerId: string;
  sessionId: string;
  accountEmail: string;
  model: string;
  hardwareTarget: HardwareTargetId;
  torchDtype: string;
  capabilities: string[];
  gpuName: string;
  vramUsedGb: number;
  vramTotalGb: number;
  vramIsMeasured: boolean;
  maxConcurrency: number;
  activeRequests: number;
  connectedAt: string;
  lastSeen: string;
  status: 'ONLINE' | 'BUSY' | 'BOOTSTRAPPING' | 'DISCONNECTED';
}

export interface VideoGenerationParams {
  prompt: string;
  negativePrompt: string;
  model?: WanModelId;
  hardwareTarget?: HardwareTargetId;
  presetId: CommercialPresetId;
  resolution: '480p' | '720p';
  aspectRatio: '16:9' | '9:16' | '1:1';
  durationSec: 4 | 5 | 10;
  numFrames?: number;
  fps: 16 | 24;
  inferenceSteps: number;
  guidanceScale: number;
  flowShift?: number;
  cameraMotion: CameraMotionType;
  seed: number;
  enableTeaCache: boolean;
  cpuOffload: boolean;
  lockXlaShape?: boolean;
  vaeTiling?: boolean;
  vaeSlicing?: boolean;
}

export interface FastWanMetrics {
  width: number;
  height: number;
  latentFrames: number;
  estimatedVramGb: number;
  estimatedDurationSec: number;
  isEstimated: boolean;
  torchDtype: string;
  fitsOnTarget: boolean;
  speedupFactor: number;
}

export interface VideoJob {
  id: string;
  sceneIndex?: number;
  batchId?: string;
  prompt: string;
  enhancedPrompt?: string;
  thinkingSummary?: string;
  negativePrompt: string;
  presetId: CommercialPresetId;
  model: WanModelId;
  hardwareTarget: HardwareTargetId;
  resolution: '480p' | '720p';
  aspectRatio: '16:9' | '9:16' | '1:1';
  durationSec: number;
  fps: 16 | 24;
  inferenceSteps: number;
  guidanceScale: number;
  flowShift: number;
  cameraMotion: CameraMotionType;
  seed: number;
  lockXlaShape: boolean;
  vaeTiling: boolean;
  vaeSlicing: boolean;
  status: 'QUEUED' | 'DISPATCHED' | 'DIFFUSING' | 'ENCODING' | 'COMPLETED' | 'FAILED';
  progressPct: number;
  currentStep: number;
  workerId: string;
  accountEmail: string;
  retryCount: number;
  maxRetries: number;
  leaseExpiresAt: string | null;
  isMock: boolean;
  actualInferenceSec?: number | null;
  measuredVramGb?: number | null;
  createdAt: string;
  completedAt?: string;
  videoUrl?: string;
  fileSizeBytes?: number;
  error?: string;
  metrics: FastWanMetrics;
}

// Keep legacy ColabAccount alias for compatibility where needed
export type AccountState = 'READY' | 'ACTIVE' | 'PREWARMING' | 'COOLDOWN';
export interface ColabAccount {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  state: AccountState;
  gpuType: string;
  activeRunSeconds: number;
  cooldownRemainingSeconds: number;
  lastUsedAt: string;
  workerId: string | null;
  vramUsedGb: number;
  vramTotalGb: number;
  completedJobs: number;
  oauthConnected: boolean;
  driveNotebookId?: string;
  warpProxyEnabled: boolean;
}

export const CAMERA_MOTION_CUES: Record<CameraMotionType, string> = {
  static: 'Locked-off tripod shot, stable framing',
  pan_right: 'Smooth cinematic pan right camera movement',
  pan_left: 'Smooth cinematic pan left camera movement',
  tilt_up: 'Slow vertical tilt-up camera movement revealing the scene',
  dolly_in: 'Slow 35mm dolly-in tracking shot pushing toward the subject',
  orbit_360: 'Smooth 360-degree orbital tracking shot around the subject',
  fpv_drone: 'Sweeping FPV aerial drone flight gliding through the scene',
};

export function applyCameraMotionToPrompt(
  prompt: string,
  cameraMotion?: CameraMotionType
): string {
  const trimmed = prompt.trim();
  if (!cameraMotion || cameraMotion === 'static') return trimmed;
  const cue = CAMERA_MOTION_CUES[cameraMotion];
  if (!cue) return trimmed;
  if (trimmed.toLowerCase().includes(cue.slice(0, 14).toLowerCase())) {
    return trimmed;
  }
  return `${cue}, ${trimmed}`;
}

export function computeWanLatentFrames(durationSec: number, fps: number, explicitFrames?: number): number {
  if (explicitFrames && explicitFrames >= 17) {
    const k = Math.max(4, Math.round((explicitFrames - 1) / 4));
    return 4 * k + 1;
  }
  const rawFrames = Math.max(17, Math.round(durationSec * fps));
  const k = Math.max(4, Math.round((rawFrames - 1) / 4));
  return 4 * k + 1;
}

export function calculateFastWanMetrics(params: {
  model?: WanModelId;
  hardwareTarget?: HardwareTargetId;
  resolution: '480p' | '720p';
  aspectRatio: '16:9' | '9:16' | '1:1';
  durationSec: number;
  numFrames?: number;
  fps: 16 | 24;
  inferenceSteps: number;
  enableTeaCache?: boolean;
  cpuOffload?: boolean;
  lockXlaShape?: boolean;
}): FastWanMetrics {
  const modelId: WanModelId = params.model || 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers';
  const adapter = WAN_MODEL_ADAPTERS[modelId] || WAN_MODEL_ADAPTERS['FastVideo/FastWan2.1-T2V-1.3B-Diffusers'];
  const hwId: HardwareTargetId = params.hardwareTarget || 'tpu_v5e';
  const hw = HARDWARE_PROFILES[hwId] || HARDWARE_PROFILES.tpu_v5e;

  let width = adapter.defaultWidth16x9;
  let height = adapter.defaultHeight16x9;

  if (params.aspectRatio === '9:16') {
    width = adapter.defaultWidth9x16;
    height = adapter.defaultHeight9x16;
  } else if (params.aspectRatio === '1:1') {
    width = adapter.defaultWidth1x1;
    height = adapter.defaultHeight1x1;
  }

  if (params.resolution === '720p' && !params.lockXlaShape) {
    if (params.aspectRatio === '16:9') {
      width = 1280;
      height = 720;
    } else if (params.aspectRatio === '9:16') {
      width = 720;
      height = 1280;
    } else {
      width = 960;
      height = 960;
    }
  }

  const latentFrames = params.numFrames
    ? computeWanLatentFrames(params.durationSec, params.fps, params.numFrames)
    : adapter.distilled && params.durationSec <= 4
    ? 61
    : computeWanLatentFrames(params.durationSec, params.fps);

  const pixelFactor = (width * height) / (832 * 480);
  const frameFactor = latentFrames / 81;
  const offloadFactor = hw.useCpuOffload || params.cpuOffload ? 0.85 : 1.0;
  const rawVram = 8.2 * Math.pow(pixelFactor, 0.45) * Math.pow(frameFactor, 0.35) * offloadFactor;
  const estimatedVramGb = Number(Math.min(22.0, Math.max(6.8, rawVram)).toFixed(1));
  const fitsOnTarget = estimatedVramGb <= hw.vramTotalGb - 0.8;

  const stepSec = hwId === 'l4' ? 0.9 : hwId === 'tpu_v5e' ? 1.0 : 1.45;
  const estimatedDurationSec = Math.max(
    4,
    Math.round(params.inferenceSteps * stepSec * frameFactor + 4)
  );
  const speedupFactor = Number((30 / Math.max(1, params.inferenceSteps)).toFixed(1));

  return {
    width,
    height,
    latentFrames,
    estimatedVramGb,
    estimatedDurationSec,
    isEstimated: true,
    torchDtype: hw.torchDtype,
    fitsOnTarget,
    speedupFactor,
  };
}

/**
 * Validates that a Buffer is a genuine, non-empty MP4 binary containing an ISO BMFF `ftyp` box.
 */
export function isValidMp4Buffer(buf: Buffer | null | undefined): boolean {
  if (!buf || buf.length < 256) return false;
  // ISO Base Media File Format (MP4) has 'ftyp' at byte offset 4..8
  const boxType = buf.subarray(4, 8).toString('ascii');
  return boxType === 'ftyp';
}

/**
 * Builds the exact Google Colab CLI (`google-colab-cli`) commands for Linux server orchestration.
 * Strictly favors TPU v5e-1 (`--tpu v5e-1`) unless L4 or T4 is explicitly requested.
 */
export function buildColabCliCommands(options: {
  sessionName: string;
  hardwareTarget?: HardwareTargetId;
  bootstrapScriptPath: string;
}): {
  listSessionsCmd: string[];
  provisionCmd: string[];
  statusCmd: string[];
  execBootstrapCmd: string[];
  stopCmd: string[];
} {
  const session = options.sessionName || 'wan-worker';
  const target = options.hardwareTarget || 'tpu_v5e';
  const hwFlag =
    target === 'l4'
      ? ['--gpu', 'L4']
      : target === 't4'
      ? ['--gpu', 'T4']
      : ['--tpu', 'v5e-1'];

  return {
    listSessionsCmd: ['colab', '--auth=adc', 'sessions'],
    provisionCmd: ['colab', '--auth=adc', 'new', '-s', session, ...hwFlag],
    statusCmd: ['colab', '--auth=adc', 'status', '-s', session],
    execBootstrapCmd: [
      'colab',
      '--auth=adc',
      'exec',
      '-s',
      session,
      '-f',
      options.bootstrapScriptPath,
    ],
    stopCmd: ['colab', '--auth=adc', 'stop', '-s', session],
  };
}

/**
 * Generates the hardware-aware Python bootstrap & worker script (`bootstrap.py`):
 * - TPU v5e-1 (Default): configures PJRT_DEVICE="TPU", torch_xla (xm.xla_device, xm.mark_step, xm.get_memory_info),
 *   torch.bfloat16, static XLA shape lock, and enable_vae_tiling() + enable_vae_slicing()
 * - T4: uses torch.float16 + enable_model_cpu_offload() + enable_vae_tiling()
 * - L4: uses torch.bfloat16 + CUDA + enable_vae_tiling()
 */
export function generateFastWanWorkerScript(options: {
  serverUrl: string;
  workerId: string;
  workerToken: string;
  modelId?: WanModelId;
  hardwareTarget?: HardwareTargetId;
  runtimeType?: 'tpu_v5e' | 'cuda_gpu';
  enableCpuOffload?: boolean;
}): string {
  const wsUrl =
    options.serverUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/api/colab/ws/worker';
  const modelId: WanModelId = options.modelId || 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers';
  const adapter =
    WAN_MODEL_ADAPTERS[modelId] || WAN_MODEL_ADAPTERS['FastVideo/FastWan2.1-T2V-1.3B-Diffusers'];

  const hwTarget: HardwareTargetId =
    options.hardwareTarget || (options.runtimeType === 'cuda_gpu' ? 't4' : 'tpu_v5e');
  const hwProfile = HARDWARE_PROFILES[hwTarget] || HARDWARE_PROFILES.tpu_v5e;

  const hardwareSetupBlock =
    hwTarget === 'tpu_v5e'
      ? `# 1. Thiết lập chuyên biệt torch_xla cho Google Colab TPU v5e-1 (16GB HBM · PJRT BF16)
os.environ.setdefault("PJRT_DEVICE", "TPU")
os.environ.setdefault("XLA_USE_BF16", "1")

IS_TPU_XLA = False
xm = None
try:
    import torch_xla
    import torch_xla.core.xla_model as xm
    import torch_xla.runtime as xr
    device = xm.xla_device()
    IS_TPU_XLA = True
    print(f"[WanWorker] Đã kích hoạt torch_xla trên TPU v5e-1: device={device}, world_size={xr.world_size()}")
except Exception as xla_err:
    print(f"[WanWorker] Cảnh báo khởi tạo torch_xla ({xla_err}), kiểm tra thiết bị dự phòng...")
    device = "tpu" if hasattr(torch, "tpu") else ("cuda" if torch.cuda.is_available() else "cpu")

TORCH_DTYPE = torch.bfloat16
pipe = WanPipeline.from_pretrained(MODEL_ID, torch_dtype=TORCH_DTYPE)
pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config, flow_shift=DEFAULT_FLOW_SHIFT)
pipe.to(device)
pipe.enable_vae_tiling()
if hasattr(pipe, "enable_vae_slicing"):
    pipe.enable_vae_slicing()`
      : hwTarget === 'l4'
      ? `# 1. Thiết lập thiết bị NVIDIA L4 (24GB VRAM · Native bfloat16)
IS_TPU_XLA = False
xm = None
assert torch.cuda.is_available(), "Yêu cầu CUDA GPU (NVIDIA L4)"
device = "cuda"
TORCH_DTYPE = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
pipe = WanPipeline.from_pretrained(MODEL_ID, torch_dtype=TORCH_DTYPE)
pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config, flow_shift=DEFAULT_FLOW_SHIFT)
pipe.to(device)
pipe.enable_vae_tiling()
if hasattr(pipe, "enable_vae_slicing"):
    pipe.enable_vae_slicing()`
      : `# 1. Thiết lập thiết bị NVIDIA Tesla T4 (15GB VRAM · Turing SM 7.5)
# Lưu ý quan trọng: T4 KHÔNG hỗ trợ bfloat16 native -> Bắt buộc dùng torch.float16 + enable_model_cpu_offload()
IS_TPU_XLA = False
xm = None
assert torch.cuda.is_available(), "Yêu cầu CUDA GPU (Tesla T4)"
device = "cuda"
TORCH_DTYPE = torch.float16
pipe = WanPipeline.from_pretrained(MODEL_ID, torch_dtype=TORCH_DTYPE)
pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config, flow_shift=DEFAULT_FLOW_SHIFT)
pipe.enable_model_cpu_offload()
pipe.enable_vae_tiling()
if hasattr(pipe, "enable_vae_slicing"):
    pipe.enable_vae_slicing()`;

  return `#!/usr/bin/env python3
"""
Wan Orchestrator Production Worker — bootstrap.py (${hwProfile.label})
Model Adapter: ${modelId} (Default: ${adapter.defaultSteps} steps, ${adapter.defaultWidth16x9}x${adapter.defaultHeight16x9}, ${adapter.defaultFrames} frames)
Precision: ${hwProfile.torchDtype} | Backend: ${hwProfile.deviceBackend.toUpperCase()}
Kết nối WebSocket xác thực Bearer Token: ${wsUrl}
"""
import asyncio
import base64
import json
import os
import time
import torch
import websockets
from diffusers import WanPipeline, UniPCMultistepScheduler
from diffusers.utils import export_to_video

SERVER_WS_URL = "${wsUrl}"
WORKER_ID = "${options.workerId}"
WORKER_TOKEN = "${options.workerToken}"
MODEL_ID = "${modelId}"
HARDWARE_TARGET = "${hwTarget}"
DEFAULT_STEPS = ${adapter.defaultSteps}
DEFAULT_CFG = ${adapter.defaultGuidanceScale}
DEFAULT_FLOW_SHIFT = ${adapter.defaultFlowShift}
DEFAULT_WIDTH = ${adapter.defaultWidth16x9}
DEFAULT_HEIGHT = ${adapter.defaultHeight16x9}
DEFAULT_FRAMES = ${adapter.defaultFrames}
DEFAULT_FPS = ${adapter.defaultFps}

print(f"[WanWorker] Đang khởi tạo {MODEL_ID} trên {HARDWARE_TARGET} (${hwProfile.torchDtype})...")
${hardwareSetupBlock}

def measure_hardware():
    if IS_TPU_XLA and xm is not None:
        try:
            mem_info = xm.get_memory_info(device)
            used_gb = round(mem_info.get("bytes_used", 0) / (1024**3), 2)
            total_gb = round(mem_info.get("bytes_limit", 16 * (1024**3)) / (1024**3), 2)
            return "Colab TPU v5e-1 (torch_xla PJRT)", used_gb, total_gb, True
        except Exception:
            return "Colab TPU v5e-1 (torch_xla PJRT)", 0.0, 16.0, False
    if torch.cuda.is_available():
        gpu_name = torch.cuda.get_device_name(0)
        total_gb = round(torch.cuda.get_device_properties(0).total_memory / (1024**3), 2)
        used_gb = round(torch.cuda.max_memory_allocated(0) / (1024**3), 2)
        if used_gb < 0.5:
            used_gb = round(torch.cuda.memory_reserved(0) / (1024**3), 2)
        return gpu_name, used_gb, total_gb, True
    return "${hwProfile.label}", 0.0, ${hwProfile.vramTotalGb}, False

async def heartbeat_loop(ws):
    while True:
        await asyncio.sleep(15)
        gpu_name, used_gb, total_gb, is_measured = measure_hardware()
        await ws.send(json.dumps({
            "type": "heartbeat",
            "worker_id": WORKER_ID,
            "gpu_name": gpu_name,
            "vram_used_gb": used_gb,
            "vram_total_gb": total_gb,
            "vram_is_measured": is_measured,
        }))

async def run_worker():
    headers = {"Authorization": f"Bearer {WORKER_TOKEN}"}
    loop = asyncio.get_running_loop()
    async for ws in websockets.connect(
        SERVER_WS_URL,
        additional_headers=headers,
        ping_interval=20,
        max_size=100 * 1024 * 1024,
    ):
        hb_task = None
        try:
            gpu_name, used_gb, total_gb, is_measured = measure_hardware()
            reg = {
                "worker_id": WORKER_ID,
                "token": WORKER_TOKEN,
                "model": MODEL_ID,
                "hardware_target": HARDWARE_TARGET,
                "torch_dtype": "${hwProfile.torchDtype}",
                "gpu_name": gpu_name,
                "vram_used_gb": used_gb,
                "vram_total_gb": total_gb,
                "vram_is_measured": is_measured,
                "capabilities": [
                    "t2v",
                    "torch_xla",
                    "vae_tiling",
                    "vae_slicing",
                    "${hwProfile.torchDtype.replace('torch.', '')}",
                    "flow_shift",
                    "seed_control",
                    "camera_motion",
                ],
                "max_concurrency": 1,
            }
            await ws.send(json.dumps(reg))
            print(f"[WanWorker] READY trên Hub: {WORKER_ID} | Accelerator: {gpu_name} ({used_gb}/{total_gb} GB)")
            hb_task = asyncio.create_task(heartbeat_loop(ws))

            async for raw_msg in ws:
                event = json.loads(raw_msg)
                if event.get("type") == "ping":
                    await ws.send(json.dumps({"type": "pong"}))
                    continue

                if event.get("type") == "video_generate":
                    req_id = event["request_id"]
                    payload = event.get("payload", {})
                    t0 = time.time()
                    try:
                        prompt = payload.get("prompt", "")
                        neg_prompt = payload.get(
                            "negative_prompt",
                            "Bright tones, overexposed, static, blurred details, subtitles, worst quality, low quality"
                        )
                        steps = int(payload.get("inference_steps", DEFAULT_STEPS))
                        cfg = float(payload.get("guidance_scale", DEFAULT_CFG))
                        flow_shift = float(payload.get("flow_shift", DEFAULT_FLOW_SHIFT))
                        seed = int(payload.get("seed", 42))
                        lock_xla = bool(payload.get("lock_xla_shape", IS_TPU_XLA))
                        width = DEFAULT_WIDTH if lock_xla else int(payload.get("width", DEFAULT_WIDTH))
                        height = DEFAULT_HEIGHT if lock_xla else int(payload.get("height", DEFAULT_HEIGHT))
                        num_frames = DEFAULT_FRAMES if lock_xla else int(payload.get("num_frames", DEFAULT_FRAMES))
                        fps = DEFAULT_FPS if lock_xla else int(payload.get("fps", DEFAULT_FPS))

                        pipe.scheduler = UniPCMultistepScheduler.from_config(
                            pipe.scheduler.config, flow_shift=flow_shift
                        )
                        generator = torch.Generator(device="cpu").manual_seed(seed)

                        def step_callback(pipe_obj, step_idx, timestep, callback_kwargs):
                            if IS_TPU_XLA and xm is not None:
                                xm.mark_step()
                            asyncio.run_coroutine_threadsafe(
                                ws.send(json.dumps({
                                    "type": "job_progress",
                                    "request_id": req_id,
                                    "step": step_idx + 1,
                                    "total_steps": steps,
                                })),
                                loop,
                            )
                            return callback_kwargs

                        await ws.send(json.dumps({
                            "type": "job_progress",
                            "request_id": req_id,
                            "step": 1,
                            "total_steps": steps,
                        }))

                        output = pipe(
                            prompt=prompt,
                            negative_prompt=neg_prompt,
                            height=height,
                            width=width,
                            num_frames=num_frames,
                            num_inference_steps=steps,
                            guidance_scale=cfg,
                            generator=generator,
                            callback_on_step_end=step_callback,
                        ).frames[0]

                        if IS_TPU_XLA and xm is not None:
                            xm.mark_step()

                        out_path = f"/tmp/{req_id}.mp4"
                        export_to_video(output, out_path, fps=fps)
                        elapsed_sec = round(time.time() - t0, 2)
                        _, peak_vram_gb, _, measured = measure_hardware()

                        with open(out_path, "rb") as f:
                            mp4_b64 = base64.b64encode(f.read()).decode("ascii")

                        await ws.send(json.dumps({
                            "type": "job_result",
                            "request_id": req_id,
                            "mime": "video/mp4",
                            "video_base64": mp4_b64,
                            "actual_inference_sec": elapsed_sec,
                            "measured_vram_gb": peak_vram_gb if measured else None,
                            "done": True,
                        }))
                        print(f"[WanWorker] Hoàn tất {req_id}.mp4 trong {elapsed_sec}s (HBM/VRAM: {peak_vram_gb}GB)")
                    except Exception as job_err:
                        await ws.send(json.dumps({
                            "type": "job_error",
                            "request_id": req_id,
                            "error": str(job_err),
                        }))
                        print(f"[WanWorker] Lỗi job {req_id}: {job_err}")
        except Exception as exc:
            print(f"[WanWorker] Mất kết nối, thử lại sau 3s: {exc}")
            if hb_task:
                hb_task.cancel()
            await asyncio.sleep(3)

if __name__ == "__main__":
    asyncio.run(run_worker())
`;
}

export function generateColabNotebookJson(options: {
  serverUrl: string;
  workerId: string;
  workerToken: string;
  modelId?: WanModelId;
  hardwareTarget?: HardwareTargetId;
  runtimeType?: 'tpu_v5e' | 'cuda_gpu';
}): string {
  const modelId: WanModelId = options.modelId || 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers';
  const hwTarget: HardwareTargetId =
    options.hardwareTarget || (options.runtimeType === 'cuda_gpu' ? 't4' : 'tpu_v5e');
  const hwProfile = HARDWARE_PROFILES[hwTarget] || HARDWARE_PROFILES.tpu_v5e;

  const script = generateFastWanWorkerScript({
    ...options,
    modelId,
    hardwareTarget: hwTarget,
  });

  const notebook = {
    nbformat: 4,
    nbformat_minor: 0,
    metadata: {
      colab: {
        name: `Wan_Worker_${hwTarget.toUpperCase()}_${options.workerId}.ipynb`,
        provenance: [],
        machine_shape: 'hm',
        accelerator: hwTarget === 'tpu_v5e' ? 'TPU_V5E' : 'GPU',
      },
      kernelspec: {
        name: 'python3',
        display_name: 'Python 3',
      },
    },
    cells: [
      {
        cell_type: 'markdown',
        metadata: {},
        source: [
          `# Wan Video Worker (${hwProfile.label})\n`,
          `- **Model Adapter**: \`${modelId}\`\n`,
          `- **Cấu hình phần cứng**: \`${hwProfile.torchDtype}\` (${hwProfile.notesVi})\n`,
        ],
      },
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: [
          `# Cell 1: Cài đặt thư viện\n`,
          `!pip install -q -U diffusers transformers accelerate sentencepiece ftfy imageio imageio-ffmpeg websockets\n`,
        ],
      },
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: script.split('\n').map((line) => line + '\n'),
      },
    ],
  };

  return JSON.stringify(notebook, null, 2);
}
