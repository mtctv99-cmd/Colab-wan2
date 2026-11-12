import React, { useMemo, useState } from 'react';
import { Copy, Download, Check } from 'lucide-react';
import {
  generateFastWanWorkerScript,
  generateColabNotebookJson,
  type ColabWorkerSnapshot,
  type WanModelId,
} from '../utils/colabEngine';

interface WorkerHubViewProps {
  workers: ColabWorkerSnapshot[];
  appUrl: string;
  workerAuthToken: string;
  selectedModel: WanModelId;
  onSelectModel: (model: WanModelId) => void;
}

export const WorkerHubView: React.FC<WorkerHubViewProps> = ({
  workers,
  appUrl,
  workerAuthToken,
  selectedModel,
  onSelectModel,
}) => {
  const [customWorkerId, setCustomWorkerId] = useState('colab-tpu-v5e-01');
  const [runtimeType, setRuntimeType] = useState<'tpu_v5e' | 'cuda_gpu'>('tpu_v5e');
  const [copiedCell1, setCopiedCell1] = useState(false);
  const [copiedCell2, setCopiedCell2] = useState(false);

  const cell1InstallCmd = `!pip install -q -U diffusers transformers accelerate sentencepiece ftfy imageio imageio-ffmpeg websockets`;

  const cell2WorkerScript = useMemo(
    () =>
      generateFastWanWorkerScript({
        serverUrl: appUrl,
        workerId: customWorkerId,
        workerToken: workerAuthToken,
        modelId: selectedModel,
        runtimeType,
        enableCpuOffload: runtimeType === 'cuda_gpu',
      }),
    [appUrl, customWorkerId, workerAuthToken, selectedModel, runtimeType]
  );

  const handleCopyCell1 = async () => {
    try {
      await navigator.clipboard.writeText(cell1InstallCmd);
      setCopiedCell1(true);
      setTimeout(() => setCopiedCell1(false), 2000);
    } catch {
      // Ignore
    }
  };

  const handleCopyCell2 = async () => {
    try {
      await navigator.clipboard.writeText(cell2WorkerScript);
      setCopiedCell2(true);
      setTimeout(() => setCopiedCell2(false), 2000);
    } catch {
      // Ignore
    }
  };

  const handleDownloadNotebook = () => {
    const nbJson = generateColabNotebookJson({
      serverUrl: appUrl,
      workerId: customWorkerId,
      workerToken: workerAuthToken,
      modelId: selectedModel,
      runtimeType,
    });
    const blob = new Blob([nbJson], { type: 'application/x-ipynb+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Wan2.1_1.3B_TPU_v5e_${customWorkerId}.ipynb`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Section 1: Connected Workers */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Danh sách Colab TPU / GPU Worker Đang Kết Nối ({workers.length})
            </h2>
            <p className="text-xs font-mono text-slate-400">
              WebSocket Hub: <span className="text-amber-300">{appUrl.replace(/^http/, 'ws')}/api/colab/ws/worker</span>
            </p>
          </div>
          <button
            type="button"
            onClick={handleDownloadNotebook}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Tải File .ipynb (Chạy trên Colab TPU v5e-1)</span>
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 font-medium">
                <th className="py-2 pr-4">Worker ID</th>
                <th className="py-2 px-4">Tài khoản</th>
                <th className="py-2 px-4">Model</th>
                <th className="py-2 px-4">Thiết bị & Bộ nhớ HBM</th>
                <th className="py-2 pl-4 text-right">Trạng thái</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
              {workers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-400 font-sans">
                    Chưa có Colab Worker nào kết nối. Trên Google Colab, vào{' '}
                    <strong>Runtime → Change runtime type → chọn v5e-1 TPU</strong> rồi chạy 2 cell bên dưới.
                  </td>
                </tr>
              ) : (
                workers.map((w) => (
                  <tr key={w.workerId} className="hover:bg-slate-950/50">
                    <td className="py-2.5 pr-4 text-slate-100 font-semibold">{w.workerId}</td>
                    <td className="py-2.5 px-4 text-slate-300">{w.accountEmail}</td>
                    <td className="py-2.5 px-4 text-amber-300">{w.model}</td>
                    <td className="py-2.5 px-4 text-slate-300">
                      {w.gpuName} · {w.vramUsedGb}/{w.vramTotalGb}GB
                    </td>
                    <td className="py-2.5 pl-4 text-right">
                      <span className="text-emerald-400 font-semibold">
                        {w.status} ({w.activeRequests}/{w.maxConcurrency} job)
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Section 2: 2-Cell Colab TPU v5e-1 Code Generator */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold text-slate-100">
              Cấu hình Code Chạy Wan 2.1 1.3B trên Colab TPU v5e-1 (16GB HBM)
            </h3>
            <p className="text-xs text-slate-400">
              Tốn ~8.2GB/16GB HBM · Bắt buộc <code className="font-mono text-amber-300">torch.bfloat16</code> +{' '}
              <code className="font-mono text-amber-300">pipe.enable_vae_tiling()</code> · Giữ cố định{' '}
              <code className="font-mono text-slate-200">832x480, 81 frames, 16fps</code> để TPU chỉ compile XLA graph 1 lần.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <select
              aria-label="Chọn phiên bản Wan 2.1 1.3B"
              value={selectedModel}
              onChange={(e) => onSelectModel(e.target.value as WanModelId)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-amber-300 font-mono"
            >
              <option value="FastVideo/FastWan2.1-T2V-1.3B-Diffusers">
                FastVideo/FastWan2.1-T2V-1.3B-Diffusers (Bản tăng tốc 4 steps)
              </option>
              <option value="Wan-AI/Wan2.1-T2V-1.3B-Diffusers">
                Wan-AI/Wan2.1-T2V-1.3B-Diffusers (Bản gốc chuẩn 30 steps)
              </option>
            </select>

            <select
              aria-label="Chọn loại Runtime Colab"
              value={runtimeType}
              onChange={(e) => setRuntimeType(e.target.value as 'tpu_v5e' | 'cuda_gpu')}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-200"
            >
              <option value="tpu_v5e">Runtime: TPU v5e-1 (16GB HBM)</option>
              <option value="cuda_gpu">Runtime: Tesla T4 / L4 GPU</option>
            </select>

            <input
              aria-label="Worker ID"
              type="text"
              value={customWorkerId}
              onChange={(e) => setCustomWorkerId(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs font-mono text-slate-100 w-40"
            />
          </div>
        </div>

        {/* Cell 1 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-200">
              Cell 1: Cài đặt thư viện
            </span>
            <button
              type="button"
              onClick={handleCopyCell1}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-200 text-xs"
            >
              {copiedCell1 ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedCell1 ? 'Đã chép Cell 1' : 'Copy Cell 1'}</span>
            </button>
          </div>
          <pre className="rounded-xl border border-slate-800 bg-slate-950 p-3.5 text-xs font-mono text-amber-300 overflow-x-auto">
            <code>{cell1InstallCmd}</code>
          </pre>
        </div>

        {/* Cell 2 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-200">
              Cell 2: Tải model {selectedModel} (bfloat16 + enable_vae_tiling) & Kết nối Worker Hub
            </span>
            <button
              type="button"
              onClick={handleCopyCell2}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-200 text-xs"
            >
              {copiedCell2 ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedCell2 ? 'Đã chép Cell 2' : 'Copy Cell 2'}</span>
            </button>
          </div>
          <pre className="rounded-xl border border-slate-800 bg-slate-950 p-4 text-[11px] font-mono text-slate-200 overflow-x-auto max-h-96 leading-relaxed">
            <code>{cell2WorkerScript}</code>
          </pre>
        </div>
      </div>
    </div>
  );
};
