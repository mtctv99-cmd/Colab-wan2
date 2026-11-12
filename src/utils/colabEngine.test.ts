import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WAN_MODEL_ADAPTERS,
  HARDWARE_PROFILES,
  calculateFastWanMetrics,
  applyCameraMotionToPrompt,
  isValidMp4Buffer,
  buildColabCliCommands,
  generateFastWanWorkerScript,
} from './colabEngine';

test('FastWan 2.1 1.3B adapter follows official model card and defaults to TPU v5e-1 BF16', () => {
  const fastWan = WAN_MODEL_ADAPTERS['FastVideo/FastWan2.1-T2V-1.3B-Diffusers'];
  assert.equal(fastWan.defaultSteps, 3);
  assert.equal(fastWan.defaultFrames, 61);
  assert.equal(fastWan.defaultWidth16x9, 832);
  assert.equal(fastWan.defaultHeight16x9, 448);

  const defaultMetrics = calculateFastWanMetrics({
    model: 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers',
    resolution: '480p',
    aspectRatio: '16:9',
    durationSec: 4,
    fps: 16,
    inferenceSteps: 3,
  });
  assert.equal(defaultMetrics.width, 832);
  assert.equal(defaultMetrics.height, 448);
  assert.equal(defaultMetrics.latentFrames, 61);
  assert.equal(defaultMetrics.torchDtype, 'torch.bfloat16');
  assert.equal(defaultMetrics.isEstimated, true);
});

test('TPU v5e-1 bootstrap.py worker script configures torch_xla, PJRT_DEVICE, xm.xla_device(), and xm.mark_step()', () => {
  assert.equal(HARDWARE_PROFILES.tpu_v5e.cliFlag, '--tpu v5e-1');
  assert.equal(HARDWARE_PROFILES.tpu_v5e.torchDtype, 'torch.bfloat16');
  assert.equal(HARDWARE_PROFILES.tpu_v5e.vramTotalGb, 16.0);

  const defaultTpuScript = generateFastWanWorkerScript({
    serverUrl: 'https://hub.example.com',
    workerId: 'wan-tpu-01',
    workerToken: 'tok_secret_123',
    modelId: 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers',
  });
  assert.ok(defaultTpuScript.includes('os.environ.setdefault("PJRT_DEVICE", "TPU")'));
  assert.ok(defaultTpuScript.includes('os.environ.setdefault("XLA_USE_BF16", "1")'));
  assert.ok(defaultTpuScript.includes('import torch_xla'));
  assert.ok(defaultTpuScript.includes('import torch_xla.core.xla_model as xm'));
  assert.ok(defaultTpuScript.includes('import torch_xla.runtime as xr'));
  assert.ok(defaultTpuScript.includes('device = xm.xla_device()'));
  assert.ok(defaultTpuScript.includes('xm.get_memory_info(device)'));
  assert.ok(defaultTpuScript.includes('xm.mark_step()'));
  assert.ok(defaultTpuScript.includes('TORCH_DTYPE = torch.bfloat16'));
});

test('Tesla T4 fallback worker script enforces torch.float16 + enable_model_cpu_offload', () => {
  assert.equal(HARDWARE_PROFILES.t4.torchDtype, 'torch.float16');
  assert.equal(HARDWARE_PROFILES.t4.useCpuOffload, true);

  const t4Script = generateFastWanWorkerScript({
    serverUrl: 'https://hub.example.com',
    workerId: 'wan-t4-01',
    workerToken: 'tok_secret_123',
    modelId: 'FastVideo/FastWan2.1-T2V-1.3B-Diffusers',
    hardwareTarget: 't4',
  });
  assert.ok(t4Script.includes('TORCH_DTYPE = torch.float16'));
  assert.ok(t4Script.includes('pipe.enable_model_cpu_offload()'));
  assert.ok(t4Script.includes('pipe.enable_vae_tiling()'));
});

test('buildColabCliCommands strictly favors TPU v5e-1 (--tpu v5e-1) provisioning via CLI', () => {
  const cmds = buildColabCliCommands({
    sessionName: 'wan-worker',
    hardwareTarget: 'tpu_v5e',
    bootstrapScriptPath: '.data/bootstrap.py',
  });
  assert.deepEqual(cmds.listSessionsCmd, ['colab', '--auth=adc', 'sessions']);
  assert.deepEqual(cmds.provisionCmd, ['colab', '--auth=adc', 'new', '-s', 'wan-worker', '--tpu', 'v5e-1']);
  assert.deepEqual(cmds.statusCmd, ['colab', '--auth=adc', 'status', '-s', 'wan-worker']);
  assert.deepEqual(cmds.execBootstrapCmd, [
    'colab',
    '--auth=adc',
    'exec',
    '-s',
    'wan-worker',
    '-f',
    '.data/bootstrap.py',
  ]);
  assert.deepEqual(cmds.stopCmd, ['colab', '--auth=adc', 'stop', '-s', 'wan-worker']);
});

test('isValidMp4Buffer checks ISO BMFF ftyp signature and minimum byte length', () => {
  assert.equal(isValidMp4Buffer(null), false);
  assert.equal(isValidMp4Buffer(Buffer.alloc(32)), false);

  const validMp4 = Buffer.alloc(512);
  validMp4.writeUInt32BE(24, 0);
  validMp4.write('ftypisom', 4, 'ascii');
  assert.equal(isValidMp4Buffer(validMp4), true);

  const corrupted = Buffer.alloc(512);
  corrupted.write('HTMLbody', 4, 'ascii');
  assert.equal(isValidMp4Buffer(corrupted), false);
});

test('applyCameraMotionToPrompt injects cinematic camera cues cleanly', () => {
  const out = applyCameraMotionToPrompt('a detective in rainy Tokyo', 'dolly_in');
  assert.ok(out.startsWith('Slow 35mm dolly-in tracking shot'));
  assert.ok(out.includes('a detective in rainy Tokyo'));
});
