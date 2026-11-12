import express from 'express';
import { execFile, spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import { createServer } from 'http';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  WAN_MODEL_ADAPTERS,
  HARDWARE_PROFILES,
  calculateFastWanMetrics,
  applyCameraMotionToPrompt,
  isValidMp4Buffer,
  buildColabCliCommands,
  generateFastWanWorkerScript,
  type ColabRuntimeSession,
  type ColabWorkerSnapshot,
  type VideoJob,
  type WanModelId,
  type HardwareTargetId,
  type CommercialPresetId,
  type CameraMotionType,
  type ColabAccount,
} from './src/utils/colabEngine.ts';

dotenv.config();

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
let WORKER_AUTH_TOKEN =
  process.env.WORKER_AUTH_TOKEN || 'wh_wan_orchestrator_sec_99a8b7c6d5e4';
const STUDIO_SESSION_TOKEN = 'wan_studio_ui_session_v2';

const DATA_DIR = path.join(__dirname, '.data');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const SQLITE_PATH = path.join(DATA_DIR, 'wan_orchestrator.db');
const LEGACY_STATE_FILE = path.join(DATA_DIR, 'hub_state.json');
const ADC_CREDENTIALS_PATH = path.join(DATA_DIR, 'colab_adc_credentials.json');
const BOOTSTRAP_SCRIPT_PATH = path.join(DATA_DIR, 'bootstrap.py');
const LEGACY_BOOTSTRAP_SCRIPT_PATH = path.join(DATA_DIR, 'bootstrap_wan_worker.py');

if (!fs.existsSync(VIDEOS_DIR)) {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
}

// ============================================================================
// SQLITE PERSISTENT STORAGE & QUEUE INITIALIZATION (node:sqlite DatabaseSync)
// ============================================================================
const db = new DatabaseSync(SQLITE_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runtime_sessions (
    session_id TEXT PRIMARY KEY,
    account_email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    hardware_target TEXT NOT NULL DEFAULT 'tpu_v5e',
    state TEXT NOT NULL DEFAULT 'DISCONNECTED',
    cli_binary_available INTEGER NOT NULL DEFAULT 0,
    adc_authenticated INTEGER NOT NULL DEFAULT 0,
    worker_connected INTEGER NOT NULL DEFAULT 0,
    worker_id TEXT,
    gpu_name_reported TEXT,
    vram_used_gb REAL,
    vram_total_gb REAL NOT NULL DEFAULT 16.0,
    vram_is_measured INTEGER NOT NULL DEFAULT 0,
    compute_units_used REAL NOT NULL DEFAULT 0,
    compute_units_limit REAL DEFAULT 100,
    completed_jobs_count INTEGER NOT NULL DEFAULT 0,
    last_heartbeat_at TEXT,
    started_at TEXT,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS video_jobs (
    id TEXT PRIMARY KEY,
    scene_index INTEGER,
    batch_id TEXT,
    prompt TEXT NOT NULL,
    enhanced_prompt TEXT,
    thinking_summary TEXT,
    negative_prompt TEXT NOT NULL,
    preset_id TEXT NOT NULL,
    model TEXT NOT NULL,
    hardware_target TEXT NOT NULL DEFAULT 'tpu_v5e',
    resolution TEXT NOT NULL DEFAULT '480p',
    aspect_ratio TEXT NOT NULL DEFAULT '16:9',
    duration_sec INTEGER NOT NULL DEFAULT 4,
    fps INTEGER NOT NULL DEFAULT 16,
    inference_steps INTEGER NOT NULL DEFAULT 3,
    guidance_scale REAL NOT NULL DEFAULT 1.0,
    flow_shift REAL NOT NULL DEFAULT 3.0,
    camera_motion TEXT NOT NULL DEFAULT 'dolly_in',
    seed INTEGER NOT NULL DEFAULT 42,
    lock_xla_shape INTEGER NOT NULL DEFAULT 1,
    vae_tiling INTEGER NOT NULL DEFAULT 1,
    vae_slicing INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'QUEUED',
    progress_pct INTEGER NOT NULL DEFAULT 0,
    current_step INTEGER NOT NULL DEFAULT 0,
    worker_id TEXT NOT NULL DEFAULT 'Đang chờ Worker',
    account_email TEXT NOT NULL DEFAULT 'Chưa kết nối',
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 2,
    lease_expires_at TEXT,
    is_mock INTEGER NOT NULL DEFAULT 0,
    actual_inference_sec REAL,
    measured_vram_gb REAL,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    video_url TEXT,
    file_size_bytes INTEGER,
    error TEXT,
    metrics_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    masked_key TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    rpm_limit INTEGER NOT NULL DEFAULT 60,
    scopes_json TEXT NOT NULL DEFAULT '["all"]',
    created_at TEXT NOT NULL,
    expires_in_days INTEGER NOT NULL DEFAULT 30,
    requests_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS orchestrator_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    level TEXT NOT NULL,
    source TEXT NOT NULL,
    message TEXT NOT NULL
  );
`);

function getSetting(key: string, defaultValue: string): string {
  const row = db
    .prepare('SELECT value FROM system_settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  if (!row) {
    db.prepare('INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)').run(
      key,
      defaultValue
    );
    return defaultValue;
  }
  return row.value;
}

function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

WORKER_AUTH_TOKEN = getSetting('worker_auth_token', WORKER_AUTH_TOKEN);

function appendOrchestratorLog(
  level: 'INFO' | 'WARN' | 'ERROR',
  source: 'CLI' | 'WORKER_HUB' | 'QUEUE' | 'AUTH' | 'E2E',
  message: string
) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO orchestrator_logs (timestamp, level, source, message) VALUES (?, ?, ?, ?)'
  ).run(now, level, source, message);
  // Keep latest 120 logs
  db.exec(`
    DELETE FROM orchestrator_logs
    WHERE id NOT IN (SELECT id FROM orchestrator_logs ORDER BY id DESC LIMIT 120)
  `);
}

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function safeCompareToken(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Migrate legacy hub_state.json once if runtime_sessions is empty
function migrateLegacyStateIfNeeded() {
  const countRow = db
    .prepare('SELECT COUNT(*) as cnt FROM runtime_sessions')
    .get() as { cnt: number };
  if (countRow.cnt > 0) return;

  let migratedEmail = 'chu.maitv99@gmail.com';
  let migratedName = 'Chu Mai';
  let migratedAvatar: string | null = null;

  if (fs.existsSync(LEGACY_STATE_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, 'utf-8'));
      if (Array.isArray(parsed.colabAccounts) && parsed.colabAccounts.length > 0) {
        const first = parsed.colabAccounts[0];
        if (first.email) migratedEmail = first.email;
        if (first.displayName) migratedName = first.displayName;
        if (first.avatarUrl) migratedAvatar = first.avatarUrl;
      }
    } catch {
      // Ignore legacy parse error
    }
  }

  db.prepare(
    `INSERT INTO runtime_sessions (
      session_id, account_email, display_name, avatar_url, hardware_target,
      state, cli_binary_available, adc_authenticated, worker_connected,
      vram_total_gb, compute_units_used, compute_units_limit
    ) VALUES (?, ?, ?, ?, 'tpu_v5e', 'DISCONNECTED', 0, 0, 0, 16.0, 0, 100)`
  ).run('wan-worker', migratedEmail, migratedName, migratedAvatar);

  appendOrchestratorLog(
    'INFO',
    'QUEUE',
    `Khởi tạo cơ sở dữ liệu SQLite (.data/wan_orchestrator.db) ưu tiên TPU v5e-1 (16GB HBM) cho tài khoản ${migratedEmail}.`
  );
}

migrateLegacyStateIfNeeded();

// Ensure existing persisted sessions favor TPU v5e-1 (16GB HBM) by default over legacy T4/L4 defaults
const tpuMigrationApplied = getSetting('tpu_v5e_default_migrated_v1', 'false');
if (tpuMigrationApplied !== 'true') {
  db.prepare(
    `UPDATE runtime_sessions
     SET hardware_target = 'tpu_v5e', vram_total_gb = 16.0
     WHERE session_id = 'wan-worker' AND hardware_target IN ('t4', 'l4')`
  ).run();
  setSetting('tpu_v5e_default_migrated_v1', 'true');
  appendOrchestratorLog(
    'INFO',
    'CLI',
    'Đã chuyển cấu hình mặc định Colab Runtime Orchestrator sang TPU v5e-1 (--tpu v5e-1 · 16GB HBM · torch_xla bfloat16).'
  );
}

// Reset transient worker connection state on fresh server boot and purge any legacy mock jobs/logs
db.prepare(
  `UPDATE runtime_sessions
   SET state = 'DISCONNECTED', worker_connected = 0, worker_id = NULL,
       gpu_name_reported = NULL, vram_used_gb = NULL, vram_is_measured = 0,
       cli_binary_available = 0, adc_authenticated = 0, compute_units_used = 0
   WHERE session_id = 'wan-worker'`
).run();
db.exec("DELETE FROM video_jobs WHERE is_mock = 1");
const purgedFakeLogs = getSetting('purged_demo_logs_v1', 'false');
if (purgedFakeLogs !== 'true') {
  db.exec('DELETE FROM orchestrator_logs');
  setSetting('purged_demo_logs_v1', 'true');
  appendOrchestratorLog(
    'WARN',
    'CLI',
    'Chẩn đoán thực tế trên server: Container Linux hiện tại không có pip/gcloud/google-colab-cli (/usr/bin/python3: No module named pip) và chưa có ADC refresh_token thực. Để chạy TPU v5e-1 thật, hãy mở Notebook hoặc chạy bootstrap.py trên Google Colab TPU v5e-1 để nối WebSocket về Hub.'
  );
}

// ============================================================================
// DATABASE READ/WRITE HELPERS
// ============================================================================
function getPrimarySession(): ColabRuntimeSession {
  const row = db
    .prepare('SELECT * FROM runtime_sessions ORDER BY rowid ASC LIMIT 1')
    .get() as Record<string, any> | undefined;

  const hwTarget: HardwareTargetId = (row?.hardware_target as HardwareTargetId) || 'tpu_v5e';
  const hwProfile = HARDWARE_PROFILES[hwTarget] || HARDWARE_PROFILES.tpu_v5e;
  const activeJobsRow = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM video_jobs WHERE status IN ('QUEUED', 'DISPATCHED', 'DIFFUSING', 'ENCODING')"
    )
    .get() as { cnt: number };

  if (!row) {
    return {
      sessionId: 'wan-worker',
      accountEmail: 'Chưa đăng nhập',
      displayName: 'Chưa kết nối',
      hardwareTarget: 'tpu_v5e',
      hardwareLabel: hwProfile.label,
      state: 'DISCONNECTED',
      cliBinaryAvailable: false,
      adcAuthenticated: false,
      workerConnected: false,
      workerId: null,
      gpuNameReported: null,
      vramUsedGb: null,
      vramTotalGb: hwProfile.vramTotalGb,
      vramIsMeasured: false,
      computeUnitsUsed: 0,
      computeUnitsLimit: 100,
      activeJobsCount: activeJobsRow.cnt,
      completedJobsCount: 0,
      lastHeartbeatAt: null,
      startedAt: null,
      lastError: null,
    };
  }

  return {
    sessionId: String(row.session_id),
    accountEmail: String(row.account_email),
    displayName: String(row.display_name),
    avatarUrl: row.avatar_url ? String(row.avatar_url) : undefined,
    hardwareTarget: hwTarget,
    hardwareLabel: hwProfile.label,
    state: row.state as ColabRuntimeSession['state'],
    cliBinaryAvailable: Boolean(row.cli_binary_available),
    adcAuthenticated: Boolean(row.adc_authenticated),
    workerConnected: Boolean(row.worker_connected),
    workerId: row.worker_id ? String(row.worker_id) : null,
    gpuNameReported: row.gpu_name_reported ? String(row.gpu_name_reported) : null,
    vramUsedGb: row.vram_used_gb !== null && row.vram_used_gb !== undefined ? Number(row.vram_used_gb) : null,
    vramTotalGb: Number(row.vram_total_gb || hwProfile.vramTotalGb),
    vramIsMeasured: Boolean(row.vram_is_measured),
    computeUnitsUsed: Number(row.compute_units_used || 0),
    computeUnitsLimit: row.compute_units_limit !== null ? Number(row.compute_units_limit) : null,
    activeJobsCount: activeJobsRow.cnt,
    completedJobsCount: Number(row.completed_jobs_count || 0),
    lastHeartbeatAt: row.last_heartbeat_at ? String(row.last_heartbeat_at) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
  };
}

function mapRowToVideoJob(row: Record<string, any>): VideoJob {
  let metrics = calculateFastWanMetrics({
    model: row.model as WanModelId,
    hardwareTarget: row.hardware_target as HardwareTargetId,
    resolution: row.resolution as '480p' | '720p',
    aspectRatio: row.aspect_ratio as '16:9' | '9:16' | '1:1',
    durationSec: Number(row.duration_sec || 4),
    fps: Number(row.fps || 16) as 16 | 24,
    inferenceSteps: Number(row.inference_steps || 3),
  });
  try {
    if (row.metrics_json) {
      metrics = JSON.parse(String(row.metrics_json));
    }
  } catch {
    // Use calculated fallback
  }

  return {
    id: String(row.id),
    sceneIndex: row.scene_index !== null ? Number(row.scene_index) : undefined,
    batchId: row.batch_id ? String(row.batch_id) : undefined,
    prompt: String(row.prompt),
    enhancedPrompt: row.enhanced_prompt ? String(row.enhanced_prompt) : undefined,
    thinkingSummary: row.thinking_summary ? String(row.thinking_summary) : undefined,
    negativePrompt: String(row.negative_prompt),
    presetId: (row.preset_id as CommercialPresetId) || 'fastwan-turbo',
    model: (row.model as WanModelId) || 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers',
    hardwareTarget: (row.hardware_target as HardwareTargetId) || 'tpu_v5e',
    resolution: (row.resolution as '480p' | '720p') || '480p',
    aspectRatio: (row.aspect_ratio as '16:9' | '9:16' | '1:1') || '16:9',
    durationSec: Number(row.duration_sec || 4),
    fps: Number(row.fps || 16) as 16 | 24,
    inferenceSteps: Number(row.inference_steps || 3),
    guidanceScale: Number(row.guidance_scale ?? 1.0),
    flowShift: Number(row.flow_shift || 3.0),
    cameraMotion: (row.camera_motion as CameraMotionType) || 'dolly_in',
    seed: Number(row.seed || 42),
    lockXlaShape: Boolean(row.lock_xla_shape),
    vaeTiling: Boolean(row.vae_tiling),
    vaeSlicing: Boolean(row.vae_slicing),
    status: row.status as VideoJob['status'],
    progressPct: Number(row.progress_pct || 0),
    currentStep: Number(row.current_step || 0),
    workerId: String(row.worker_id || 'Đang chờ Worker'),
    accountEmail: String(row.account_email || 'Chưa kết nối'),
    retryCount: Number(row.retry_count || 0),
    maxRetries: Number(row.max_retries || 2),
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
    isMock: Boolean(row.is_mock),
    actualInferenceSec:
      row.actual_inference_sec !== null && row.actual_inference_sec !== undefined
        ? Number(row.actual_inference_sec)
        : null,
    measuredVramGb:
      row.measured_vram_gb !== null && row.measured_vram_gb !== undefined
        ? Number(row.measured_vram_gb)
        : null,
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
    videoUrl: row.video_url ? String(row.video_url) : undefined,
    fileSizeBytes:
      row.file_size_bytes !== null && row.file_size_bytes !== undefined
        ? Number(row.file_size_bytes)
        : undefined,
    error: row.error ? String(row.error) : undefined,
    metrics,
  };
}

function listAllVideoJobs(): VideoJob[] {
  const rows = db
    .prepare('SELECT * FROM video_jobs ORDER BY created_at DESC LIMIT 100')
    .all() as Array<Record<string, any>>;
  return rows.map(mapRowToVideoJob);
}

function getVideoJobById(id: string): VideoJob | null {
  const row = db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(id) as
    | Record<string, any>
    | undefined;
  return row ? mapRowToVideoJob(row) : null;
}

function listApiKeys() {
  const rows = db
    .prepare('SELECT * FROM api_keys ORDER BY created_at DESC')
    .all() as Array<Record<string, any>>;
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    prefix: String(r.prefix),
    maskedKey: String(r.masked_key),
    rpmLimit: Number(r.rpm_limit),
    scopes: JSON.parse(String(r.scopes_json || '["all"]')),
    createdAt: String(r.created_at),
    expiresInDays: Number(r.expires_in_days),
    requestsCount: Number(r.requests_count),
  }));
}

function listOrchestratorLogs() {
  return db
    .prepare('SELECT id, timestamp, level, source, message FROM orchestrator_logs ORDER BY id DESC LIMIT 60')
    .all();
}

// ============================================================================
// GOOGLE COLAB CLI ORCHESTRATOR (REAL HOST BINARY & ADC CHECK)
// ============================================================================
let activeColabExecProcess: ChildProcess | null = null;

// Clean up any leftover demo bin directory if present
const legacyDemoBinDir = path.join(DATA_DIR, 'bin');
if (fs.existsSync(legacyDemoBinDir)) {
  try {
    fs.rmSync(legacyDemoBinDir, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

function isRealAdcCredentialsFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (raw.includes('auto_provisioned_colab_adc_secret') || raw.includes('1//0g_auto_adc_')) {
      fs.unlinkSync(filePath);
      return false;
    }
    const parsed = JSON.parse(raw);
    return Boolean(
      parsed &&
        parsed.type === 'authorized_user' &&
        parsed.client_id &&
        parsed.client_secret &&
        parsed.refresh_token
    );
  } catch {
    return false;
  }
}

async function detectColabCliEnvironment(): Promise<{
  cliBinaryAvailable: boolean;
  cliBinaryPath: string | null;
  adcAuthenticated: boolean;
  adcPath: string | null;
}> {
  let cliBinaryPath: string | null = null;
  try {
    const { stdout } = await execFileAsync('which', ['colab']);
    if (stdout && stdout.trim() && !stdout.includes('.data/bin/colab')) {
      cliBinaryPath = stdout.trim();
    }
  } catch {
    cliBinaryPath = null;
  }

  const defaultGcloudAdc = path.join(
    process.env.HOME || '/root',
    '.config/gcloud/application_default_credentials.json'
  );
  let adcPath: string | null = null;
  if (isRealAdcCredentialsFile(ADC_CREDENTIALS_PATH)) {
    adcPath = ADC_CREDENTIALS_PATH;
  } else if (isRealAdcCredentialsFile(defaultGcloudAdc)) {
    adcPath = defaultGcloudAdc;
  }

  db.prepare(
    'UPDATE runtime_sessions SET cli_binary_available = ?, adc_authenticated = ?'
  ).run(cliBinaryPath ? 1 : 0, adcPath ? 1 : 0);

  return {
    cliBinaryAvailable: Boolean(cliBinaryPath),
    cliBinaryPath,
    adcAuthenticated: Boolean(adcPath),
    adcPath,
  };
}

function writeBootstrapScriptToDisk(options: {
  serverUrl: string;
  workerId: string;
  modelId: WanModelId;
  hardwareTarget?: HardwareTargetId;
}): string {
  const hwTarget: HardwareTargetId = options.hardwareTarget || 'tpu_v5e';
  const scriptContent = generateFastWanWorkerScript({
    serverUrl: options.serverUrl,
    workerId: options.workerId,
    workerToken: WORKER_AUTH_TOKEN,
    modelId: options.modelId,
    hardwareTarget: hwTarget,
  });
  fs.writeFileSync(BOOTSTRAP_SCRIPT_PATH, scriptContent, 'utf-8');
  fs.writeFileSync(LEGACY_BOOTSTRAP_SCRIPT_PATH, scriptContent, 'utf-8');
  return BOOTSTRAP_SCRIPT_PATH;
}

// Write initial TPU v5e-1 torch_xla bootstrap.py script on server startup
writeBootstrapScriptToDisk({
  serverUrl: process.env.APP_URL || `http://localhost:${PORT}`,
  workerId: 'colab-tpu_v5e-01',
  modelId: 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers',
  hardwareTarget: 'tpu_v5e',
});

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

// ============================================================================
// MAIN SERVER & WEBSOCKET WORKER HUB
// ============================================================================
async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Requested-With, X-Wan-Studio-Session'
    );
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 100 * 1024 * 1024 });
  const liveSockets = new Map<string, WebSocket>();
  const colabWorkers = new Map<string, ColabWorkerSnapshot>();
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

  function getBaseAppUrl(req?: express.Request): string {
    if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
    if (req) {
      return `${req.protocol}://${req.get('host') || `localhost:${PORT}`}`;
    }
    return `http://localhost:${PORT}`;
  }

  // Dispatch next queued job from SQLite to an available online worker
  function dispatchNextQueuedJobToWorker(workerId: string) {
    const ws = liveSockets.get(workerId);
    const worker = colabWorkers.get(workerId);
    if (!ws || ws.readyState !== WebSocket.OPEN || !worker) return;
    if (worker.activeRequests >= worker.maxConcurrency) return;

    const nextRow = db
      .prepare("SELECT * FROM video_jobs WHERE status = 'QUEUED' ORDER BY created_at ASC LIMIT 1")
      .get() as Record<string, any> | undefined;
    if (!nextRow) return;

    const job = mapRowToVideoJob(nextRow);
    const leaseTimeoutSec = Number(getSetting('lease_timeout_sec', '180'));
    const leaseExpiresAt = new Date(Date.now() + leaseTimeoutSec * 1000).toISOString();

    db.prepare(
      `UPDATE video_jobs
       SET status = 'DISPATCHED', progress_pct = 5, worker_id = ?, account_email = ?, lease_expires_at = ?
       WHERE id = ?`
    ).run(workerId, worker.accountEmail, leaseExpiresAt, job.id);

    worker.activeRequests += 1;
    worker.status = 'BUSY';
    worker.lastSeen = new Date().toISOString();
    db.prepare("UPDATE runtime_sessions SET state = 'BUSY' WHERE session_id = 'wan-worker'").run();

    ws.send(
      JSON.stringify({
        type: 'video_generate',
        request_id: job.id,
        payload: {
          model: job.model,
          prompt: job.enhancedPrompt || job.prompt,
          negative_prompt: job.negativePrompt,
          width: job.metrics.width,
          height: job.metrics.height,
          num_frames: job.metrics.latentFrames,
          inference_steps: job.inferenceSteps,
          guidance_scale: job.guidanceScale,
          flow_shift: job.flowShift,
          fps: job.fps,
          seed: job.seed,
          lock_xla_shape: job.lockXlaShape,
          vae_tiling: job.vaeTiling,
          vae_slicing: job.vaeSlicing,
        },
      })
    );

    appendOrchestratorLog(
      'INFO',
      'QUEUE',
      `Đã giao job ${job.id} (${job.model}, ${job.metrics.width}x${job.metrics.height}, ${job.inferenceSteps} steps) cho worker ${workerId}.`
    );
  }

  // ============================================================================
  // P1: LEASE TIMEOUT & HEARTBEAT WATCHDOG (Every 5 seconds)
  // ============================================================================
  setInterval(() => {
    const nowIso = new Date().toISOString();
    const expiredRows = db
      .prepare(
        `SELECT * FROM video_jobs
         WHERE status IN ('DISPATCHED', 'DIFFUSING', 'ENCODING')
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at < ?`
      )
      .all(nowIso) as Array<Record<string, any>>;

    for (const row of expiredRows) {
      const job = mapRowToVideoJob(row);
      if (job.retryCount < job.maxRetries) {
        const nextRetry = job.retryCount + 1;
        db.prepare(
          `UPDATE video_jobs
           SET status = 'QUEUED', progress_pct = 0, current_step = 0,
               retry_count = ?, lease_expires_at = NULL,
               error = ?
           WHERE id = ?`
        ).run(
          nextRetry,
          `Tự động khôi phục (Retry ${nextRetry}/${job.maxRetries}) do hết hạn lease từ worker ${job.workerId}`,
          job.id
        );
        appendOrchestratorLog(
          'WARN',
          'QUEUE',
          `Job ${job.id} quá hạn lease -> Đưa về QUEUED (Retry ${nextRetry}/${job.maxRetries}).`
        );
      } else {
        db.prepare(
          `UPDATE video_jobs
           SET status = 'FAILED', completed_at = ?, lease_expires_at = NULL,
               error = 'Worker mất phản hồi quá giới hạn retry cho phép.'
           WHERE id = ?`
        ).run(nowIso, job.id);
        appendOrchestratorLog(
          'ERROR',
          'QUEUE',
          `Job ${job.id} thất bại sau ${job.maxRetries} lần retry do mất kết nối worker.`
        );
        const failedJob = getVideoJobById(job.id);
        if (failedJob) notifyJobWaiters(failedJob);
      }
    }
  }, 5000);

  // ============================================================================
  // P0: AUTHENTICATED WEBSOCKET UPGRADE & WORKER HUB
  // ============================================================================
  httpServer.on('upgrade', (request, socket, head) => {
    const parsedUrl = new URL(
      request.url || '/',
      `http://${request.headers.host || 'localhost'}`
    );
    if (
      parsedUrl.pathname === '/api/colab/ws/worker' ||
      parsedUrl.pathname === '/api/llm/ws/worker'
    ) {
      const authHeader = String(request.headers.authorization || '');
      const bearerToken = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : parsedUrl.searchParams.get('token') || '';

      if (!safeCompareToken(bearerToken, WORKER_AUTH_TOKEN)) {
        appendOrchestratorLog(
          'WARN',
          'AUTH',
          `Từ chối kết nối WebSocket trái phép từ ${request.socket.remoteAddress} (Token không hợp lệ).`
        );
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    let registeredWorkerId: string | null = null;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // 1. Initial Worker Registration (Requires matching WORKER_AUTH_TOKEN)
        if (msg.worker_id && !registeredWorkerId) {
          if (!safeCompareToken(String(msg.token || ''), WORKER_AUTH_TOKEN)) {
            appendOrchestratorLog(
              'WARN',
              'AUTH',
              `Worker ${msg.worker_id} gửi token đăng ký không hợp lệ -> Ngắt kết nối.`
            );
            ws.close(1008, 'Invalid worker token');
            return;
          }

          registeredWorkerId = String(msg.worker_id);
          liveSockets.set(registeredWorkerId, ws);

          const session = getPrimarySession();
          const hwTarget: HardwareTargetId =
            (msg.hardware_target as HardwareTargetId) || session.hardwareTarget || 'tpu_v5e';
          const isMeasured = Boolean(msg.vram_is_measured);

          const workerSnapshot: ColabWorkerSnapshot = {
            workerId: registeredWorkerId,
            sessionId: 'wan-worker',
            accountEmail: String(msg.email || session.accountEmail),
            model: String(msg.model || 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers'),
            hardwareTarget: hwTarget,
            torchDtype: String(msg.torch_dtype || HARDWARE_PROFILES[hwTarget].torchDtype),
            capabilities: Array.isArray(msg.capabilities) ? msg.capabilities : ['t2v', 'vae_tiling'],
            gpuName: String(msg.gpu_name || HARDWARE_PROFILES[hwTarget].label),
            vramUsedGb: Number(msg.vram_used_gb || 8.2),
            vramTotalGb: Number(msg.vram_total_gb || HARDWARE_PROFILES[hwTarget].vramTotalGb),
            vramIsMeasured: isMeasured,
            maxConcurrency: Number(msg.max_concurrency || 1),
            activeRequests: 0,
            connectedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            status: 'ONLINE',
          };

          colabWorkers.set(registeredWorkerId, workerSnapshot);

          if (!registeredWorkerId.startsWith('mock-')) {
            db.prepare(
              `UPDATE runtime_sessions
               SET state = 'READY', worker_connected = 1, worker_id = ?,
                   gpu_name_reported = ?, vram_used_gb = ?, vram_total_gb = ?,
                   vram_is_measured = ?, last_heartbeat_at = ?,
                   started_at = COALESCE(started_at, ?), last_error = NULL
               WHERE session_id = 'wan-worker'`
            ).run(
              registeredWorkerId,
              workerSnapshot.gpuName,
              workerSnapshot.vramUsedGb,
              workerSnapshot.vramTotalGb,
              isMeasured ? 1 : 0,
              new Date().toISOString(),
              new Date().toISOString()
            );
          }

          appendOrchestratorLog(
            'INFO',
            'WORKER_HUB',
            `Worker ${registeredWorkerId} đã kết nối (${workerSnapshot.gpuName}, ${workerSnapshot.torchDtype}).`
          );

          dispatchNextQueuedJobToWorker(registeredWorkerId);
          return;
        }

        // 2. Worker Heartbeat & Live GPU Telemetry
        if (msg.type === 'heartbeat' && registeredWorkerId) {
          const w = colabWorkers.get(registeredWorkerId);
          const nowIso = new Date().toISOString();
          if (w) {
            w.lastSeen = nowIso;
            if (msg.gpu_name) w.gpuName = String(msg.gpu_name);
            if (msg.vram_used_gb !== undefined) w.vramUsedGb = Number(msg.vram_used_gb);
            if (msg.vram_total_gb !== undefined) w.vramTotalGb = Number(msg.vram_total_gb);
            if (msg.vram_is_measured !== undefined) w.vramIsMeasured = Boolean(msg.vram_is_measured);
          }
          if (!registeredWorkerId.startsWith('mock-')) {
            db.prepare(
              `UPDATE runtime_sessions
               SET last_heartbeat_at = ?, gpu_name_reported = COALESCE(?, gpu_name_reported),
                   vram_used_gb = COALESCE(?, vram_used_gb), vram_is_measured = ?
               WHERE session_id = 'wan-worker'`
            ).run(
              nowIso,
              msg.gpu_name ? String(msg.gpu_name) : null,
              msg.vram_used_gb !== undefined ? Number(msg.vram_used_gb) : null,
              msg.vram_is_measured ? 1 : 0
            );
          }
          return;
        }

        // 3. Step Progress Callback (Extends Lease Timeout)
        if (msg.type === 'job_progress' && msg.request_id) {
          const job = getVideoJobById(String(msg.request_id));
          if (job) {
            const currentStep = Number(msg.step || job.currentStep);
            const totalSteps = Math.max(1, Number(msg.total_steps || job.inferenceSteps));
            const pct = Math.min(95, Math.round((currentStep / totalSteps) * 95));
            const leaseTimeoutSec = Number(getSetting('lease_timeout_sec', '180'));
            const newLease = new Date(Date.now() + leaseTimeoutSec * 1000).toISOString();

            db.prepare(
              `UPDATE video_jobs
               SET status = 'DIFFUSING', current_step = ?, progress_pct = ?, lease_expires_at = ?
               WHERE id = ?`
            ).run(currentStep, pct, newLease, job.id);
          }
          return;
        }

        // 4. Job Result with MP4 Integrity Verification
        if (msg.type === 'job_result' && msg.request_id) {
          const jobId = String(msg.request_id);
          const job = getVideoJobById(jobId);
          if (!job) return;

          if (!msg.video_base64 || typeof msg.video_base64 !== 'string') {
            db.prepare(
              `UPDATE video_jobs SET status = 'FAILED', error = 'Worker không trả về dữ liệu video_base64.', lease_expires_at = NULL WHERE id = ?`
            ).run(jobId);
            return;
          }

          const videoBuffer = Buffer.from(msg.video_base64, 'base64');
          if (!isValidMp4Buffer(videoBuffer)) {
            db.prepare(
              `UPDATE video_jobs SET status = 'FAILED', error = 'File MP4 nhận từ worker bị hỏng (thiếu ftyp header).', lease_expires_at = NULL WHERE id = ?`
            ).run(jobId);
            appendOrchestratorLog(
              'ERROR',
              'WORKER_HUB',
              `Job ${jobId} bị từ chối do dữ liệu MP4 không hợp lệ (${videoBuffer.length} bytes).`
            );
            return;
          }

          const mp4FilePath = path.join(VIDEOS_DIR, `${job.id}.mp4`);
          fs.writeFileSync(mp4FilePath, videoBuffer);
          const completedAt = new Date().toISOString();
          const actualSec =
            msg.actual_inference_sec !== undefined ? Number(msg.actual_inference_sec) : null;
          const measuredVram =
            msg.measured_vram_gb !== undefined && msg.measured_vram_gb !== null
              ? Number(msg.measured_vram_gb)
              : null;

          db.prepare(
            `UPDATE video_jobs
             SET status = 'COMPLETED', progress_pct = 100, current_step = inference_steps,
                 completed_at = ?, video_url = ?, file_size_bytes = ?,
                 actual_inference_sec = ?, measured_vram_gb = ?, lease_expires_at = NULL, error = NULL
             WHERE id = ?`
          ).run(
            completedAt,
            `/v1/videos/${job.id}.mp4`,
            videoBuffer.length,
            actualSec,
            measuredVram,
            job.id
          );

          // Update session telemetry & compute units
          const hwProfile = HARDWARE_PROFILES[job.hardwareTarget] || HARDWARE_PROFILES.tpu_v5e;
          const cuDelta = Number(
            (((actualSec || job.metrics.estimatedDurationSec) / 3600) * hwProfile.computeUnitsPerHour).toFixed(4)
          );
          db.prepare(
            `UPDATE runtime_sessions
             SET state = 'READY', completed_jobs_count = completed_jobs_count + 1,
                 compute_units_used = ROUND(compute_units_used + ?, 4),
                 vram_used_gb = COALESCE(?, vram_used_gb),
                 vram_is_measured = CASE WHEN ? IS NOT NULL THEN 1 ELSE vram_is_measured END
             WHERE session_id = 'wan-worker'`
          ).run(cuDelta, measuredVram, measuredVram);

          if (registeredWorkerId) {
            const w = colabWorkers.get(registeredWorkerId);
            if (w) {
              w.activeRequests = Math.max(0, w.activeRequests - 1);
              w.status = 'ONLINE';
              w.lastSeen = completedAt;
            }
          }

          appendOrchestratorLog(
            'INFO',
            'QUEUE',
            `Hoàn tất job ${job.id} (${(videoBuffer.length / 1024).toFixed(1)} KB MP4${
              actualSec ? `, ${actualSec}s` : ''
            }).`
          );

          const finishedJob = getVideoJobById(job.id);
          if (finishedJob) notifyJobWaiters(finishedJob);

          if (registeredWorkerId) {
            dispatchNextQueuedJobToWorker(registeredWorkerId);
          }
          return;
        }

        // 5. Job Error with Automatic Retry if under Max Retries
        if (msg.type === 'job_error' && msg.request_id) {
          const jobId = String(msg.request_id);
          const job = getVideoJobById(jobId);
          if (job) {
            const errStr = String(msg.error || 'Worker execution error');
            if (job.retryCount < job.maxRetries) {
              const nextRetry = job.retryCount + 1;
              db.prepare(
                `UPDATE video_jobs
                 SET status = 'QUEUED', progress_pct = 0, current_step = 0,
                     retry_count = ?, lease_expires_at = NULL, error = ?
                 WHERE id = ?`
              ).run(nextRetry, `Retry ${nextRetry}/${job.maxRetries} sau lỗi: ${errStr}`, job.id);
              appendOrchestratorLog(
                'WARN',
                'QUEUE',
                `Job ${job.id} báo lỗi (${errStr}) -> Tự động đưa lại vào hàng đợi (Retry ${nextRetry}/${job.maxRetries}).`
              );
            } else {
              db.prepare(
                `UPDATE video_jobs
                 SET status = 'FAILED', completed_at = ?, lease_expires_at = NULL, error = ?
                 WHERE id = ?`
              ).run(new Date().toISOString(), errStr, job.id);
              appendOrchestratorLog('ERROR', 'QUEUE', `Job ${job.id} thất bại: ${errStr}`);
              const failedJob = getVideoJobById(job.id);
              if (failedJob) notifyJobWaiters(failedJob);
            }

            if (registeredWorkerId) {
              const w = colabWorkers.get(registeredWorkerId);
              if (w) {
                w.activeRequests = Math.max(0, w.activeRequests - 1);
                w.status = 'ONLINE';
                w.lastSeen = new Date().toISOString();
              }
              dispatchNextQueuedJobToWorker(registeredWorkerId);
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
        colabWorkers.delete(registeredWorkerId);

        // Immediately recover any in-flight jobs assigned to this disconnected worker
        const inFlight = db
          .prepare(
            "SELECT * FROM video_jobs WHERE worker_id = ? AND status IN ('DISPATCHED', 'DIFFUSING', 'ENCODING')"
          )
          .all(registeredWorkerId) as Array<Record<string, any>>;

        for (const row of inFlight) {
          const job = mapRowToVideoJob(row);
          if (job.retryCount < job.maxRetries) {
            const nextRetry = job.retryCount + 1;
            db.prepare(
              `UPDATE video_jobs
               SET status = 'QUEUED', progress_pct = 0, current_step = 0,
                   retry_count = ?, lease_expires_at = NULL,
                   error = ?
               WHERE id = ?`
            ).run(
              nextRetry,
              `Worker ${registeredWorkerId} ngắt kết nối -> Đã tự động đưa về QUEUED (Retry ${nextRetry}/${job.maxRetries}).`,
              job.id
            );
          } else {
            db.prepare(
              `UPDATE video_jobs
               SET status = 'FAILED', completed_at = ?, lease_expires_at = NULL,
                   error = ?
               WHERE id = ?`
            ).run(
              new Date().toISOString(),
              `Worker ${registeredWorkerId} ngắt kết nối khi đang xử lý.`,
              job.id
            );
            const failed = getVideoJobById(job.id);
            if (failed) notifyJobWaiters(failed);
          }
        }

        if (colabWorkers.size === 0) {
          db.prepare(
            `UPDATE runtime_sessions
             SET state = 'DISCONNECTED', worker_connected = 0, worker_id = NULL,
                 gpu_name_reported = NULL, vram_used_gb = NULL, vram_is_measured = 0
             WHERE session_id = 'wan-worker'`
          ).run();
        }
        appendOrchestratorLog('WARN', 'WORKER_HUB', `Worker ${registeredWorkerId} đã ngắt kết nối.`);
      }
    });
  });

  // ============================================================================
  // P0: API KEY AUTHENTICATION MIDDLEWARE FOR EXTERNAL /v1/* CALLS
  // ============================================================================
  const verifyApiKeyMiddleware: express.RequestHandler = (req, res, next) => {
    const enforceApiKey = getSetting('enforce_api_key', 'true') === 'true';
    const studioHeader = req.headers['x-wan-studio-session'];

    // Allow internal requests from the WAN Studio React UI
    if (studioHeader === STUDIO_SESSION_TOKEN) {
      next();
      return;
    }

    const authHeader = String(req.headers.authorization || '');
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      const tokenHash = hashSecret(token);
      const keyRow = db
        .prepare('SELECT * FROM api_keys WHERE key_hash = ?')
        .get(tokenHash) as Record<string, any> | undefined;

      if (keyRow) {
        db.prepare('UPDATE api_keys SET requests_count = requests_count + 1 WHERE id = ?').run(
          keyRow.id
        );
        next();
        return;
      }

      if (enforceApiKey) {
        res.status(401).json({
          error: 'API Key không hợp lệ hoặc đã bị thu hồi. Hãy tạo API Key trong mục Cài đặt.',
        });
        return;
      }
    } else if (enforceApiKey) {
      res.status(401).json({
        error:
          'Thiếu header Authorization: Bearer <sk-wan-...>. Hãy truyền API Key hợp lệ hoặc tắt bắt buộc API Key trong mục Cài đặt.',
      });
      return;
    }

    next();
  };

  // ============================================================================
  // EXTERNAL & STUDIO VIDEO GENERATION ROUTES (/v1/*)
  // ============================================================================
  app.get('/v1/models', (req, res) => {
    const baseUrl = getBaseAppUrl(req);
    res.json({
      object: 'list',
      onlineWorkers: colabWorkers.size,
      endpoints: {
        createVideo: `${baseUrl}/v1/video/generations`,
        batchScenes: `${baseUrl}/v1/video/scenes/batch`,
        getJobStatus: `${baseUrl}/v1/video/generations/{job_id}`,
        streamMp4: `${baseUrl}/v1/videos/{job_id}.mp4`,
      },
      hardware_profiles: Object.values(HARDWARE_PROFILES),
      data: Object.values(WAN_MODEL_ADAPTERS).map((adapter) => ({
        id: adapter.id,
        object: 'model',
        label: adapter.label,
        family: adapter.family,
        distilled: adapter.distilled,
        default_parameters: {
          width: adapter.defaultWidth16x9,
          height: adapter.defaultHeight16x9,
          num_frames: adapter.defaultFrames,
          fps: adapter.defaultFps,
          num_inference_steps: adapter.defaultSteps,
          guidance_scale: adapter.defaultGuidanceScale,
          flow_shift: adapter.defaultFlowShift,
        },
        notes: adapter.notesVi,
      })),
    });
  });

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

  app.get('/v1/video/generations/:id', (req, res) => {
    const job = getVideoJobById(req.params.id);
    if (!job) {
      res.status(404).json({ error: `Không tìm thấy job ID '${req.params.id}'.` });
      return;
    }
    const baseUrl = getBaseAppUrl(req);
    const absoluteVideoUrl = job.videoUrl ? `${baseUrl}${job.videoUrl}` : null;

    res.json({
      id: job.id,
      object: 'video.generation',
      status: job.status,
      is_mock: job.isMock,
      progress_pct: job.progressPct,
      current_step: job.currentStep,
      total_steps: job.inferenceSteps,
      retry_count: job.retryCount,
      max_retries: job.maxRetries,
      lease_expires_at: job.leaseExpiresAt,
      model: job.model,
      hardware_target: job.hardwareTarget,
      prompt: job.prompt,
      enhanced_prompt: job.enhancedPrompt || null,
      negative_prompt: job.negativePrompt,
      camera_motion: job.cameraMotion,
      seed: job.seed,
      flow_shift: job.flowShift,
      width: job.metrics.width,
      height: job.metrics.height,
      num_frames: job.metrics.latentFrames,
      fps: job.fps,
      actual_inference_sec: job.actualInferenceSec || null,
      measured_vram_gb: job.measuredVramGb || null,
      video_url: absoluteVideoUrl,
      download_url: absoluteVideoUrl ? `${absoluteVideoUrl}?download=1` : null,
      file_size_bytes: job.fileSizeBytes || null,
      error: job.error || null,
      created_at: job.createdAt,
      completed_at: job.completedAt || null,
      job,
    });
  });

  app.get('/v1/video/generations', (req, res) => {
    const baseUrl = getBaseAppUrl(req);
    const statusFilter = req.query.status ? String(req.query.status).toUpperCase() : null;
    const batchFilter = req.query.batchId ? String(req.query.batchId) : null;

    let list = listAllVideoJobs();
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

  async function createAndEnqueueJob(
    body: Record<string, any>,
    sceneIndex?: number,
    batchId?: string
  ): Promise<VideoJob> {
    const session = getPrimarySession();
    const rawModel = String(body.model || 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers');
    const model: WanModelId =
      rawModel in WAN_MODEL_ADAPTERS
        ? (rawModel as WanModelId)
        : 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers';
    const adapter = WAN_MODEL_ADAPTERS[model];

    const hardwareTarget: HardwareTargetId =
      body.hardwareTarget || body.hardware_target || session.hardwareTarget || 'tpu_v5e';
    const rawPrompt = String(body.prompt || '').trim();
    const cameraMotion: CameraMotionType =
      body.cameraMotion || body.camera_motion || 'dolly_in';
    const negativePrompt =
      body.negativePrompt ||
      body.negative_prompt ||
      'Bright tones, overexposed, static, blurred details, subtitles, worst quality, low quality';
    const presetId: CommercialPresetId = body.presetId || body.preset_id || 'fastwan-turbo';
    const resolution: '480p' | '720p' = body.resolution === '720p' ? '720p' : '480p';
    const aspectRatio: '16:9' | '9:16' | '1:1' =
      body.aspectRatio || body.aspect_ratio || '16:9';
    const durationSec = Number(
      body.durationSec || body.duration_sec || (adapter.distilled ? 4 : 5)
    );
    const fps: 16 | 24 = Number(body.fps) === 24 ? 24 : adapter.defaultFps;
    const inferenceSteps = Number(
      body.inferenceSteps || body.num_inference_steps || body.steps || adapter.defaultSteps
    );
    const guidanceScale = Number(
      body.guidanceScale ?? body.guidance_scale ?? body.cfg ?? adapter.defaultGuidanceScale
    );
    const flowShift = Number(
      body.flowShift || body.flow_shift || adapter.defaultFlowShift
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
        : hardwareTarget === 'tpu_v5e';
    const vaeTiling = body.vaeTiling !== undefined ? Boolean(body.vaeTiling) : true;
    const vaeSlicing = body.vaeSlicing !== undefined ? Boolean(body.vaeSlicing) : true;
    const isMock = Boolean(body.isMock || body.is_mock);
    const shouldEnhancePrompt = Boolean(body.enhancePrompt || body.enhance_prompt);

    const promptWithCamera = applyCameraMotionToPrompt(rawPrompt, cameraMotion);
    let finalEnhancedPrompt: string | undefined = body.enhancedPrompt;
    let thinkingSummary: string | undefined = body.thinkingSummary;

    if (shouldEnhancePrompt && !finalEnhancedPrompt && process.env.GEMINI_API_KEY) {
      try {
        const ai = getGeminiClient();
        const geminiRes = await ai.models.generateContent({
          model: 'gemini-4-carbon',
          contents: `Viết lại prompt tiếng Anh chuẩn điện ảnh cho mô hình ${model} theo công thức 4 phần: [Góc máy & chuyển động camera (${cameraMotion})] + [Chủ thể & hành động] + [Bối cảnh & ánh sáng] + [Phong cách màu phim 35mm]. Ý tưởng gốc: "${rawPrompt}". Chỉ trả về chuỗi prompt tiếng Anh duy nhất.`,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
          },
        });
        if (geminiRes.text && geminiRes.text.trim()) {
          finalEnhancedPrompt = geminiRes.text.trim();
          thinkingSummary = 'Đã tối ưu bởi Gemini 4 Carbon';
        }
      } catch {
        // Fallback to camera prompt
      }
    }

    const metrics = calculateFastWanMetrics({
      model,
      hardwareTarget,
      resolution,
      aspectRatio,
      durationSec,
      numFrames: body.numFrames || body.num_frames,
      fps,
      inferenceSteps,
      lockXlaShape,
    });

    const randomSuffix = Math.floor(100 + Math.random() * 900);
    const jobId = `job-wan-${Date.now().toString().slice(-5)}${randomSuffix}`;
    const maxRetries = Number(getSetting('max_job_retries', '2'));
    const createdAt = new Date().toISOString();

    db.prepare(
      `INSERT INTO video_jobs (
        id, scene_index, batch_id, prompt, enhanced_prompt, thinking_summary,
        negative_prompt, preset_id, model, hardware_target, resolution, aspect_ratio,
        duration_sec, fps, inference_steps, guidance_scale, flow_shift, camera_motion,
        seed, lock_xla_shape, vae_tiling, vae_slicing, status, progress_pct, current_step,
        worker_id, account_email, retry_count, max_retries, is_mock, created_at, metrics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', 0, 0, 'Đang chờ Worker', ?, 0, ?, ?, ?, ?)`
    ).run(
      jobId,
      sceneIndex ?? null,
      batchId ?? null,
      promptWithCamera,
      finalEnhancedPrompt ?? null,
      thinkingSummary ?? null,
      negativePrompt,
      presetId,
      model,
      hardwareTarget,
      resolution,
      aspectRatio,
      durationSec,
      fps,
      inferenceSteps,
      guidanceScale,
      flowShift,
      cameraMotion,
      seed,
      lockXlaShape ? 1 : 0,
      vaeTiling ? 1 : 0,
      vaeSlicing ? 1 : 0,
      session.accountEmail,
      maxRetries,
      isMock ? 1 : 0,
      createdAt,
      JSON.stringify(metrics)
    );

    // Find an available online worker and dispatch immediately
    for (const [workerId, w] of colabWorkers.entries()) {
      if (w.status === 'ONLINE' && w.activeRequests < w.maxConcurrency) {
        dispatchNextQueuedJobToWorker(workerId);
        break;
      }
    }

    return getVideoJobById(jobId)!;
  }

  const handleCreateVideoJob: express.RequestHandler = async (req, res) => {
    const body = req.body || {};
    const prompt = body.prompt;

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'Vui lòng nhập mô tả cảnh video (prompt).' });
      return;
    }

    const waitForCompletion = Boolean(body.wait || req.query.wait === 'true');
    const responseFormat = body.responseFormat || body.response_format || 'url';
    const newJob = await createAndEnqueueJob(body);
    const baseUrl = getBaseAppUrl(req);

    if (waitForCompletion) {
      const timeoutMs = Number(body.timeoutMs || 180000);
      const finishedJob = await new Promise<VideoJob>((resolve) => {
        const current = getVideoJobById(newJob.id) || newJob;
        if (current.status === 'COMPLETED' || current.status === 'FAILED') {
          resolve(current);
          return;
        }
        const timer = setTimeout(() => {
          resolve(getVideoJobById(newJob.id) || newJob);
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
        is_mock: finishedJob.isMock,
        video_url: fullVideoUrl,
        download_url: fullVideoUrl ? `${fullVideoUrl}?download=1` : null,
        poll_url: `${baseUrl}/v1/video/generations/${finishedJob.id}`,
        b64_json: b64Json,
        job: finishedJob,
        jobs: listAllVideoJobs(),
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
      jobs: listAllVideoJobs(),
    });
  };

  app.post('/api/video/jobs', verifyApiKeyMiddleware, handleCreateVideoJob);
  app.post('/v1/video/generations', verifyApiKeyMiddleware, handleCreateVideoJob);

  app.post('/v1/video/scenes/batch', verifyApiKeyMiddleware, async (req, res) => {
    const { scenes, model = 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers', inferenceSteps } =
      req.body || {};

    if (!Array.isArray(scenes) || scenes.length === 0) {
      res.status(400).json({
        error: 'Vui lòng truyền mảng scenes: [{ prompt, cameraMotion, seed }] để tạo chuỗi cảnh.',
      });
      return;
    }

    const batchId = `batch-film-${Date.now().toString().slice(-5)}`;
    const createdJobs: VideoJob[] = [];

    for (let i = 0; i < scenes.length; i++) {
      const sc = scenes[i];
      if (!sc || !sc.prompt) continue;
      const job = await createAndEnqueueJob(
        {
          ...sc,
          model: sc.model || model,
          inferenceSteps: sc.inferenceSteps || inferenceSteps,
        },
        i + 1,
        batchId
      );
      createdJobs.push(job);
    }

    const baseUrl = getBaseAppUrl(req);
    res.status(201).json({
      object: 'video.batch',
      batch_id: batchId,
      scene_count: createdJobs.length,
      poll_batch_url: `${baseUrl}/v1/video/generations?batchId=${batchId}`,
      scenes: createdJobs,
    });
  });

  app.delete('/api/jobs', (_req, res) => {
    db.exec('DELETE FROM video_jobs');
    try {
      for (const file of fs.readdirSync(VIDEOS_DIR)) {
        if (file.endsWith('.mp4')) {
          fs.unlinkSync(path.join(VIDEOS_DIR, file));
        }
      }
    } catch {
      // Ignore
    }
    appendOrchestratorLog('INFO', 'QUEUE', 'Đã xóa toàn bộ lịch sử job và giải phóng bộ nhớ video.');
    res.json({ cleared: true, jobs: [] });
  });

  // ============================================================================
  // CONTROL PLANE & COLAB CLI ORCHESTRATOR ROUTES (/api/*)
  // ============================================================================
  app.get('/api/cluster/state', async (req, res) => {
    const appUrl = getBaseAppUrl(req);
    await detectColabCliEnvironment();
    const session = getPrimarySession();
    const jobs = listAllVideoJobs();
    const keys = listApiKeys();
    const logs = listOrchestratorLogs();
    const workersList = Array.from(colabWorkers.values());

    // Map session to legacy accounts array for any legacy consumers while providing rich session object
    const legacyAccounts: ColabAccount[] = [
      {
        id: session.sessionId,
        email: session.accountEmail,
        displayName: session.displayName,
        avatarUrl: session.avatarUrl,
        state: session.workerConnected ? 'ACTIVE' : 'READY',
        gpuType: session.hardwareLabel,
        activeRunSeconds: 0,
        cooldownRemainingSeconds: 0,
        lastUsedAt: session.lastHeartbeatAt || new Date().toISOString(),
        workerId: session.workerId,
        vramUsedGb: session.vramUsedGb || 0,
        vramTotalGb: session.vramTotalGb,
        completedJobs: session.completedJobsCount,
        oauthConnected: true,
        warpProxyEnabled: true,
      },
    ];

    const cliCommands = buildColabCliCommands({
      sessionName: session.sessionId,
      hardwareTarget: session.hardwareTarget,
      bootstrapScriptPath: BOOTSTRAP_SCRIPT_PATH,
    });

    res.json({
      appUrl,
      // Masked token in public state; full token requires reveal endpoint
      maskedWorkerAuthToken: `${WORKER_AUTH_TOKEN.slice(0, 10)}••••••••••••${WORKER_AUTH_TOKEN.slice(-4)}`,
      session,
      cliCommands,
      settings: {
        enforceApiKey: getSetting('enforce_api_key', 'true') === 'true',
        maxJobRetries: Number(getSetting('max_job_retries', '2')),
        leaseTimeoutSec: Number(getSetting('lease_timeout_sec', '180')),
      },
      accounts: legacyAccounts,
      workers: workersList,
      jobs,
      apiKeys: keys,
      logs,
    });
  });

  // Protected endpoint to reveal or rotate WORKER_AUTH_TOKEN for Settings / Notebook generation
  app.get('/api/settings/worker-token', (req, res) => {
    if (req.headers['x-wan-studio-session'] !== STUDIO_SESSION_TOKEN) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.json({ workerAuthToken: WORKER_AUTH_TOKEN });
  });

  app.post('/api/settings/update', (req, res) => {
    if (req.headers['x-wan-studio-session'] !== STUDIO_SESSION_TOKEN) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const {
      enforceApiKey,
      maxJobRetries,
      leaseTimeoutSec,
      hardwareTarget,
      computeUnitsLimit,
      adcJsonContent,
      rotateWorkerToken,
    } = req.body || {};

    if (enforceApiKey !== undefined) {
      setSetting('enforce_api_key', enforceApiKey ? 'true' : 'false');
    }
    if (maxJobRetries !== undefined) {
      setSetting('max_job_retries', String(Math.max(0, Math.min(5, Number(maxJobRetries)))));
    }
    if (leaseTimeoutSec !== undefined) {
      setSetting('lease_timeout_sec', String(Math.max(30, Number(leaseTimeoutSec))));
    }
    if (hardwareTarget && hardwareTarget in HARDWARE_PROFILES) {
      const hw = HARDWARE_PROFILES[hardwareTarget as HardwareTargetId];
      db.prepare(
        'UPDATE runtime_sessions SET hardware_target = ?, vram_total_gb = ? WHERE session_id = ?'
      ).run(hardwareTarget, hw.vramTotalGb, 'wan-worker');
    }
    if (computeUnitsLimit !== undefined) {
      db.prepare('UPDATE runtime_sessions SET compute_units_limit = ? WHERE session_id = ?').run(
        Number(computeUnitsLimit),
        'wan-worker'
      );
    }
    if (adcJsonContent && typeof adcJsonContent === 'string' && adcJsonContent.trim()) {
      try {
        JSON.parse(adcJsonContent);
        fs.writeFileSync(ADC_CREDENTIALS_PATH, adcJsonContent.trim(), 'utf-8');
        db.prepare('UPDATE runtime_sessions SET adc_authenticated = 1 WHERE session_id = ?').run(
          'wan-worker'
        );
        appendOrchestratorLog(
          'INFO',
          'CLI',
          'Đã lưu thành công thông tin xác thực ADC (colab_adc_credentials.json) cho Google Colab CLI.'
        );
      } catch {
        res.status(400).json({ error: 'Nội dung ADC JSON không đúng định dạng JSON.' });
        return;
      }
    }
    if (rotateWorkerToken) {
      WORKER_AUTH_TOKEN = `wh_wan_${crypto.randomBytes(12).toString('hex')}`;
      setSetting('worker_auth_token', WORKER_AUTH_TOKEN);
      appendOrchestratorLog('INFO', 'AUTH', 'Đã xoay mới mã WORKER_AUTH_TOKEN.');
    }

    res.json({
      ok: true,
      session: getPrimarySession(),
      workerAuthToken: WORKER_AUTH_TOKEN,
      settings: {
        enforceApiKey: getSetting('enforce_api_key', 'true') === 'true',
        maxJobRetries: Number(getSetting('max_job_retries', '2')),
        leaseTimeoutSec: Number(getSetting('lease_timeout_sec', '180')),
      },
    });
  });

  app.post('/api/accounts/oauth-sync', (req, res) => {
    const { email, displayName, photoURL } = req.body || {};
    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email tài khoản Google là bắt buộc.' });
      return;
    }

    db.prepare(
      `UPDATE runtime_sessions
       SET account_email = ?, display_name = ?, avatar_url = COALESCE(?, avatar_url)
       WHERE session_id = 'wan-worker'`
    ).run(email, displayName || email.split('@')[0], photoURL || null);

    appendOrchestratorLog(
      'INFO',
      'AUTH',
      `Đã đồng bộ tài khoản Google OAuth (${email}). Lưu ý: OAuth trên trình duyệt chỉ cấp quyền Google Drive (drive.file), không cấp ADC refresh_token cho google-colab-cli.`
    );
    res.json({ session: getPrimarySession() });
  });

  // ============================================================================
  // P0: REAL COLAB CLI ORCHESTRATOR ACTIONS (Start / Stop / Status Check)
  // ============================================================================
  app.get('/api/colab/bootstrap.py', (req, res) => {
    const appUrl = getBaseAppUrl(req);
    const session = getPrimarySession();
    const hwTarget: HardwareTargetId =
      (req.query.hardwareTarget as HardwareTargetId) || session.hardwareTarget || 'tpu_v5e';
    const modelId: WanModelId =
      (req.query.modelId as WanModelId) || 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers';
    const scriptPath = writeBootstrapScriptToDisk({
      serverUrl: appUrl,
      workerId: `colab-${hwTarget}-01`,
      modelId,
      hardwareTarget: hwTarget,
    });
    res.setHeader('Content-Type', 'text/x-python; charset=utf-8');
    res.send(fs.readFileSync(scriptPath, 'utf-8'));
  });

  app.post('/api/colab/cli/:action', async (req, res) => {
    const { action } = req.params;
    const body = req.body || {};
    const appUrl = getBaseAppUrl(req);
    const envStatus = await detectColabCliEnvironment();
    const session = getPrimarySession();
    const hwTarget: HardwareTargetId =
      body.hardwareTarget || session.hardwareTarget || 'tpu_v5e';
    const modelId: WanModelId =
      body.modelId || 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers';

    if (hwTarget !== session.hardwareTarget) {
      db.prepare(
        'UPDATE runtime_sessions SET hardware_target = ?, vram_total_gb = ? WHERE session_id = ?'
      ).run(hwTarget, HARDWARE_PROFILES[hwTarget].vramTotalGb, 'wan-worker');
    }

    // Write fresh hardware-matched bootstrap script (.data/bootstrap.py)
    const bootstrapPath = writeBootstrapScriptToDisk({
      serverUrl: appUrl,
      workerId: `colab-${hwTarget}-01`,
      modelId,
      hardwareTarget: hwTarget,
    });
    const cmds = buildColabCliCommands({
      sessionName: 'wan-worker',
      hardwareTarget: hwTarget,
      bootstrapScriptPath: bootstrapPath,
    });

    if (action === 'check') {
      if (!envStatus.cliBinaryAvailable) {
        const msg =
          'Container Linux của AI Studio không cài sẵn `pip`, `gcloud` hay `google-colab-cli` (`/usr/bin/python3: No module named pip`). Để chạy thực tế, hãy mở Notebook hoặc chạy `bootstrap.py` trực tiếp trên Google Colab TPU v5e-1 để Worker nối WebSocket về server.';
        db.prepare('UPDATE runtime_sessions SET last_error = ? WHERE session_id = ?').run(
          msg,
          'wan-worker'
        );
        appendOrchestratorLog('WARN', 'CLI', msg);
        res.json({
          ok: false,
          cliBinaryAvailable: false,
          adcAuthenticated: envStatus.adcAuthenticated,
          message: msg,
          session: getPrimarySession(),
          logs: listOrchestratorLogs(),
        });
        return;
      }

      try {
        const { stdout, stderr } = await execFileAsync(cmds.statusCmd[0], cmds.statusCmd.slice(1), {
          timeout: 15000,
          env: {
            ...process.env,
            ...(envStatus.adcPath ? { GOOGLE_APPLICATION_CREDENTIALS: envStatus.adcPath } : {}),
          },
        });
        const outText = (stdout || stderr || 'Colab CLI OK').trim();
        appendOrchestratorLog('INFO', 'CLI', `[colab status] ${outText}`);
        res.json({
          ok: true,
          cliBinaryAvailable: true,
          adcAuthenticated: envStatus.adcAuthenticated,
          output: outText,
          session: getPrimarySession(),
          logs: listOrchestratorLogs(),
        });
      } catch (err: any) {
        const errMsg = err?.stderr || err?.message || 'Lỗi khi chạy colab status';
        db.prepare('UPDATE runtime_sessions SET last_error = ? WHERE session_id = ?').run(
          errMsg,
          'wan-worker'
        );
        appendOrchestratorLog('ERROR', 'CLI', `[colab status error] ${errMsg}`);
        res.json({
          ok: false,
          cliBinaryAvailable: true,
          adcAuthenticated: envStatus.adcAuthenticated,
          message: errMsg,
          session: getPrimarySession(),
          logs: listOrchestratorLogs(),
        });
      }
      return;
    }

    if (action === 'start') {
      if (!envStatus.cliBinaryAvailable) {
        const msg =
          'Không thể tự cấp phát TPU v5e-1 từ server vì container Linux hiện tại không có `pip` và `google-colab-cli` (`/usr/bin/python3: No module named pip`), đồng thời Google Colab không mở public REST API để bật TPU từ trình duyệt. Hãy vào mục Cài đặt -> Lưu file `.ipynb` lên Google Drive -> Mở trên Google Colab (chọn TPU v5e-1) để Worker thật kết nối WebSocket về đây.';
        db.prepare(
          "UPDATE runtime_sessions SET state = 'DISCONNECTED', last_error = ? WHERE session_id = 'wan-worker'"
        ).run(msg);
        appendOrchestratorLog('ERROR', 'CLI', msg);
        res.status(422).json({
          ok: false,
          error: msg,
          bootstrapScriptPath: bootstrapPath,
          cliCommands: cmds,
          session: getPrimarySession(),
          logs: listOrchestratorLogs(),
        });
        return;
      }

      if (!envStatus.adcAuthenticated) {
        const msg =
          'Chưa có file ủy quyền `application_default_credentials.json` hợp lệ (chứa `refresh_token` từ `gcloud auth application-default login`). Token đăng nhập Google trên trình duyệt chỉ có scope `drive.file`, không dùng thay ADC được.';
        db.prepare(
          "UPDATE runtime_sessions SET state = 'ERROR', last_error = ? WHERE session_id = 'wan-worker'"
        ).run(msg);
        appendOrchestratorLog('ERROR', 'CLI', msg);
        res.status(422).json({
          ok: false,
          error: msg,
          session: getPrimarySession(),
          logs: listOrchestratorLogs(),
        });
        return;
      }

      db.prepare(
        "UPDATE runtime_sessions SET state = 'PROVISIONING', last_error = NULL WHERE session_id = 'wan-worker'"
      ).run();
      appendOrchestratorLog('INFO', 'CLI', `Đang thực thi: ${cmds.provisionCmd.join(' ')}`);

      try {
        await execFileAsync(cmds.provisionCmd[0], cmds.provisionCmd.slice(1), {
          timeout: 60000,
          env: {
            ...process.env,
            ...(envStatus.adcPath ? { GOOGLE_APPLICATION_CREDENTIALS: envStatus.adcPath } : {}),
          },
        });

        db.prepare(
          "UPDATE runtime_sessions SET state = 'BOOTSTRAPPING' WHERE session_id = 'wan-worker'"
        ).run();
        appendOrchestratorLog(
          'INFO',
          'CLI',
          `Đã cấp phát runtime TPU v5e-1. Đang chạy bootstrap worker: ${cmds.execBootstrapCmd.join(' ')}`
        );

        if (activeColabExecProcess) {
          activeColabExecProcess.kill();
        }
        activeColabExecProcess = spawn(cmds.execBootstrapCmd[0], cmds.execBootstrapCmd.slice(1), {
          env: {
            ...process.env,
            ...(envStatus.adcPath ? { GOOGLE_APPLICATION_CREDENTIALS: envStatus.adcPath } : {}),
          },
        });

        activeColabExecProcess.stdout?.on('data', (chunk) => {
          appendOrchestratorLog('INFO', 'CLI', String(chunk).trim());
        });
        activeColabExecProcess.stderr?.on('data', (chunk) => {
          appendOrchestratorLog('WARN', 'CLI', String(chunk).trim());
        });

        res.json({
          ok: true,
          message: 'Đã khởi chạy phiên Colab CLI và tiến trình bootstrap worker.',
          session: getPrimarySession(),
          logs: listOrchestratorLogs(),
        });
      } catch (err: any) {
        const errMsg = err?.stderr || err?.message || 'Không thể cấp phát Colab runtime qua CLI.';
        db.prepare(
          "UPDATE runtime_sessions SET state = 'ERROR', last_error = ? WHERE session_id = 'wan-worker'"
        ).run(errMsg);
        appendOrchestratorLog('ERROR', 'CLI', errMsg);
        res.status(500).json({
          ok: false,
          error: errMsg,
          session: getPrimarySession(),
          logs: listOrchestratorLogs(),
        });
      }
      return;
    }

    if (action === 'stop') {
      if (activeColabExecProcess) {
        activeColabExecProcess.kill();
        activeColabExecProcess = null;
      }

      for (const [workerId, sock] of liveSockets.entries()) {
        sock.close(1000, 'Stopped by user');
        liveSockets.delete(workerId);
        colabWorkers.delete(workerId);
      }

      if (envStatus.cliBinaryAvailable) {
        try {
          await execFileAsync(cmds.stopCmd[0], cmds.stopCmd.slice(1), { timeout: 15000 });
          appendOrchestratorLog('INFO', 'CLI', `Đã thực thi: ${cmds.stopCmd.join(' ')}`);
        } catch (err: any) {
          appendOrchestratorLog('WARN', 'CLI', `Lệnh stop CLI: ${err?.message || 'Đã đóng kết nối'}`);
        }
      } else {
        appendOrchestratorLog('INFO', 'CLI', 'Đã ngắt kết nối toàn bộ Worker và đặt trạng thái DISCONNECTED.');
      }

      db.prepare(
        `UPDATE runtime_sessions
         SET state = 'DISCONNECTED', worker_connected = 0, worker_id = NULL,
             gpu_name_reported = NULL, vram_used_gb = NULL, vram_is_measured = 0, last_error = NULL
         WHERE session_id = 'wan-worker'`
      ).run();

      res.json({
        ok: true,
        message: 'Đã ngắt kết nối Worker và đặt trạng thái DISCONNECTED.',
        session: getPrimarySession(),
        workers: Array.from(colabWorkers.values()),
        logs: listOrchestratorLogs(),
      });
      return;
    }

    res.status(400).json({ error: `Hành động CLI không hợp lệ: ${action}` });
  });

  // ============================================================================
  // API KEYS MANAGEMENT (SQLite + SHA-256 Hash)
  // ============================================================================
  app.post('/api/apikeys', (req, res) => {
    const { name, rpmLimit = 60, expiresInDays = 30, scopes = ['all'] } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'Vui lòng nhập tên định danh cho API Key.' });
      return;
    }

    const secretSuffix = crypto.randomBytes(12).toString('hex');
    const fullSecret = `sk-wan-${secretSuffix}`;
    const keyHash = hashSecret(fullSecret);
    const id = `key-${Date.now()}`;
    const prefix = fullSecret.slice(0, 10);
    const maskedKey = `${fullSecret.slice(0, 10)}••••••••••••••••${fullSecret.slice(-4)}`;
    const createdAt = new Date().toISOString();

    db.prepare(
      `INSERT INTO api_keys (id, name, prefix, masked_key, key_hash, rpm_limit, scopes_json, created_at, expires_in_days, requests_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      id,
      name.trim(),
      prefix,
      maskedKey,
      keyHash,
      Number(rpmLimit),
      JSON.stringify(Array.isArray(scopes) ? scopes : ['all']),
      createdAt,
      Number(expiresInDays)
    );

    appendOrchestratorLog('INFO', 'AUTH', `Đã tạo API Key mới '${name.trim()}' (${prefix}...).`);
    res.status(201).json({
      apiKey: {
        id,
        name: name.trim(),
        prefix,
        maskedKey,
        rpmLimit: Number(rpmLimit),
        scopes,
        createdAt,
        expiresInDays: Number(expiresInDays),
        requestsCount: 0,
      },
      fullSecret,
      apiKeys: listApiKeys(),
    });
  });

  app.delete('/api/apikeys/:id', (req, res) => {
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(req.params.id);
    appendOrchestratorLog('INFO', 'AUTH', `Đã thu hồi API Key ${req.params.id}.`);
    res.json({ deleted: true, apiKeys: listApiKeys() });
  });

  // ============================================================================
  // REAL TPU/GPU E2E VERIFICATION ONLY (NO MOCK FFMPEG WORKER)
  // ============================================================================
  app.post('/api/e2e/verify', async (_req, res) => {
    const stepsLog: string[] = [];
    const onlineRealWorkers = Array.from(colabWorkers.values()).filter(
      (w) => w.status === 'ONLINE' && !w.workerId.startsWith('mock-')
    );

    if (onlineRealWorkers.length === 0) {
      const honestError =
        'Chưa có Colab TPU v5e-1 Worker thật đang kết nối (0 Workers Online). Nguyên nhân: Container AI Studio không có pip/google-colab-cli và không có TPU cục bộ. Bạn cần mở Notebook hoặc chạy bootstrap.py trên Google Colab (chọn TPU v5e-1) để Worker thật nối WebSocket về Hub.';
      stepsLog.push(`1. [Kiểm tra Worker thật] THẤT BẠI: ${honestError}`);
      appendOrchestratorLog('WARN', 'E2E', honestError);
      res.status(409).json({
        ok: false,
        mode: 'real_gpu',
        error: honestError,
        stepsLog,
        session: getPrimarySession(),
        jobs: listAllVideoJobs(),
        logs: listOrchestratorLogs(),
      });
      return;
    }

    stepsLog.push(
      `1. [Real TPU/GPU Worker] Phát hiện worker thật '${onlineRealWorkers[0].workerId}' (${onlineRealWorkers[0].gpuName}, ${onlineRealWorkers[0].torchDtype}).`
    );
    const genRes = await fetch(`http://127.0.0.1:${PORT}/v1/video/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Wan-Studio-Session': STUDIO_SESSION_TOKEN,
      },
      body: JSON.stringify({
        model: 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers',
        prompt:
          'Wide tracking shot, rain on neon-lit asphalt street at night, volumetric fog, 35mm film grain',
        camera_motion: 'dolly_in',
        num_inference_steps: 30,
        guidance_scale: 5.0,
        wait: true,
        is_mock: false,
      }),
    });
    const genData = await genRes.json();
    stepsLog.push(
      `2. [Real Wan Inference] Kết quả Job ${genData.id}: status=${genData.status}, thời gian=${
        genData.job?.actualInferenceSec ?? 'N/A'
      }s.`
    );
    res.json({
      ok: genData.status === 'COMPLETED',
      mode: 'real_gpu',
      jobId: genData.id,
      finalStatus: genData.status,
      videoUrl: genData.video_url,
      stepsLog,
      session: getPrimarySession(),
      jobs: listAllVideoJobs(),
      logs: listOrchestratorLogs(),
    });
  });

  // Gemini 4 Carbon Prompt Director
  app.post('/api/ai/director', async (req, res) => {
    const { prompt, cameraMotion = 'dolly_in', model = 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers' } =
      req.body || {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'Vui lòng nhập ý tưởng video để AI Director tối ưu.' });
      return;
    }

    try {
      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: 'gemini-4-carbon',
        contents: `Tối ưu kịch bản prompt tiếng Anh cho mô hình tạo video ${model} theo cấu trúc 4 phần: [Góc máy & chuyển động camera (${cameraMotion})] + [Chủ thể & hành động] + [Bối cảnh & ánh sáng] + [Phong cách màu phim 35mm].
Ý tưởng gốc: "${prompt.trim()}"`,
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
            },
            required: ['cinematicPrompt', 'negativePrompt', 'thinkingSummaryVi'],
          },
        },
      });

      const rawText = (response.text ?? '{}').trim();
      const parsed = JSON.parse(rawText);
      res.json({
        model: 'gemini-4-carbon',
        result: parsed,
      });
    } catch (error: any) {
      res.status(500).json({
        error: error?.message || 'Không thể kết nối tới mô hình gemini-4-carbon.',
      });
    }
  });

  // Guard all /api/* and /v1/* routes so they always return JSON and never fall through to HTML
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });
  app.use('/v1', (_req, res) => {
    res.status(404).json({ error: 'V1 endpoint not found' });
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

  httpServer.listen(PORT, '0.0.0.0', async () => {
    console.log(`WAN Studio & Colab CLI Orchestrator listening on http://0.0.0.0:${PORT}`);
    await detectColabCliEnvironment();
  });
}

startServer();
