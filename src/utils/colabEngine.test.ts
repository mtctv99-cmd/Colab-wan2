import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWanLatentFrames,
  calculateFastWanMetrics,
  evaluateAccountLifecycle,
  rotateColabPool,
  generateFastWanWorkerScript,
  generateColabNotebookJson,
  applyCameraMotionToPrompt,
  RUN_DURATION_SEC,
  PREWARM_THRESHOLD_SEC,
  COOLDOWN_DURATION_SEC,
  type ColabAccount,
} from './colabEngine';

test('computeWanLatentFrames enforces Wan2.1 4k+1 temporal frame constraint (81 frames @ 5s 16fps)', () => {
  const frames5s16fps = computeWanLatentFrames(5, 16);
  assert.equal((frames5s16fps - 1) % 4, 0);
  assert.equal(frames5s16fps, 81);

  const frames5s24fps = computeWanLatentFrames(5, 24);
  assert.equal((frames5s24fps - 1) % 4, 0);
  assert.equal(frames5s24fps, 121);
});

test('calculateFastWanMetrics computes 8.2GB HBM usage and locks 832x480x81 when lockXlaShape is enabled', () => {
  const mLocked = calculateFastWanMetrics({
    resolution: '720p',
    aspectRatio: '9:16',
    durationSec: 10,
    fps: 24,
    inferenceSteps: 4,
    enableTeaCache: true,
    cpuOffload: false,
    lockXlaShape: true,
  });

  assert.equal(mLocked.width, 832);
  assert.equal(mLocked.height, 480);
  assert.equal(mLocked.latentFrames, 81);
  assert.equal(mLocked.estimatedVramGb, 8.2);
  assert.equal(mLocked.fitsOnFreeT4, true);
  assert.ok(mLocked.speedupFactor >= 10);
});

test('applyCameraMotionToPrompt prepends cinematic camera trajectory cues without duplication', () => {
  const raw = 'a lone cyberpunk detective walking through a rainy neon-lit alley in Tokyo';
  const withDolly = applyCameraMotionToPrompt(raw, 'dolly_in');
  assert.ok(withDolly.includes('35mm dolly-in tracking shot'));
  assert.equal(applyCameraMotionToPrompt(withDolly, 'dolly_in'), withDolly);
});

test('evaluateAccountLifecycle triggers prewarm at 2h35m (9300s) and rotation at 3h (10800s)', () => {
  const baseAccount: ColabAccount = {
    id: 'acc-1',
    email: 'colab.node01@gmail.com',
    displayName: 'Colab Worker 01',
    state: 'ACTIVE',
    gpuType: 'TPU v5e-1 (16GB HBM)',
    activeRunSeconds: 5000,
    cooldownRemainingSeconds: 0,
    lastUsedAt: new Date().toISOString(),
    workerId: 'colab-tpu-0001',
    vramUsedGb: 8.2,
    vramTotalGb: 16.0,
    completedJobs: 14,
    oauthConnected: true,
    warpProxyEnabled: true,
  };

  const early = evaluateAccountLifecycle(baseAccount);
  assert.equal(early.shouldPrewarmNext, false);
  assert.equal(early.shouldRotateNow, false);

  const atPrewarm = evaluateAccountLifecycle({
    ...baseAccount,
    activeRunSeconds: PREWARM_THRESHOLD_SEC + 10,
  });
  assert.equal(atPrewarm.shouldPrewarmNext, true);
  assert.equal(atPrewarm.shouldRotateNow, false);

  const atExpiry = evaluateAccountLifecycle({
    ...baseAccount,
    activeRunSeconds: RUN_DURATION_SEC,
  });
  assert.equal(atExpiry.shouldRotateNow, true);
  assert.equal(atExpiry.remainingRunSec, 0);
});

test('rotateColabPool retires ACTIVE account to 16h COOLDOWN and promotes PREWARMING successor', () => {
  const pool: ColabAccount[] = [
    {
      id: 'acc-1',
      email: 'colab1@gmail.com',
      displayName: 'Account 1',
      state: 'ACTIVE',
      gpuType: 'TPU v5e-1 (16GB HBM)',
      activeRunSeconds: 10800,
      cooldownRemainingSeconds: 0,
      lastUsedAt: '',
      workerId: 'colab-tpu-01',
      vramUsedGb: 8.2,
      vramTotalGb: 16,
      completedJobs: 12,
      oauthConnected: true,
      warpProxyEnabled: true,
    },
    {
      id: 'acc-2',
      email: 'colab2@gmail.com',
      displayName: 'Account 2',
      state: 'PREWARMING',
      gpuType: 'TPU v5e-1 (16GB HBM)',
      activeRunSeconds: 0,
      cooldownRemainingSeconds: 0,
      lastUsedAt: '',
      workerId: 'colab-tpu-02',
      vramUsedGb: 0,
      vramTotalGb: 16,
      completedJobs: 5,
      oauthConnected: true,
      warpProxyEnabled: true,
    },
  ];

  const { updatedAccounts, promotedAccount, retiredAccount } = rotateColabPool(pool);
  assert.equal(promotedAccount?.id, 'acc-2');
  assert.equal(retiredAccount?.id, 'acc-1');

  const a1 = updatedAccounts.find((a) => a.id === 'acc-1')!;
  const a2 = updatedAccounts.find((a) => a.id === 'acc-2')!;
  assert.equal(a1.state, 'COOLDOWN');
  assert.equal(a1.cooldownRemainingSeconds, COOLDOWN_DURATION_SEC);
  assert.equal(a2.state, 'ACTIVE');
});

test('generateFastWanWorkerScript includes all production Wan 2.1 capabilities', () => {
  const script = generateFastWanWorkerScript({
    serverUrl: 'https://example.run.app',
    workerId: 'colab-tpu-test',
    workerToken: 'wk_secret_123',
    modelId: 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers',
    runtimeType: 'tpu_v5e',
  });
  assert.ok(script.includes('Wan-AI/Wan2.1-T2V-1.3B-Diffusers'));
  assert.ok(script.includes('pipe.enable_vae_tiling()'));
  assert.ok(script.includes('pipe.enable_vae_slicing()'));
  assert.ok(script.includes('UniPCMultistepScheduler.from_config'));
  assert.ok(script.includes('flow_shift=flow_shift'));
  assert.ok(script.includes('callback_on_step_end=step_callback'));
  assert.ok(script.includes('job_error'));

  const nbRaw = generateColabNotebookJson({
    serverUrl: 'https://example.run.app',
    workerId: 'colab-tpu-test',
    workerToken: 'wk_secret_123',
    modelId: 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers',
    runtimeType: 'tpu_v5e',
  });
  const parsed = JSON.parse(nbRaw);
  assert.equal(parsed.nbformat, 4);
  assert.equal(parsed.cells.length, 3);
  assert.equal(parsed.metadata.colab.accelerator, 'TPU_V5E');
});
