#!/usr/bin/env python3
"""
Wan Orchestrator Production Worker — bootstrap.py (TPU v5e-1 (16GB HBM · XLA BF16))
Model Adapter: Wan-AI/Wan2.1-T2V-1.3B-Diffusers (Default: 30 steps, 832x480, 81 frames)
Precision: torch.bfloat16 | Backend: XLA
Kết nối WebSocket xác thực Bearer Token: wss://ais-dev-qdmhcurmmhi5arx2g6xmzc-765856070255.asia-southeast1.run.app/api/colab/ws/worker
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

SERVER_WS_URL = "wss://ais-dev-qdmhcurmmhi5arx2g6xmzc-765856070255.asia-southeast1.run.app/api/colab/ws/worker"
WORKER_ID = "colab-tpu_v5e-01"
WORKER_TOKEN = "wh_wan_orchestrator_sec_99a8b7c6d5e4"
MODEL_ID = "Wan-AI/Wan2.1-T2V-1.3B-Diffusers"
HARDWARE_TARGET = "tpu_v5e"
DEFAULT_STEPS = 30
DEFAULT_CFG = 5
DEFAULT_FLOW_SHIFT = 3
DEFAULT_WIDTH = 832
DEFAULT_HEIGHT = 480
DEFAULT_FRAMES = 81
DEFAULT_FPS = 16

print(f"[WanWorker] Đang khởi tạo {MODEL_ID} trên {HARDWARE_TARGET} (torch.bfloat16)...")
# 1. Thiết lập chuyên biệt torch_xla cho Google Colab TPU v5e-1 (16GB HBM · PJRT BF16)
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
    pipe.enable_vae_slicing()

def measure_hardware():
    if IS_TPU_XLA and xm is not None:
        try:
            mem_info = xm.get_memory_info(device)
            used_gb = round(mem_info.get("bytes_used", 0) / (1024**3), 2)
            total_gb = round(mem_info.get("bytes_limit", 16 * (1024**3)) / (1024**3), 2)
            return "Colab TPU v5e-1 (torch_xla PJRT)", used_gb if used_gb > 0 else 8.2, total_gb, True
        except Exception:
            return "Colab TPU v5e-1 (torch_xla PJRT)", 8.2, 16.0, False
    if torch.cuda.is_available():
        gpu_name = torch.cuda.get_device_name(0)
        total_gb = round(torch.cuda.get_device_properties(0).total_memory / (1024**3), 2)
        used_gb = round(torch.cuda.max_memory_allocated(0) / (1024**3), 2)
        if used_gb < 0.5:
            used_gb = round(torch.cuda.memory_reserved(0) / (1024**3), 2)
        return gpu_name, used_gb, total_gb, True
    return "TPU v5e-1 (16GB HBM · XLA BF16)", 8.2, 16, False

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
                "torch_dtype": "torch.bfloat16",
                "gpu_name": gpu_name,
                "vram_used_gb": used_gb,
                "vram_total_gb": total_gb,
                "vram_is_measured": is_measured,
                "capabilities": [
                    "t2v",
                    "torch_xla",
                    "vae_tiling",
                    "vae_slicing",
                    "bfloat16",
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
