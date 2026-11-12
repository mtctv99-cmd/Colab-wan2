export type AccountState = 'READY' | 'ACTIVE' | 'PREWARMING' | 'COOLDOWN';

export type WanModelId =
  | 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers'
  | 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers';

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
  | 'TPU v5e-1 (16GB HBM)'
  | 'Tesla T4 (15GB)'
  | 'NVIDIA L4 (24GB)';

export interface ColabAccount {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  state: AccountState;
  gpuType: ColabAcceleratorType;
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

export interface ColabWorkerSnapshot {
  workerId: string;
  accountId: string;
  accountEmail: string;
  model: string;
  capabilities: string[];
  gpuName: string;
  vramUsedGb: number;
  vramTotalGb: number;
  maxConcurrency: number;
  activeRequests: number;
  connectedAt: string;
  lastSeen: string;
  status: 'ONLINE' | 'BUSY' | 'PREWARMING' | 'DISCONNECTED';
  tunnelType: 'inbound_ws' | 'cloudflare_warp' | 'colab_proxy';
}

export interface VideoGenerationParams {
  prompt: string;
  negativePrompt: string;
  presetId: CommercialPresetId;
  resolution: '480p' | '720p';
  aspectRatio: '16:9' | '9:16' | '1:1';
  durationSec: 5 | 10;
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
  sourceImageUrl?: string;
}

export interface FastWanMetrics {
  width: number;
  height: number;
  latentFrames: number;
  estimatedVramGb: number;
  estimatedDurationSec: number;
  fitsOnFreeT4: boolean;
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
  model: string;
  resolution: '480p' | '720p';
  aspectRatio: '16:9' | '9:16' | '1:1';
  durationSec: 5 | 10;
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
  createdAt: string;
  completedAt?: string;
  videoUrl?: string;
  fileSizeBytes?: number;
  error?: string;
  posterUrl: string;
  videoSceneType: 'cyber_rain' | 'aerial_iceland' | 'mech_atelier' | 'ocean_biolum';
  metrics: FastWanMetrics;
  driveFileId?: string;
}

// Constants modeled directly after Hub_Provider/scripts/colab_rotator.py
export const RUN_DURATION_SEC = 3 * 3600; // 3 hours (10,800s)
export const PREWARM_THRESHOLD_SEC = 155 * 60; // 2h 35m (9,300s)
export const COOLDOWN_DURATION_SEC = 16 * 3600; // 16 hours (57,600s)

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

export function computeWanLatentFrames(durationSec: number, fps: number): number {
  const rawFrames = Math.max(17, Math.round(durationSec * fps));
  const k = Math.max(4, Math.round((rawFrames - 1) / 4));
  return 4 * k + 1;
}

export function calculateFastWanMetrics(
  params: Pick<
    VideoGenerationParams,
    | 'resolution'
    | 'aspectRatio'
    | 'durationSec'
    | 'fps'
    | 'inferenceSteps'
    | 'enableTeaCache'
    | 'cpuOffload'
    | 'lockXlaShape'
  >
): FastWanMetrics {
  // When lockXlaShape is enabled for TPU v5e-1, keep 832x480 and 81 frames (16fps) fixed
  if (params.lockXlaShape) {
    const inferenceSteps = Math.max(1, params.inferenceSteps);
    const estimatedDurationSec = Math.max(4, Math.round(inferenceSteps * 0.9 + 3));
    const speedupFactor = Number((50 / Math.max(3, inferenceSteps)).toFixed(1));
    return {
      width: 832,
      height: 480,
      latentFrames: 81,
      estimatedVramGb: 8.2,
      estimatedDurationSec,
      fitsOnFreeT4: true,
      speedupFactor,
    };
  }

  let width = 832;
  let height = 480;

  if (params.resolution === '720p') {
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
  } else {
    if (params.aspectRatio === '16:9') {
      width = 832;
      height = 480;
    } else if (params.aspectRatio === '9:16') {
      width = 480;
      height = 832;
    } else {
      width = 640;
      height = 640;
    }
  }

  const latentFrames = computeWanLatentFrames(params.durationSec, params.fps);
  const pixelFactor = (width * height) / (832 * 480);
  const frameFactor = latentFrames / 81;
  const rawVram = 8.2 * Math.pow(pixelFactor, 0.45) * Math.pow(frameFactor, 0.35);
  const estimatedVramGb = Number(Math.min(15.6, Math.max(7.6, rawVram)).toFixed(1));
  const fitsOnFreeT4 = estimatedVramGb <= 15.8;

  const baseStepSec = params.resolution === '720p' ? 2.4 : 1.1;
  const teaCacheMultiplier = params.enableTeaCache ? 0.72 : 1.0;
  const estimatedDurationSec = Math.max(
    4,
    Math.round(params.inferenceSteps * baseStepSec * frameFactor * teaCacheMultiplier + 3)
  );
  const speedupFactor = Number((50 / Math.max(3, params.inferenceSteps)).toFixed(1));

  return {
    width,
    height,
    latentFrames,
    estimatedVramGb,
    estimatedDurationSec,
    fitsOnFreeT4,
    speedupFactor,
  };
}

export interface LifecycleEvaluation {
  shouldPrewarmNext: boolean;
  shouldRotateNow: boolean;
  remainingRunSec: number;
  prewarmTriggerInSec: number;
  healthLabel: 'OPTIMAL' | 'PREWARM_WINDOW' | 'ROTATE_DUE' | 'COOLING_DOWN' | 'STANDBY';
}

export function evaluateAccountLifecycle(account: ColabAccount): LifecycleEvaluation {
  if (account.state === 'COOLDOWN') {
    return {
      shouldPrewarmNext: false,
      shouldRotateNow: false,
      remainingRunSec: 0,
      prewarmTriggerInSec: 0,
      healthLabel: 'COOLING_DOWN',
    };
  }

  if (account.state === 'READY' || account.state === 'PREWARMING') {
    return {
      shouldPrewarmNext: false,
      shouldRotateNow: false,
      remainingRunSec: RUN_DURATION_SEC - account.activeRunSeconds,
      prewarmTriggerInSec: Math.max(0, PREWARM_THRESHOLD_SEC - account.activeRunSeconds),
      healthLabel: 'STANDBY',
    };
  }

  const remainingRunSec = Math.max(0, RUN_DURATION_SEC - account.activeRunSeconds);
  const prewarmTriggerInSec = Math.max(0, PREWARM_THRESHOLD_SEC - account.activeRunSeconds);
  const shouldRotateNow = account.activeRunSeconds >= RUN_DURATION_SEC;
  const shouldPrewarmNext =
    !shouldRotateNow && account.activeRunSeconds >= PREWARM_THRESHOLD_SEC;

  let healthLabel: LifecycleEvaluation['healthLabel'] = 'OPTIMAL';
  if (shouldRotateNow) {
    healthLabel = 'ROTATE_DUE';
  } else if (shouldPrewarmNext) {
    healthLabel = 'PREWARM_WINDOW';
  }

  return {
    shouldPrewarmNext,
    shouldRotateNow,
    remainingRunSec,
    prewarmTriggerInSec,
    healthLabel,
  };
}

export interface RotationResult {
  updatedAccounts: ColabAccount[];
  promotedAccount: ColabAccount | null;
  retiredAccount: ColabAccount | null;
}

export function rotateColabPool(accounts: ColabAccount[]): RotationResult {
  const cloned: ColabAccount[] = accounts.map((a) => ({ ...a }));
  const currentActive = cloned.find((a) => a.state === 'ACTIVE') || null;

  const candidate =
    cloned.find((a) => a.state === 'PREWARMING') ||
    cloned
      .filter((a) => a.state === 'READY')
      .sort((a, b) => new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime())[0] ||
    null;

  if (!candidate) {
    return {
      updatedAccounts: cloned,
      promotedAccount: null,
      retiredAccount: null,
    };
  }

  if (currentActive && currentActive.id !== candidate.id) {
    currentActive.state = 'COOLDOWN';
    currentActive.cooldownRemainingSeconds = COOLDOWN_DURATION_SEC;
    currentActive.activeRunSeconds = 0;
    currentActive.workerId = null;
    currentActive.vramUsedGb = 0;
  }

  candidate.state = 'ACTIVE';
  candidate.activeRunSeconds = 0;
  candidate.cooldownRemainingSeconds = 0;
  candidate.lastUsedAt = new Date().toISOString();
  candidate.workerId = candidate.workerId || `colab-tpu-${candidate.id.slice(-4)}`;
  candidate.vramUsedGb = 8.2;

  return {
    updatedAccounts: cloned,
    promotedAccount: candidate,
    retiredAccount: currentActive,
  };
}

export function generateFastWanWorkerScript(options: {
  serverUrl: string;
  workerId: string;
  workerToken: string;
  modelId?: WanModelId;
  runtimeType?: 'tpu_v5e' | 'cuda_gpu';
  enableCpuOffload?: boolean;
}): string {
  const wsUrl =
    options.serverUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/api/colab/ws/worker';
  const modelId = options.modelId || 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers';
  const defaultSteps = modelId === 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers' ? 4 : 30;
  const runtimeType = options.runtimeType || 'tpu_v5e';

  const deviceSetupCode =
    runtimeType === 'tpu_v5e'
      ? `# 1. Thiết lập thiết bị Google Colab TPU v5e-1 (16GB HBM ~ tốn 8.2GB)
try:
    import torch_xla.core.xla_model as xm
    device = xm.xla_device()
except Exception:
    device = "tpu" if hasattr(torch, "tpu") else ("cuda" if torch.cuda.is_available() else "cpu")

# 2. Tải model Wan 2.1 1.3B định dạng bfloat16 & bật enable_vae_tiling() + enable_vae_slicing()
pipe = WanPipeline.from_pretrained(MODEL_ID, torch_dtype=torch.bfloat16)
pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config, flow_shift=3.0)
pipe.to(device)
pipe.enable_vae_tiling()
if hasattr(pipe, "enable_vae_slicing"):
    pipe.enable_vae_slicing()`
      : `# 1. Thiết lập thiết bị GPU (T4 / L4)
device = "cuda" if torch.cuda.is_available() else "cpu"
pipe = WanPipeline.from_pretrained(MODEL_ID, torch_dtype=torch.bfloat16)
pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config, flow_shift=3.0)
pipe.enable_vae_tiling()
if hasattr(pipe, "enable_vae_slicing"):
    pipe.enable_vae_slicing()
${options.enableCpuOffload ? 'pipe.enable_model_cpu_offload()' : 'pipe.to(device)'}`;

  return `#!/usr/bin/env python3
"""
Wan 2.1 1.3B Production Inbound Worker cho Colab TPU v5e-1 (16GB HBM) / GPU
Model: ${modelId} (Chuẩn 832x480, 81 frames ~ 5s @ 16fps, ~8.2GB HBM)
Kết nối ngược về: ${wsUrl}
Hỗ trợ đầy đủ: prompt, negative_prompt, num_inference_steps, guidance_scale,
flow_shift, seed, lock_xla_shape (832x480x81), vae_tiling, vae_slicing, step callback.
"""
import asyncio
import base64
import json
import torch
import websockets
from diffusers import WanPipeline, UniPCMultistepScheduler
from diffusers.utils import export_to_video

SERVER_WS_URL = "${wsUrl}"
WORKER_ID = "${options.workerId}"
WORKER_TOKEN = "${options.workerToken}"
MODEL_ID = "${modelId}"
DEFAULT_STEPS = ${defaultSteps}

print(f"[WanWorker] Đang nạp {MODEL_ID} (bfloat16 + enable_vae_tiling)...")
${deviceSetupCode}

# Khóa cố định kích thước 832x480, 81 frames (16fps) để TPU v5e-1 chỉ compile XLA graph 1 lần ở cảnh đầu tiên
STATIC_WIDTH = 832
STATIC_HEIGHT = 480
STATIC_FRAMES = 81
STATIC_FPS = 16

async def run_worker():
    headers = {"Authorization": f"Bearer {WORKER_TOKEN}"}
    loop = asyncio.get_running_loop()
    async for ws in websockets.connect(
        SERVER_WS_URL,
        additional_headers=headers,
        ping_interval=20,
        max_size=100 * 1024 * 1024,
    ):
        try:
            reg = {
                "worker_id": WORKER_ID,
                "model": MODEL_ID,
                "models": [
                    "FastVideo/FastWan2.1-T2V-1.3B-Diffusers",
                    "Wan-AI/Wan2.1-T2V-1.3B-Diffusers",
                ],
                "gpu_name": "${runtimeType === 'tpu_v5e' ? 'Colab TPU v5e-1 (16GB HBM)' : 'NVIDIA Tesla T4 (15GB)'}",
                "vram_used_gb": 8.2,
                "vram_total_gb": ${runtimeType === 'tpu_v5e' ? '16.0' : '15.0'},
                "capabilities": [
                    "t2v",
                    "vae_tiling",
                    "vae_slicing",
                    "bfloat16",
                    "flow_shift",
                    "seed_control",
                    "camera_motion",
                    "xla_static_832x480",
                    "batch_scenes",
                ],
                "max_concurrency": 1,
                "token": WORKER_TOKEN,
            }
            await ws.send(json.dumps(reg))
            print(f"[WanWorker] Đã kết nối Hub: {WORKER_ID} ({MODEL_ID})")

            async for raw_msg in ws:
                event = json.loads(raw_msg)
                if event.get("type") == "ping":
                    await ws.send(json.dumps({"type": "pong"}))
                    continue

                if event.get("type") == "video_generate":
                    req_id = event["request_id"]
                    payload = event.get("payload", {})
                    try:
                        prompt = payload.get("prompt", "")
                        neg_prompt = payload.get(
                            "negative_prompt",
                            "Bright tones, overexposed, static, blurred details, subtitles, worst quality, low quality"
                        )
                        steps = int(payload.get("inference_steps", DEFAULT_STEPS))
                        cfg = float(payload.get("guidance_scale", 5.0))
                        flow_shift = float(payload.get("flow_shift", 3.0))
                        seed = int(payload.get("seed", 42))
                        lock_xla = bool(payload.get("lock_xla_shape", True))

                        width = STATIC_WIDTH if lock_xla else int(payload.get("width", STATIC_WIDTH))
                        height = STATIC_HEIGHT if lock_xla else int(payload.get("height", STATIC_HEIGHT))
                        num_frames = STATIC_FRAMES if lock_xla else int(payload.get("num_frames", STATIC_FRAMES))
                        fps = STATIC_FPS if lock_xla else int(payload.get("fps", STATIC_FPS))

                        pipe.scheduler = UniPCMultistepScheduler.from_config(
                            pipe.scheduler.config, flow_shift=flow_shift
                        )
                        generator = torch.Generator(device="cpu").manual_seed(seed)

                        def step_callback(pipe_obj, step_idx, timestep, callback_kwargs):
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

                        out_path = f"/tmp/{req_id}.mp4"
                        export_to_video(output, out_path, fps=fps)
                        with open(out_path, "rb") as f:
                            mp4_b64 = base64.b64encode(f.read()).decode("ascii")

                        await ws.send(json.dumps({
                            "type": "job_result",
                            "request_id": req_id,
                            "mime": "video/mp4",
                            "video_base64": mp4_b64,
                            "done": True,
                        }))
                        print(f"[WanWorker] Đã xuất xong {req_id}.mp4 ({width}x{height}, {num_frames} frames)!")
                    except Exception as job_err:
                        await ws.send(json.dumps({
                            "type": "job_error",
                            "request_id": req_id,
                            "error": str(job_err),
                        }))
                        print(f"[WanWorker] Lỗi xử lý job {req_id}: {job_err}")
        except Exception as exc:
            print(f"[WanWorker] Kết nối lại sau lỗi: {exc}")
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
  runtimeType?: 'tpu_v5e' | 'cuda_gpu';
}): string {
  const modelId = options.modelId || 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers';
  const runtimeType = options.runtimeType || 'tpu_v5e';
  const script = generateFastWanWorkerScript({
    ...options,
    modelId,
    runtimeType,
    enableCpuOffload: runtimeType !== 'tpu_v5e',
  });

  const notebook = {
    nbformat: 4,
    nbformat_minor: 0,
    metadata: {
      colab: {
        name: `Wan2.1_1.3B_TPU_v5e_Worker_${options.workerId}.ipynb`,
        provenance: [],
        machine_shape: 'hm',
        accelerator: runtimeType === 'tpu_v5e' ? 'TPU_V5E' : 'GPU',
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
          `# Wan 2.1 1.3B Worker trên Google Colab TPU v5e-1 (16GB HBM)\n`,
          `- **Model đang chọn**: \`${modelId}\` (~8.2GB / 16GB HBM)\n`,
          `- **Thiết lập Colab**: Vào **Runtime -> Change runtime type -> chọn \`v5e-1 TPU\`**, sau đó bấm **Run all**.\n`,
          `- **Tối ưu TPU v5e-1**: Dùng \`torch.bfloat16\`, bật \`pipe.enable_vae_tiling()\` + \`pipe.enable_vae_slicing()\`, \`UniPCMultistepScheduler(flow_shift=3.0)\` và giữ cố định \`832x480, num_frames=81, fps=16\` để chỉ compile XLA graph 1 lần duy nhất.`,
        ],
      },
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: [
          `# Cell 1: Cài đặt thư viện chuẩn cho Wan 2.1 1.3B & WebSocket Hub\n`,
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
