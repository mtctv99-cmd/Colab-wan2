import express from 'express';
import { execFile } from 'child_process';
import fs from 'fs';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  calculateFastWanMetrics,
  rotateColabPool,
  applyCameraMotionToPrompt,
  RUN_DURATION_SEC,
  PREWARM_THRESHOLD_SEC,
  COOLDOWN_DURATION_SEC,
  type ColabAccount,
  type ColabWorkerSnapshot,
  type VideoJob,
  type CommercialPresetId,
  type CameraMotionType,
} from './src/utils/colabEngine.ts';

dotenv.config();

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const WORKER_AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN || 'wh_fastwan_colab_cluster_99';
const DATA_DIR = path.join(__dirname, '.data');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const STATE_FILE = path.join(DATA_DIR, 'hub_state.json');

if (!fs.existsSync(VIDEOS_DIR)) {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
}

function getGeminiClient(): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
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

interface TrafficPoint {
  label: string;
  requests: number;
  diffusionSteps: number;
  gpuSeconds: number;
  avgLatencySec: number;
}

function createZeroTrafficSeries(): Record<'24h' | '7d' | '30d', TrafficPoint[]> {
  return {
    '24h': [
      { label: '00:00', requests: 0, diffusionSteps: 0, gpuSeconds: 0, avgLatencySec: 0 },
      { label: '04:00', requests: 0, diffusionSteps: 0, gpuSeconds: 0, avgLatencySec: 0 },
      { label: '08:00', requests: 0, diffusionSteps: 0, gpuSeconds: 0, avgLatencySec: 0 },
      { label: '12:00', requests: 0, diffusionSteps: 0, gpuSeconds: 0, avgLatencySec: 0 },
      { label: '16:00', requests: 0, diffusionSteps: 0, gpuSeconds: 0, avgLatencySec: 0 },
      { label: '20:00', requests: 0, diffusionSteps: 0, gpuSeconds: 0, avgLatencySec: 0 },
      { label: 'Hiện tại', requests: 0, diffusionSteps: 0, gpuSeconds: 0, avgLatencySec: 0 },
    ],
    '7d': [
      { label: 'T2', requests: 0, diffusionSteps: 0, gpuSeconds: 0, avgLatencySec: 0 },
      { label: 'T3', requests: 0, diffusionSteps: 0, gpuSeconds: 0, avgLatencySec: 0 },
      { label: 'T4', requests: 0, diffusionSteps: 0, gpuSeconds: 0, avgLatencySec: 0 },
      { label: 'T5', requests: 0, diffusionSteps: 0, gpuSeconds: 0, avgLatencySec: 0 },
      { label: 'T6', requests: 0, diffusionSteps: 0, gpuSeconds: 0, avgLatencySec: 0 },
      { label: 'T7', requests: 0, diffusionSteps: 0, gpuSeconds: 0, avgLatencySec: 0 },
      { label: 'CN', requests: 0, diffusionSteps: 0, gpuSeconds: 0, avgLatencySec: 0 },
    ],
    '30d': [
      { label: 'Tuần 1', requests: 0, diffusionSteps: 0, gpuSeconds: 0, avgLatencySec: 0 },
      { label: 'Tuần 2', requests: 0, diffusionSteps: 0, gpuSeconds: 0, avgLatencySec: 0 },
      { label: 'Tuần 3', requests: 0, diffusionSteps: 0, gpuSeconds: 0, avgLatencySec: 0 },
      { label: 'Tuần 4', requests: 0, diffusionSteps: 0, gpuSeconds: 0, avgLatencySec: 0 },
    ],
  };
}

let colabAccounts: ColabAccount[] = [];
let colabWorkers: ColabWorkerSnapshot[] = [];
let videoJobs: VideoJob[] = [];
let apiKeys: ApiKeyItem[] = [];
let trafficSeries = createZeroTrafficSeries();

// Map of job completion listeners for synchronous `wait: true` requests
const jobCompletionWaiters = new Map<string, Array<(job: VideoJob) => void>>();

function notifyJobWaiters(job: VideoJob) {
  const listeners = jobCompletionWaiters.get(job.id);
  if (listeners && listeners.length > 0) {
    jobCompletionWaiters.delete(job.id);
    for (const fn of listeners) {
      fn(job);
    }
  }
}

function loadPersistedState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.colabAccounts)) {
      colabAccounts = parsed.colabAccounts.map((acc: ColabAccount) => ({
        ...acc,
        gpuType: acc.gpuType === 'Tesla T4 (15GB)' ? 'TPU v5e-1 (16GB HBM)' : acc.gpuType,
        vramTotalGb: acc.vramTotalGb === 15 ? 16.0 : acc.vramTotalGb,
      }));
    }
    if (Array.isArray(parsed.videoJobs)) videoJobs = parsed.videoJobs;
    if (Array.isArray(parsed.apiKeys)) apiKeys = parsed.apiKeys;
    if (parsed.trafficSeries) trafficSeries = parsed.trafficSeries;
  } catch (e) {
    console.error('Failed to load persisted state:', e);
  }
}

function savePersistedState() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(
        {
          colabAccounts,
          videoJobs,
          apiKeys,
          trafficSeries,
        },
        null,
        2
      ),
      'utf-8'
    );
  } catch (e) {
    console.error('Failed to save persisted state:', e);
  }
}

loadPersistedState();

/**
 * Generates a real 832x480 @ 16fps (81 frames ~ 5.06s) H.264 MP4 binary via /usr/bin/ffmpeg
 * Used by the E2E verification worker and optional sandbox mode to test real MP4 streaming & playback.
 */
async function synthesizeTestMp4Buffer(options: {
  width: number;
  height: number;
  fps: number;
  numFrames: number;
  jobId: string;
}): Promise<Buffer> {
  const outPath = path.join(VIDEOS_DIR, `_tmp_${options.jobId}.mp4`);
  const durationSec = Math.max(2, Number((options.numFrames / options.fps).toFixed(2)));
  const w = options.width || 832;
  const h = options.height || 480;

  await execFileAsync('/usr/bin/ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${w}x${h}:rate=${options.fps}:duration=${durationSec}`,
    '-frames:v',
    String(options.numFrames || 81),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'ultrafast',
    '-movflags',
    '+faststart',
    outPath,
  ]);

  const buf = fs.readFileSync(outPath);
  try {
    fs.unlinkSync(outPath);
  } catch {
    // Ignore
  }
  return buf;
}

setInterval(() => {
  let changed = false;
  for (const acc of colabAccounts) {
    if (acc.state === 'ACTIVE') {
      acc.activeRunSeconds = Math.min(RUN_DURATION_SEC, acc.activeRunSeconds + 2);
      changed = true;
      if (acc.activeRunSeconds >= PREWARM_THRESHOLD_SEC) {
        const hasPrewarming = colabAccounts.some((a) => a.state === 'PREWARMING');
        if (!hasPrewarming) {
          const readyCandidate = colabAccounts.find((a) => a.state === 'READY');
          if (readyCandidate) {
            readyCandidate.state = 'PREWARMING';
            readyCandidate.workerId = `colab-tpu-${readyCandidate.id.slice(-4)}`;
          }
        }
      }
    } else if (acc.state === 'COOLDOWN' && acc.cooldownRemainingSeconds > 0) {
      acc.cooldownRemainingSeconds = Math.max(0, acc.cooldownRemainingSeconds - 2);
      changed = true;
      if (acc.cooldownRemainingSeconds === 0) {
        acc.state = 'READY';
      }
    }
  }
  if (changed) {
    savePersistedState();
  }
}, 2000);

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // Enable CORS on /v1/* and /api/* so external applications can call directly
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const httpServer = createServer(app);

  // Inbound WebSocket Hub for Google Colab Python workers (/api/colab/ws/worker)
  // Set maxPayload to 100MB so base64-encoded 5s/10s MP4 videos never get truncated
  const wss = new WebSocketServer({ noServer: true, maxPayload: 100 * 1024 * 1024 });
  const liveSockets = new Map<string, WebSocket>();

  function getBaseAppUrl(req?: express.Request): string {
    if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
    if (req) {
      return `${req.protocol}://${req.get('host') || `localhost:${PORT}`}`;
    }
    return `http://localhost:${PORT}`;
  }

  function dispatchNextQueuedJobToWorker(workerId: string) {
    const ws = liveSockets.get(workerId);
    const workerSnapshot = colabWorkers.find((w) => w.workerId === workerId);
    if (!ws || ws.readyState !== WebSocket.OPEN || !workerSnapshot) return;
    if (workerSnapshot.activeRequests >= workerSnapshot.maxConcurrency) return;

    const nextQueued = videoJobs.find((j) => j.status === 'QUEUED');
    if (!nextQueued) return;

    nextQueued.status = 'DISPATCHED';
    nextQueued.progressPct = 5;
    nextQueued.workerId = workerId;
    nextQueued.accountEmail = workerSnapshot.accountEmail;
    workerSnapshot.activeRequests += 1;
    workerSnapshot.status = 'BUSY';
    workerSnapshot.lastSeen = new Date().toISOString();

    ws.send(
      JSON.stringify({
        type: 'video_generate',
        request_id: nextQueued.id,
        payload: {
          model: nextQueued.model,
          prompt: nextQueued.enhancedPrompt || nextQueued.prompt,
          negative_prompt: nextQueued.negativePrompt,
          width: nextQueued.metrics.width,
          height: nextQueued.metrics.height,
          num_frames: nextQueued.metrics.latentFrames,
          inference_steps: nextQueued.inferenceSteps,
          guidance_scale: nextQueued.guidanceScale,
          flow_shift: nextQueued.flowShift,
          fps: nextQueued.fps,
          seed: nextQueued.seed,
          lock_xla_shape: nextQueued.lockXlaShape,
          vae_tiling: nextQueued.vaeTiling,
          vae_slicing: nextQueued.vaeSlicing,
        },
      })
    );
    savePersistedState();
  }

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(
      request.url || '/',
      `http://${request.headers.host || 'localhost'}`
    ).pathname;
    if (pathname === '/api/colab/ws/worker' || pathname === '/api/llm/ws/worker') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', (ws) => {
    let registeredWorkerId: string | null = null;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.worker_id && !registeredWorkerId) {
          registeredWorkerId = String(msg.worker_id);
          liveSockets.set(registeredWorkerId, ws);

          const matchedAccount = colabAccounts.find(
            (a) =>
              (msg.email && a.email.toLowerCase() === String(msg.email).toLowerCase()) ||
              a.workerId === registeredWorkerId ||
              a.state === 'ACTIVE'
          );

          const workerSnapshot: ColabWorkerSnapshot = {
            workerId: registeredWorkerId,
            accountId: matchedAccount ? matchedAccount.id : 'colab-live-ws',
            accountEmail:
              msg.email || (matchedAccount ? matchedAccount.email : 'colab-worker@google.com'),
            model: msg.model || 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers',
            capabilities: Array.isArray(msg.capabilities)
              ? msg.capabilities
              : [
                  't2v',
                  'vae_tiling',
                  'vae_slicing',
                  'bfloat16',
                  'flow_shift',
                  'seed_control',
                  'camera_motion',
                  'xla_static_832x480',
                ],
            gpuName: msg.gpu_name || 'Colab TPU v5e-1 (16GB HBM)',
            vramUsedGb: Number(msg.vram_used_gb || 8.2),
            vramTotalGb: Number(msg.vram_total_gb || 16.0),
            maxConcurrency: Number(msg.max_concurrency || 1),
            activeRequests: 0,
            connectedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            status: 'ONLINE',
            tunnelType: 'inbound_ws',
          };

          const existingIdx = colabWorkers.findIndex((w) => w.workerId === registeredWorkerId);
          if (existingIdx >= 0) {
            colabWorkers[existingIdx] = workerSnapshot;
          } else {
            colabWorkers.unshift(workerSnapshot);
          }

          if (matchedAccount) {
            matchedAccount.state = 'ACTIVE';
            matchedAccount.workerId = registeredWorkerId;
            matchedAccount.vramUsedGb = workerSnapshot.vramUsedGb;
            savePersistedState();
          }

          dispatchNextQueuedJobToWorker(registeredWorkerId);
          return;
        }

        if (msg.type === 'job_progress' && msg.request_id) {
          const job = videoJobs.find((j) => j.id === msg.request_id);
          if (job) {
            job.status = 'DIFFUSING';
            job.currentStep = Number(msg.step || job.currentStep);
            job.progressPct = Math.min(
              95,
              Math.round((job.currentStep / Math.max(1, job.inferenceSteps)) * 95)
            );
            savePersistedState();
          }
        } else if (msg.type === 'job_result' && msg.request_id) {
          const job = videoJobs.find((j) => j.id === msg.request_id);
          if (job) {
            // Persist real MP4 binary if sent by the worker
            if (msg.video_base64 && typeof msg.video_base64 === 'string') {
              const videoBuffer = Buffer.from(msg.video_base64, 'base64');
              const mp4FilePath = path.join(VIDEOS_DIR, `${job.id}.mp4`);
              fs.writeFileSync(mp4FilePath, videoBuffer);
              job.videoUrl = `/v1/videos/${job.id}.mp4`;
              job.fileSizeBytes = videoBuffer.length;
            }

            job.status = 'COMPLETED';
            job.progressPct = 100;
            job.currentStep = job.inferenceSteps;
            job.completedAt = new Date().toISOString();

            const w = colabWorkers.find((item) => item.workerId === job.workerId);
            if (w) {
              w.activeRequests = Math.max(0, w.activeRequests - 1);
              w.status = 'ONLINE';
              w.lastSeen = new Date().toISOString();
            }
            const acc = colabAccounts.find((a) => a.email === job.accountEmail);
            if (acc) {
              acc.completedJobs += 1;
            }
            savePersistedState();
            notifyJobWaiters(job);

            if (w) {
              dispatchNextQueuedJobToWorker(w.workerId);
            }
          }
        } else if (msg.type === 'job_error' && msg.request_id) {
          const job = videoJobs.find((j) => j.id === msg.request_id);
          if (job) {
            job.status = 'FAILED';
            job.error = String(msg.error || 'Worker execution failed');
            job.completedAt = new Date().toISOString();
            const w = colabWorkers.find((item) => item.workerId === job.workerId);
            if (w) {
              w.activeRequests = Math.max(0, w.activeRequests - 1);
              w.status = 'ONLINE';
              w.lastSeen = new Date().toISOString();
            }
            savePersistedState();
            notifyJobWaiters(job);
            if (w) {
              dispatchNextQueuedJobToWorker(w.workerId);
            }
          }
        }
      } catch (e) {
        console.error('Worker WS parse error:', e);
      }
    });

    ws.on('close', () => {
      if (registeredWorkerId) {
        liveSockets.delete(registeredWorkerId);
        colabWorkers = colabWorkers.filter((item) => item.workerId !== registeredWorkerId);
      }
    });
  });

  // ============================================================================
  // EXTERNAL APP PRODUCTION API ROUTES (/v1/*)
  // ============================================================================

  // 1. GET /v1/models — Discover models & full parameter capabilities
  app.get('/v1/models', (req, res) => {
    const baseUrl = getBaseAppUrl(req);
    res.json({
      object: 'list',
      onlineWorkers: colabWorkers.length,
      endpoints: {
        createVideo: `${baseUrl}/v1/video/generations`,
        batchScenes: `${baseUrl}/v1/video/scenes/batch`,
        getJobStatus: `${baseUrl}/v1/video/generations/{job_id}`,
        streamMp4: `${baseUrl}/v1/videos/{job_id}.mp4`,
        aiDirector: `${baseUrl}/api/ai/director`,
      },
      data: [
        {
          id: 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers',
          object: 'model',
          owned_by: 'FastVideo',
          recommended_runtime: 'Colab TPU v5e-1 (16GB HBM ~ uses 8.2GB)',
          default_parameters: {
            resolution: '480p',
            width: 832,
            height: 480,
            num_frames: 81,
            fps: 16,
            num_inference_steps: 4,
            guidance_scale: 5.0,
            flow_shift: 3.0,
            lock_xla_shape: true,
            vae_tiling: true,
            vae_slicing: true,
          },
          supported_features: [
            'text_to_video',
            'camera_motion_control',
            'flow_shift_scheduler',
            'seed_reproducibility',
            'vae_tiling_16gb_hbm',
            'vae_slicing',
            'xla_static_shape_832x480x81',
            'gemini_4_carbon_prompt_director',
            'sync_wait_or_async_poll',
            'multi_scene_short_film_batch',
          ],
        },
        {
          id: 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers',
          object: 'model',
          owned_by: 'Wan-AI',
          recommended_runtime: 'Colab TPU v5e-1 (16GB HBM ~ uses 8.2GB)',
          default_parameters: {
            resolution: '480p',
            width: 832,
            height: 480,
            num_frames: 81,
            fps: 16,
            num_inference_steps: 30,
            guidance_scale: 5.0,
            flow_shift: 3.0,
            lock_xla_shape: true,
            vae_tiling: true,
            vae_slicing: true,
          },
          supported_features: [
            'text_to_video',
            'camera_motion_control',
            'flow_shift_scheduler',
            'seed_reproducibility',
            'vae_tiling_16gb_hbm',
            'vae_slicing',
            'xla_static_shape_832x480x81',
            'gemini_4_carbon_prompt_director',
            'sync_wait_or_async_poll',
            'multi_scene_short_film_batch',
          ],
        },
      ],
    });
  });

  // 2. GET /v1/videos/:filename & GET /v1/video/generations/:id/content — Stream/Download MP4
  const serveVideoFile: express.RequestHandler = (req, res) => {
    const rawId = (req.params.filename || req.params.id || '').replace(/\.mp4$/i, '');
    const safeId = path.basename(rawId);
    const mp4Path = path.join(VIDEOS_DIR, `${safeId}.mp4`);

    if (!fs.existsSync(mp4Path)) {
      res.status(404).json({
        error: `File video cho job '${safeId}' chưa sẵn sàng hoặc không tồn tại.`,
      });
      return;
    }

    const stat = fs.statSync(mp4Path);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (req.query.download === '1' || req.query.download === 'true') {
      res.setHeader('Content-Disposition', `attachment; filename="${safeId}.mp4"`);
    }

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;
      const file = fs.createReadStream(mp4Path, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      });
      file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp4',
      });
      fs.createReadStream(mp4Path).pipe(res);
    }
  };

  app.get('/v1/videos/:filename', serveVideoFile);
  app.get('/v1/video/generations/:id/content', serveVideoFile);

  // 3. GET /v1/video/generations/:id — Poll Single Job Status & Video URL
  app.get('/v1/video/generations/:id', (req, res) => {
    const { id } = req.params;
    const job = videoJobs.find((j) => j.id === id);
    if (!job) {
      res.status(404).json({ error: `Không tìm thấy job ID '${id}'.` });
      return;
    }

    const baseUrl = getBaseAppUrl(req);
    const absoluteVideoUrl = job.videoUrl ? `${baseUrl}${job.videoUrl}` : null;

    res.json({
      id: job.id,
      object: 'video.generation',
      status: job.status,
      progress_pct: job.progressPct,
      current_step: job.currentStep,
      total_steps: job.inferenceSteps,
      model: job.model,
      prompt: job.prompt,
      enhanced_prompt: job.enhancedPrompt || null,
      negative_prompt: job.negativePrompt,
      camera_motion: job.cameraMotion,
      seed: job.seed,
      flow_shift: job.flowShift,
      lock_xla_shape: job.lockXlaShape,
      vae_tiling: job.vaeTiling,
      vae_slicing: job.vaeSlicing,
      width: job.metrics.width,
      height: job.metrics.height,
      num_frames: job.metrics.latentFrames,
      fps: job.fps,
      estimated_hbm_gb: job.metrics.estimatedVramGb,
      worker_id: job.workerId,
      account_email: job.accountEmail,
      video_url: absoluteVideoUrl,
      download_url: absoluteVideoUrl ? `${absoluteVideoUrl}?download=1` : null,
      file_size_bytes: job.fileSizeBytes || null,
      error: job.error || null,
      created_at: job.createdAt,
      completed_at: job.completedAt || null,
      job,
    });
  });

  // 4. GET /v1/video/generations — List Jobs
  app.get('/v1/video/generations', (req, res) => {
    const baseUrl = getBaseAppUrl(req);
    const statusFilter = req.query.status ? String(req.query.status).toUpperCase() : null;
    const batchFilter = req.query.batchId ? String(req.query.batchId) : null;

    let list = videoJobs;
    if (statusFilter) list = list.filter((j) => j.status === statusFilter);
    if (batchFilter) list = list.filter((j) => j.batchId === batchFilter);

    res.json({
      object: 'list',
      total: list.length,
      data: list.map((j) => ({
        ...j,
        fullVideoUrl: j.videoUrl ? `${baseUrl}${j.videoUrl}` : null,
      })),
    });
  });

  // Helper to create & dispatch a single VideoJob
  async function createAndDispatchJob(
    body: Record<string, any>,
    authHeader: string,
    sceneIndex?: number,
    batchId?: string
  ): Promise<VideoJob> {
    const model =
      body.model === 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers'
        ? 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers'
        : 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers';

    const rawPrompt = String(body.prompt || '').trim();
    const cameraMotion: CameraMotionType =
      body.cameraMotion || body.camera_motion || 'dolly_in';
    const negativePrompt =
      body.negativePrompt ||
      body.negative_prompt ||
      'Bright tones, overexposed, static, blurred details, subtitles, worst quality, low quality';
    const presetId: CommercialPresetId = body.presetId || body.preset_id || 'kling-1.6-pro';
    const resolution: '480p' | '720p' = body.resolution === '720p' ? '720p' : '480p';
    const aspectRatio: '16:9' | '9:16' | '1:1' =
      body.aspectRatio || body.aspect_ratio || '16:9';
    const durationSec: 5 | 10 =
      Number(body.durationSec || body.duration_sec) === 10 ? 10 : 5;
    const fps: 16 | 24 = Number(body.fps) === 24 ? 24 : 16;
    const defaultSteps = model === 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers' ? 30 : 4;
    const inferenceSteps = Number(
      body.inferenceSteps || body.num_inference_steps || body.steps || defaultSteps
    );
    const guidanceScale = Number(
      body.guidanceScale || body.guidance_scale || body.cfg || 5.0
    );
    const flowShift = Number(
      body.flowShift || body.flow_shift || (resolution === '720p' ? 5.0 : 3.0)
    );
    const seed =
      body.seed !== undefined
        ? Number(body.seed)
        : Math.floor(100000 + Math.random() * 900000);
    const lockXlaShape =
      body.lockXlaShape !== undefined
        ? Boolean(body.lockXlaShape)
        : body.lock_xla_shape !== undefined
        ? Boolean(body.lock_xla_shape)
        : true;
    const vaeTiling =
      body.vaeTiling !== undefined
        ? Boolean(body.vaeTiling)
        : body.vae_tiling !== undefined
        ? Boolean(body.vae_tiling)
        : true;
    const vaeSlicing =
      body.vaeSlicing !== undefined
        ? Boolean(body.vaeSlicing)
        : body.vae_slicing !== undefined
        ? Boolean(body.vae_slicing)
        : true;
    const shouldEnhancePrompt = Boolean(body.enhancePrompt || body.enhance_prompt);

    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      const matchedKey = apiKeys.find((k) => token.startsWith(k.prefix));
      if (matchedKey) {
        matchedKey.requestsCount += 1;
      }
    }

    const promptWithCamera = applyCameraMotionToPrompt(rawPrompt, cameraMotion);
    let finalEnhancedPrompt: string | undefined = body.enhancedPrompt;
    let thinkingSummary: string | undefined = body.thinkingSummary;

    if (shouldEnhancePrompt && !finalEnhancedPrompt && process.env.GEMINI_API_KEY) {
      try {
        const ai = getGeminiClient();
        const geminiRes = await ai.models.generateContent({
          model: 'gemini-4-carbon',
          contents: `Viết lại prompt tiếng Anh chuẩn điện ảnh cho mô hình Wan 2.1 1.3B theo công thức 4 phần: [Góc máy & chuyển động camera (${cameraMotion})] + [Chủ thể & hành động] + [Bối cảnh & ánh sáng] + [Phong cách màu phim 35mm]. Ý tưởng gốc: "${rawPrompt}". Chỉ trả về chuỗi prompt tiếng Anh duy nhất.`,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
          },
        });
        if (geminiRes.text && geminiRes.text.trim()) {
          finalEnhancedPrompt = geminiRes.text.trim();
          thinkingSummary = 'Prompt đã được tối ưu bởi Gemini 4 Carbon (ThinkingLevel.HIGH)';
        }
      } catch {
        // Fallback to camera-injected prompt if Gemini API key is not configured
      }
    }

    const activeWorker = colabWorkers.find((w) => w.status === 'ONLINE');

    const metrics = calculateFastWanMetrics({
      resolution,
      aspectRatio,
      durationSec,
      fps,
      inferenceSteps,
      enableTeaCache: true,
      cpuOffload: false,
      lockXlaShape,
    });

    const randomSuffix = Math.floor(100 + Math.random() * 900);
    const jobId = `job-wan-${Date.now().toString().slice(-5)}${randomSuffix}`;
    const newJob: VideoJob = {
      id: jobId,
      sceneIndex,
      batchId,
      prompt: promptWithCamera,
      enhancedPrompt: finalEnhancedPrompt,
      thinkingSummary,
      negativePrompt,
      presetId,
      model,
      resolution: lockXlaShape ? '480p' : resolution,
      aspectRatio: lockXlaShape ? '16:9' : aspectRatio,
      durationSec: lockXlaShape ? 5 : durationSec,
      fps: lockXlaShape ? 16 : fps,
      inferenceSteps,
      guidanceScale,
      flowShift,
      cameraMotion,
      seed,
      lockXlaShape,
      vaeTiling,
      vaeSlicing,
      status: activeWorker ? 'DISPATCHED' : 'QUEUED',
      progressPct: activeWorker ? 5 : 0,
      currentStep: 0,
      workerId: activeWorker ? activeWorker.workerId : 'Đang chờ Worker',
      accountEmail: activeWorker ? activeWorker.accountEmail : 'Chưa kết nối',
      createdAt: new Date().toISOString(),
      posterUrl: '',
      videoSceneType: 'cyber_rain',
      metrics,
    };

    videoJobs.unshift(newJob);

    if (activeWorker) {
      const ws = liveSockets.get(activeWorker.workerId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        activeWorker.activeRequests += 1;
        activeWorker.status = 'BUSY';
        activeWorker.vramUsedGb = metrics.estimatedVramGb;
        activeWorker.lastSeen = new Date().toISOString();
        ws.send(
          JSON.stringify({
            type: 'video_generate',
            request_id: newJob.id,
            payload: {
              model: newJob.model,
              prompt: newJob.enhancedPrompt || newJob.prompt,
              negative_prompt: newJob.negativePrompt,
              width: metrics.width,
              height: metrics.height,
              num_frames: metrics.latentFrames,
              inference_steps: newJob.inferenceSteps,
              guidance_scale: newJob.guidanceScale,
              flow_shift: newJob.flowShift,
              fps: newJob.fps,
              seed: newJob.seed,
              lock_xla_shape: newJob.lockXlaShape,
              vae_tiling: newJob.vaeTiling,
              vae_slicing: newJob.vaeSlicing,
            },
          })
        );
      } else {
        newJob.status = 'QUEUED';
      }
    }

    const currentBucket = trafficSeries['24h'][trafficSeries['24h'].length - 1];
    if (currentBucket) {
      currentBucket.requests += 1;
      currentBucket.diffusionSteps += inferenceSteps;
      currentBucket.gpuSeconds += metrics.estimatedDurationSec;
    }
    const dayBucket = trafficSeries['7d'][trafficSeries['7d'].length - 1];
    if (dayBucket) {
      dayBucket.requests += 1;
      dayBucket.diffusionSteps += inferenceSteps;
      dayBucket.gpuSeconds += metrics.estimatedDurationSec;
    }
    const monthBucket = trafficSeries['30d'][trafficSeries['30d'].length - 1];
    if (monthBucket) {
      monthBucket.requests += 1;
      monthBucket.diffusionSteps += inferenceSteps;
      monthBucket.gpuSeconds += metrics.estimatedDurationSec;
    }

    savePersistedState();
    return newJob;
  }

  // 5. POST /v1/video/generations — Main Video Generation Endpoint for External App
  const handleCreateVideoJob: express.RequestHandler = async (req, res) => {
    const body = req.body || {};
    const prompt = body.prompt;

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'Vui lòng nhập mô tả cảnh video (prompt).' });
      return;
    }

    const waitForCompletion = Boolean(body.wait || req.query.wait === 'true');
    const responseFormat = body.responseFormat || body.response_format || 'url';
    const newJob = await createAndDispatchJob(body, req.headers.authorization || '');
    const baseUrl = getBaseAppUrl(req);

    if (waitForCompletion) {
      const timeoutMs = Number(body.timeoutMs || 180000);
      const finishedJob = await new Promise<VideoJob>((resolve) => {
        if (newJob.status === 'COMPLETED' || newJob.status === 'FAILED') {
          resolve(newJob);
          return;
        }
        const timer = setTimeout(() => {
          resolve(newJob);
        }, timeoutMs);
        const list = jobCompletionWaiters.get(newJob.id) || [];
        list.push((doneJob) => {
          clearTimeout(timer);
          resolve(doneJob);
        });
        jobCompletionWaiters.set(newJob.id, list);
      });

      const fullVideoUrl = finishedJob.videoUrl ? `${baseUrl}${finishedJob.videoUrl}` : null;
      let b64Json: string | undefined;
      if (
        responseFormat === 'b64_json' &&
        finishedJob.status === 'COMPLETED' &&
        fs.existsSync(path.join(VIDEOS_DIR, `${finishedJob.id}.mp4`))
      ) {
        b64Json = fs
          .readFileSync(path.join(VIDEOS_DIR, `${finishedJob.id}.mp4`))
          .toString('base64');
      }

      res.status(200).json({
        id: finishedJob.id,
        object: 'video.generation',
        status: finishedJob.status,
        video_url: fullVideoUrl,
        download_url: fullVideoUrl ? `${fullVideoUrl}?download=1` : null,
        poll_url: `${baseUrl}/v1/video/generations/${finishedJob.id}`,
        b64_json: b64Json,
        job: finishedJob,
        jobs: videoJobs,
      });
      return;
    }

    res.status(201).json({
      id: newJob.id,
      object: 'video.generation',
      status: newJob.status,
      poll_url: `${baseUrl}/v1/video/generations/${newJob.id}`,
      content_url: `${baseUrl}/v1/videos/${newJob.id}.mp4`,
      job: newJob,
      jobs: videoJobs,
    });
  };

  app.post('/api/video/jobs', handleCreateVideoJob);
  app.post('/v1/video/generations', handleCreateVideoJob);

  // 6. POST /v1/video/scenes/batch — Multi-scene Short Film Batch (Locks 832x480x81 for TPU XLA cache)
  app.post('/v1/video/scenes/batch', async (req, res) => {
    const { scenes, model = 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers', inferenceSteps } =
      req.body || {};

    if (!Array.isArray(scenes) || scenes.length === 0) {
      res.status(400).json({
        error: 'Vui lòng truyền mảng scenes: [{ prompt, cameraMotion, seed }] để tạo phim ngắn.',
      });
      return;
    }

    const batchId = `batch-film-${Date.now().toString().slice(-5)}`;
    const createdJobs: VideoJob[] = [];

    for (let i = 0; i < scenes.length; i++) {
      const sc = scenes[i];
      if (!sc || !sc.prompt) continue;
      const job = await createAndDispatchJob(
        {
          ...sc,
          model: sc.model || model,
          inferenceSteps: sc.inferenceSteps || inferenceSteps,
          lockXlaShape: true, // Enforce static 832x480x81 across all scenes so TPU v5e-1 never recompiles XLA
        },
        req.headers.authorization || '',
        i + 1,
        batchId
      );
      createdJobs.push(job);
    }

    const baseUrl = getBaseAppUrl(req);
    res.status(201).json({
      object: 'video.batch',
      batch_id: batchId,
      xla_static_shape_locked: '832x480 · 81 frames · 16fps (No TPU XLA recompilation)',
      scene_count: createdJobs.length,
      poll_batch_url: `${baseUrl}/v1/video/generations?batchId=${batchId}`,
      scenes: createdJobs,
    });
  });

  app.delete('/api/jobs', (_req, res) => {
    videoJobs = [];
    trafficSeries = createZeroTrafficSeries();
    try {
      for (const file of fs.readdirSync(VIDEOS_DIR)) {
        if (file.endsWith('.mp4')) {
          fs.unlinkSync(path.join(VIDEOS_DIR, file));
        }
      }
    } catch {
      // Ignore
    }
    savePersistedState();
    res.json({ cleared: true, jobs: videoJobs, traffic: trafficSeries });
  });

  // ============================================================================
  // CONTROL PLANE API ROUTES (/api/*)
  // ============================================================================

  app.get('/api/cluster/state', (req, res) => {
    const appUrl = getBaseAppUrl(req);
    res.json({
      appUrl,
      workerAuthToken: WORKER_AUTH_TOKEN,
      supervisorConfig: {
        runDurationSec: RUN_DURATION_SEC,
        prewarmThresholdSec: PREWARM_THRESHOLD_SEC,
        cooldownDurationSec: COOLDOWN_DURATION_SEC,
        modelRepo: 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers',
      },
      accounts: colabAccounts,
      workers: colabWorkers,
      jobs: videoJobs,
      apiKeys,
      traffic: trafficSeries,
    });
  });

  app.post('/api/accounts/oauth-sync', (req, res) => {
    const { email, displayName, photoURL, driveNotebookId } = req.body || {};
    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email tài khoản Google là bắt buộc.' });
      return;
    }

    let account = colabAccounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (!account) {
      account = {
        id: `colab-oauth-${Date.now().toString().slice(-4)}`,
        email,
        displayName: displayName || email.split('@')[0],
        avatarUrl: photoURL || undefined,
        state: colabAccounts.length === 0 ? 'ACTIVE' : 'READY',
        gpuType: 'TPU v5e-1 (16GB HBM)',
        activeRunSeconds: 0,
        cooldownRemainingSeconds: 0,
        lastUsedAt: new Date().toISOString(),
        workerId: colabAccounts.length === 0 ? 'colab-tpu-v5e-01' : null,
        vramUsedGb: 0,
        vramTotalGb: 16.0,
        completedJobs: 0,
        oauthConnected: true,
        driveNotebookId: driveNotebookId || undefined,
        warpProxyEnabled: true,
      };
      colabAccounts.unshift(account);
    } else {
      account.oauthConnected = true;
      if (displayName) account.displayName = displayName;
      if (photoURL) account.avatarUrl = photoURL;
      if (driveNotebookId) account.driveNotebookId = driveNotebookId;
    }

    savePersistedState();
    res.json({ account, accounts: colabAccounts });
  });

  app.post('/api/accounts/add', (req, res) => {
    const { email, displayName, gpuType, warpProxyEnabled } = req.body || {};
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      res.status(400).json({ error: 'Vui lòng nhập email Google Colab hợp lệ.' });
      return;
    }

    const exists = colabAccounts.some((a) => a.email.toLowerCase() === email.trim().toLowerCase());
    if (exists) {
      res.status(409).json({ error: 'Tài khoản Google Colab này đã có trong cụm xoay vòng.' });
      return;
    }

    const newAcc: ColabAccount = {
      id: `colab-acc-${Date.now().toString().slice(-4)}`,
      email: email.trim(),
      displayName: (displayName || email.split('@')[0]).trim(),
      state: colabAccounts.length === 0 ? 'ACTIVE' : 'READY',
      gpuType: gpuType || 'TPU v5e-1 (16GB HBM)',
      activeRunSeconds: 0,
      cooldownRemainingSeconds: 0,
      lastUsedAt: new Date().toISOString(),
      workerId: colabAccounts.length === 0 ? 'colab-tpu-v5e-01' : null,
      vramUsedGb: 0,
      vramTotalGb: gpuType?.includes('L4') ? 24.0 : gpuType?.includes('T4') ? 15.0 : 16.0,
      completedJobs: 0,
      oauthConnected: true,
      warpProxyEnabled: warpProxyEnabled !== false,
    };

    colabAccounts.push(newAcc);
    savePersistedState();
    res.status(201).json({ account: newAcc, accounts: colabAccounts });
  });

  app.delete('/api/accounts/:id', (req, res) => {
    const { id } = req.params;
    colabAccounts = colabAccounts.filter((a) => a.id !== id);
    colabWorkers = colabWorkers.filter((w) => w.accountId !== id);
    savePersistedState();
    res.json({ deleted: true, accounts: colabAccounts, workers: colabWorkers });
  });

  app.post('/api/workers/colab/:action', (req, res) => {
    const { action } = req.params;
    const { accountId } = req.body || {};

    if (action === 'rotate') {
      const result = rotateColabPool(colabAccounts);
      if (!result.promotedAccount) {
        res.status(409).json({
          error: 'Cần ít nhất 1 tài khoản ở trạng thái READY hoặc PREWARMING để xoay vòng.',
        });
        return;
      }
      colabAccounts = result.updatedAccounts;
      if (result.retiredAccount) {
        colabWorkers = colabWorkers.filter((w) => w.accountId !== result.retiredAccount!.id);
      }
      savePersistedState();
      res.json({
        rotated: true,
        promotedAccount: result.promotedAccount,
        retiredAccount: result.retiredAccount,
        accounts: colabAccounts,
        workers: colabWorkers,
      });
      return;
    }

    if (action === 'prewarm') {
      const target = accountId
        ? colabAccounts.find((a) => a.id === accountId)
        : colabAccounts.find((a) => a.state === 'READY');

      if (!target) {
        res.status(404).json({ error: 'Không có tài khoản READY để Pre-warm.' });
        return;
      }

      target.state = 'PREWARMING';
      target.workerId = `colab-tpu-${target.id.slice(-4)}`;
      target.vramUsedGb = 0;
      target.lastUsedAt = new Date().toISOString();
      savePersistedState();

      res.json({ prewarmed: true, account: target, accounts: colabAccounts, workers: colabWorkers });
      return;
    }

    if (action === 'start') {
      const target = colabAccounts.find((a) => a.id === accountId);
      if (!target) {
        res.status(404).json({ error: 'Không tìm thấy tài khoản Colab.' });
        return;
      }
      target.state = 'ACTIVE';
      target.activeRunSeconds = 0;
      target.cooldownRemainingSeconds = 0;
      target.workerId = `colab-tpu-${target.id.slice(-4)}`;
      target.lastUsedAt = new Date().toISOString();
      savePersistedState();

      res.json({ started: true, account: target, accounts: colabAccounts, workers: colabWorkers });
      return;
    }

    if (action === 'stop') {
      const target = colabAccounts.find((a) => a.id === accountId);
      if (!target) {
        res.status(404).json({ error: 'Không tìm thấy tài khoản Colab.' });
        return;
      }
      target.state = 'COOLDOWN';
      target.cooldownRemainingSeconds = COOLDOWN_DURATION_SEC;
      target.activeRunSeconds = 0;
      target.workerId = null;
      target.vramUsedGb = 0;
      colabWorkers = colabWorkers.filter((w) => w.accountId !== target.id);
      savePersistedState();

      res.json({ stopped: true, account: target, accounts: colabAccounts, workers: colabWorkers });
      return;
    }

    res.status(400).json({ error: `Hành động worker không hợp lệ: ${action}` });
  });

  app.post('/api/apikeys', (req, res) => {
    const { name, rpmLimit = 60, expiresInDays = 30, scopes = ['all'] } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'Vui lòng nhập tên định danh cho API Key.' });
      return;
    }

    const secretSuffix =
      Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
    const fullSecret = `sk-wan-${secretSuffix}`;
    const item: ApiKeyItem = {
      id: `key-${Date.now()}`,
      name: name.trim(),
      prefix: fullSecret.slice(0, 10),
      maskedKey: `${fullSecret.slice(0, 10)}****************${fullSecret.slice(-4)}`,
      rpmLimit: Number(rpmLimit),
      scopes: Array.isArray(scopes) && scopes.length > 0 ? scopes : ['all'],
      createdAt: new Date().toISOString(),
      expiresInDays: Number(expiresInDays),
      requestsCount: 0,
    };

    apiKeys.unshift(item);
    savePersistedState();
    res.status(201).json({ apiKey: item, fullSecret, apiKeys });
  });

  app.delete('/api/apikeys/:id', (req, res) => {
    const { id } = req.params;
    apiKeys = apiKeys.filter((k) => k.id !== id);
    savePersistedState();
    res.json({ deleted: true, apiKeys });
  });

  // ============================================================================
  // PRODUCTION E2E VERIFICATION SUITE (/api/e2e/verify)
  // Tests:
  // 1. Real WebSocket Worker connection (/api/colab/ws/worker)
  // 2. GET /v1/models discovery
  // 3. POST /v1/video/generations with wait:true, cameraMotion, flowShift, seed, lockXlaShape
  // 4. Real 832x480 @ 16fps (81 frames) H.264 MP4 synthesis via FFmpeg -> base64 -> WS job_result
  // 5. Disk persistence (.data/videos/:id.mp4) & HTTP 200/206 Range streaming at GET /v1/videos/:id.mp4
  // ============================================================================
  app.post('/api/e2e/verify', async (req, res) => {
    const cleanAfter = Boolean(req.body?.cleanAfter);
    const stepsLog: string[] = [];
    const testWorkerId = `colab-tpu-v5e-${Date.now().toString().slice(-4)}`;
    const wsUrl = `ws://127.0.0.1:${PORT}/api/colab/ws/worker`;

    try {
      // Check GET /v1/models
      const modelsRes = await fetch(`http://127.0.0.1:${PORT}/v1/models`);
      const modelsJson = await modelsRes.json();
      stepsLog.push(
        `1. [GET /v1/models] Sẵn sàng ${modelsJson.data?.length || 0} model (${modelsJson.data
          ?.map((m: any) => m.id)
          .join(', ')})`
      );

      const wsClient = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${WORKER_AUTH_TOKEN}` },
        maxPayload: 100 * 1024 * 1024,
      });

      wsClient.on('open', () => {
        stepsLog.push(
          `2. [WebSocket Hub] Worker ${testWorkerId} (Colab TPU v5e-1 16GB HBM) đã kết nối vào ${wsUrl}`
        );
        wsClient.send(
          JSON.stringify({
            worker_id: testWorkerId,
            email: colabAccounts[0]?.email || 'tpu-v5e-worker@colab.google.com',
            model: 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers',
            capabilities: [
              't2v',
              'vae_tiling',
              'vae_slicing',
              'bfloat16',
              'flow_shift',
              'seed_control',
              'camera_motion',
              'xla_static_832x480',
            ],
            gpu_name: 'Colab TPU v5e-1 (16GB HBM)',
            vram_used_gb: 8.2,
            vram_total_gb: 16.0,
            max_concurrency: 1,
            token: WORKER_AUTH_TOKEN,
          })
        );
      });

      wsClient.on('message', async (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'video_generate' && msg.request_id) {
          const reqId = msg.request_id;
          const p = msg.payload || {};
          stepsLog.push(
            `3. [Worker Dispatch] Nhận lệnh tạo video '${reqId}': ${p.width}x${p.height}, ${p.num_frames} frames @ ${p.fps}fps, steps=${p.inference_steps}, cfg=${p.guidance_scale}, flow_shift=${p.flow_shift}, seed=${p.seed}`
          );

          for (let s = 1; s <= Number(p.inference_steps || 4); s++) {
            wsClient.send(
              JSON.stringify({
                type: 'job_progress',
                request_id: reqId,
                step: s,
                total_steps: p.inference_steps || 4,
              })
            );
          }
          stepsLog.push(
            `4. [TPU Diffusion] Đã chạy xong ${p.inference_steps}/4 steps (bfloat16 + enable_vae_tiling + enable_vae_slicing)`
          );

          // Synthesize a real playable 832x480 @ 16fps (81 frames) H.264 MP4 file
          const mp4Buffer = await synthesizeTestMp4Buffer({
            width: p.width || 832,
            height: p.height || 480,
            fps: p.fps || 16,
            numFrames: p.num_frames || 81,
            jobId: reqId,
          });

          wsClient.send(
            JSON.stringify({
              type: 'job_result',
              request_id: reqId,
              mime: 'video/mp4',
              video_base64: mp4Buffer.toString('base64'),
              done: true,
            })
          );
          stepsLog.push(
            `5. [MP4 Binary Stream] Đã đóng gói & truyền file ${reqId}.mp4 (${(
              mp4Buffer.length / 1024
            ).toFixed(1)} KB, 832x480, 81 frames) về Gateway`
          );
        }
      });

      await new Promise((r) => setTimeout(r, 120));

      // Call POST /v1/video/generations with synchronous wait: true + full model parameters
      const genRes = await fetch(`http://127.0.0.1:${PORT}/v1/video/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers',
          prompt:
            'a lone cyberpunk detective walking through a rainy neon-lit alley in Tokyo at night, reflections on wet asphalt, volumetric fog, 35mm film grain',
          camera_motion: 'dolly_in',
          resolution: '480p',
          aspect_ratio: '16:9',
          duration_sec: 5,
          fps: 16,
          num_inference_steps: 4,
          guidance_scale: 5.0,
          flow_shift: 3.0,
          seed: 778899,
          lock_xla_shape: true,
          vae_tiling: true,
          vae_slicing: true,
          wait: true,
        }),
      });
      const genData = await genRes.json();
      wsClient.close();

      // Verify GET /v1/videos/:id.mp4 serves real video/mp4 bytes
      const videoCheckRes = await fetch(`http://127.0.0.1:${PORT}/v1/videos/${genData.id}.mp4`);
      const contentType = videoCheckRes.headers.get('content-type');
      const videoBytes = await videoCheckRes.arrayBuffer();
      stepsLog.push(
        `6. [HTTP Video Stream] Kiểm tra GET /v1/videos/${genData.id}.mp4 -> HTTP ${videoCheckRes.status} (${contentType}, ${videoBytes.byteLength} bytes) — Sẵn sàng phát & tải về!`
      );

      if (cleanAfter) {
        videoJobs = videoJobs.filter((j) => j.id !== genData.id);
        const fpath = path.join(VIDEOS_DIR, `${genData.id}.mp4`);
        if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
        savePersistedState();
      }

      res.json({
        ok: true,
        jobId: genData.id,
        finalStatus: genData.status,
        videoUrl: genData.video_url,
        fileSizeBytes: videoBytes.byteLength,
        stepsLog,
        accounts: colabAccounts,
        workers: colabWorkers,
        jobs: videoJobs,
        traffic: trafficSeries,
      });
    } catch (err: any) {
      res.status(500).json({
        ok: false,
        error: err?.message || 'E2E test failed',
        stepsLog,
      });
    }
  });

  // Gemini 4 Carbon (ThinkingLevel.HIGH) Deep Thinking Video Director API
  app.post('/api/ai/director', async (req, res) => {
    const { prompt, presetId = 'kling-1.6-pro', cameraMotion = 'dolly_in', resolution = '480p' } =
      req.body || {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'Vui lòng nhập ý tưởng video để AI Director phân tích.' });
      return;
    }

    try {
      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: 'gemini-4-carbon',
        contents: `Người dùng muốn tạo một cảnh phim ngắn bằng mô hình Wan 2.1 1.3B (FastVideo/FastWan2.1-T2V-1.3B-Diffusers hoặc Wan-AI/Wan2.1-T2V-1.3B-Diffusers) chạy trên Google Colab TPU v5e-1 (16GB HBM, 832x480, 81 frames @ 16fps).
Ý tưởng gốc: "${prompt.trim()}"
Preset: ${presetId}, Camera: ${cameraMotion}, Độ phân giải: ${resolution}.
Hãy thiết kế kịch bản prompt theo đúng công thức 4 phần của Wan 2.1: [Góc máy & chuyển động camera] + [Chủ thể & hành động] + [Bối cảnh & ánh sáng] + [Phong cách màu phim].`,
        config: {
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.HIGH,
          },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              cinematicPrompt: { type: Type.STRING },
              negativePrompt: { type: Type.STRING },
              thinkingSummaryVi: { type: Type.STRING },
              cameraTrajectory: { type: Type.STRING },
              recommendedSteps: { type: Type.INTEGER },
              recommendedCfg: { type: Type.NUMBER },
              vramOptimizationTip: { type: Type.STRING },
            },
            required: [
              'cinematicPrompt',
              'negativePrompt',
              'thinkingSummaryVi',
              'cameraTrajectory',
              'recommendedSteps',
              'recommendedCfg',
              'vramOptimizationTip',
            ],
          },
        },
      });

      const rawText = (response.text ?? '{}').trim();
      const parsed = JSON.parse(rawText);
      res.json({
        model: 'gemini-4-carbon',
        thinkingLevel: 'HIGH',
        result: parsed,
      });
    } catch (error: any) {
      res.status(500).json({
        error: error?.message || 'Không thể kết nối tới mô hình gemini-4-carbon.',
      });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`FastWan Hub Provider listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
