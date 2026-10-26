"""Judge tool calls with an installed vulcan-decision-shell model package.

The host starts this file with a runtime pack's own interpreter in isolated mode
(`python -I -B vulcan_decision_worker.py`) and talks to it in JSON lines: one request object per
stdin line, exactly one response object per stdout line, in order. Diagnostics go to stderr.

Requests carry an `id` the response echoes and an `op`:
- `probe`: report the interpreter, the backend libraries and whether CUDA works.
- `load` with `format`, `root` and `device`: load one model package, replacing any loaded one.
- `judge` with `inputs`: a list of `{settings, rendered}`; answers one result per input, in order.
- `shutdown`: answer and exit.

Responses are `{id, ok: true, result}` or `{id, ok: false, error: {code, message}}`. An error never
carries a decision; the host must treat it as "not allowed".

Two package formats are understood:
- `onnx-delivery`: `runtime-config.json`, `assets/policy-v2.json`, `assets/tokenizer.json` and the
  ONNX graph the config names. Encoding and batching here follow the package's reference adapter.
- `torch-release`: a published model repository with `decision.py`; its own loader verifies the
  weights and runs them, so the result matches the release exactly.
"""

import importlib.util
import itertools
import json
import os
import platform
import sys
import threading
import time
import traceback
from pathlib import Path

LABELS_MESSAGE = 'Criterion order differs from the trained classifier.'


class WorkerError(Exception):
    """A failure with a stable code for the host."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class OnnxDelivery:
    """One ONNX delivery package: fixed policy heads, tokenizer and an ONNX Runtime session."""

    def __init__(self, root: Path, device: str) -> None:
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self.np = np
        self.root = root
        self.device = device
        self.config = json.loads((root / 'runtime-config.json').read_text(encoding='utf-8'))
        self.policy = json.loads((root / 'assets/policy-v2.json').read_text(encoding='utf-8'))
        self.tokenizer = Tokenizer.from_file(str(root / 'assets/tokenizer.json'))
        self.tokenizer.no_truncation()
        self.tokenizer.no_padding()
        self.ids = {name: self.tokenizer.token_to_id(name) for name in ['[CLS]', '[SEP]', '[MASK]', '[PAD]']}
        if any(value is None for value in self.ids.values()):
            raise WorkerError('model_invalid', 'Required tokenizer tokens are missing.')
        if list(self.policy['criteria']) != self.config['labels']:
            raise WorkerError('model_invalid', LABELS_MESSAGE)
        self.heads = {}
        for modes in itertools.product(*(item['modes'] for item in self.policy['options'].values())):
            settings = dict(zip(self.policy['options'], modes, strict=True))
            fragments = [self.policy['core_instructions']] + [item['modes'][settings[key]] for key, item in self.policy['options'].items()]
            head = self._tokens('choice question: ' + ' '.join(fragments))
            options = [[self.ids['[MASK]']] + self._tokens(' ' + label + ': ' + text)[:self.config['option_tokens']]
                       for label, text in self.policy['criteria'].items()]
            budget = self.config['head_tokens'] - sum(map(len, options))
            if budget < 16 or len({tuple(option) for option in options}) != len(options):
                raise WorkerError('model_invalid', 'Fixed policy exceeds the verified head budget.')
            tokens = [self.ids['[CLS]']] + head[:max(8, budget)] + [self.ids['[SEP]']]
            markers = []
            for option in options:
                markers.append(len(tokens))
                tokens.extend(option)
            tokens.append(self.ids['[SEP]'])
            self.heads[modes] = (tokens, markers)

        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        # The CPU layout optimizations of ENABLE_ALL crash ONNX Runtime 1.30 on these graphs;
        # EXTENDED keeps every fusion that does not change the layout.
        options.graph_optimization_level = (ort.GraphOptimizationLevel.ORT_ENABLE_ALL if device == 'cuda'
                                            else ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED)
        if device == 'cuda':
            # The CUDA and cuDNN libraries come from the pack's nvidia wheels, never from the system.
            ort.preload_dlls()
            options.add_session_config_entry('session.use_device_allocator_for_initializers', '1')
            providers = [('CUDAExecutionProvider', {'use_tf32': 0, 'arena_extend_strategy': 'kNextPowerOfTwo',
                                                    'gpu_mem_limit': self.config['gpu_memory_limit_mib'] * 1024 ** 2}),
                         'CPUExecutionProvider']
            requested = 'CUDAExecutionProvider'
        elif device == 'cpu':
            providers = ['CPUExecutionProvider']
            requested = 'CPUExecutionProvider'
        else:
            raise WorkerError('invalid_request', f'Unsupported device {device}.')
        self.session = ort.InferenceSession(str(root / self.config['model_file']), sess_options=options, providers=providers)
        self.session.disable_fallback()
        if self.session.get_providers()[0] != requested:
            raise WorkerError('device_unavailable', f'{requested} was not loaded.')
        self.trim_options = ort.RunOptions()
        if device == 'cuda':
            self.trim_options.add_run_config_entry('memory.enable_memory_arena_shrinkage', 'gpu:0')

    def _tokens(self, text: str) -> list[int]:
        return self.tokenizer.encode(text.replace('[MASK]', ' '), add_special_tokens=False).ids

    def _encode(self, sample: dict) -> dict:
        if set(sample) != {'settings', 'rendered'} or not isinstance(sample['rendered'], str):
            raise WorkerError('invalid_request', 'Input must contain exactly settings and a rendered string.')
        if not isinstance(sample['settings'], dict) or set(sample['settings']) != set(self.policy['options']):
            raise WorkerError('invalid_request', 'Settings must contain all fixed option keys and no other keys.')
        modes = tuple(sample['settings'][key] for key in self.policy['options'])
        if modes not in self.heads:
            raise WorkerError('invalid_request', 'Unsupported fixed option value.')
        head, markers = self.heads[modes]
        tokens = head + self._tokens(sample['rendered']) + [self.ids['[SEP]']]
        if len(tokens) > self.config['max_tokens']:
            raise OverflowError
        return {'ids': tokens, 'markers': list(markers)}

    def _collate(self, rows: list[dict]) -> dict:
        np = self.np
        size = len(rows)
        length = max(len(row['ids']) for row in rows)
        ids = np.full((size, length), self.ids['[PAD]'], dtype=np.int64)
        attention = np.zeros_like(ids)
        for index, row in enumerate(rows):
            ids[index, :len(row['ids'])] = row['ids']
            attention[index, :len(row['ids'])] = 1
        return {'input_ids': ids, 'attention_mask': attention,
                'marker_pos': np.asarray([row['markers'] for row in rows], dtype=np.int64),
                'marker_mask': np.ones((size, len(self.config['labels'])), dtype=np.bool_),
                'qtype': np.zeros(size, dtype=np.int64)}

    def _batches(self, encoded: dict[int, dict]) -> list[list[int]]:
        order = sorted(encoded, key=lambda index: len(encoded[index]['ids']))
        batches, current = [], []
        for index in order:
            length = len(encoded[index]['ids'])
            if current and (len(current) >= min(self.config['micro_batch'], self.config['max_request_items'])
                            or (len(current) + 1) * length > self.config['max_tokens']):
                batches.append(current)
                current = []
            current.append(index)
        if current:
            batches.append(current)
        return batches

    def _decide(self, scores) -> str:
        np = self.np
        if scores.shape != (len(self.config['labels']),) or not np.isfinite(scores).all():
            raise WorkerError('model_failed', 'Invalid model scores.')
        choice = int(np.argmax(scores))
        if choice == 0 and float(scores[0] - max(scores[1:])) < self.config['allow_margin']:
            choice = 1
        return self.config['labels'][choice]

    def predict(self, samples: list[dict]) -> list[dict]:
        output = [None] * len(samples)
        encoded = {}
        for index, sample in enumerate(samples):
            try:
                encoded[index] = self._encode(sample)
            except OverflowError:
                output[index] = {'decision': 'block', 'reason_code': 'input_token_limit', 'model_evaluated': False}
        for indices in self._batches(encoded):
            feed = self._collate([encoded[index] for index in indices])
            long = feed['input_ids'].shape[1] > self.config['arena_trim_above_tokens']
            values = self.session.run(['logits'], feed, self.trim_options if long else None)[0]
            if values.shape != (len(indices), len(self.config['labels'])):
                raise WorkerError('model_failed', 'The model answered an unexpected shape.')
            for index, scores in zip(indices, values, strict=True):
                output[index] = {'decision': self._decide(scores), 'logits': [float(x) for x in scores],
                                 'input_tokens': len(encoded[index]['ids']), 'model_evaluated': True}
        return output


class TorchRelease:
    """One published model repository, run through the release's own `decision.py`."""

    def __init__(self, root: Path, device: str) -> None:
        if device not in ('cpu', 'cuda'):
            raise WorkerError('invalid_request', f'Unsupported device {device}.')
        import torch
        if device == 'cuda' and not torch.cuda.is_available():
            raise WorkerError('device_unavailable', 'CUDA is not available to torch.')
        spec = importlib.util.spec_from_file_location('vulcan_decision_release', root / 'decision.py')
        if spec is None or spec.loader is None:
            raise WorkerError('model_invalid', 'decision.py cannot be loaded.')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        # The release default: fp32 weights, fp16 autocast on CUDA. Converted storage is never used.
        self.shell = module.DecisionShell(root, device=device, precision='original')

    def predict(self, samples: list[dict]) -> list[dict]:
        try:
            return self.shell.predict(samples)
        except ValueError as error:
            raise WorkerError('invalid_request', str(error)) from error


FORMATS = {'onnx-delivery': OnnxDelivery, 'torch-release': TorchRelease}


class Worker:
    def __init__(self) -> None:
        self.model = None
        self.loaded = None
        self.lock = threading.Lock()

    def probe(self) -> dict:
        result = {'python': platform.python_version(), 'machine': platform.machine(), 'system': platform.system()}
        try:
            import onnxruntime as ort
            result['onnxruntime'] = ort.__version__
            result['onnx_providers'] = ort.get_available_providers()
        except ImportError:
            pass
        try:
            import torch
            result['torch'] = torch.__version__
            result['torch_cuda'] = torch.version.cuda
            if torch.cuda.is_available():
                result['cuda_devices'] = [{'name': torch.cuda.get_device_name(index),
                                           'capability': '.'.join(map(str, torch.cuda.get_device_capability(index)))}
                                          for index in range(torch.cuda.device_count())]
            else:
                result['cuda_devices'] = []
        except ImportError:
            pass
        return result

    def load(self, request: dict) -> dict:
        kind = FORMATS.get(request.get('format'))
        root = request.get('root')
        device = request.get('device')
        if kind is None or not isinstance(root, str) or not isinstance(device, str):
            raise WorkerError('invalid_request', 'load needs a known format, a root and a device.')
        path = Path(root)
        if not path.is_dir():
            raise WorkerError('model_invalid', 'The model directory does not exist.')
        self.model = None
        self.loaded = None
        started = time.perf_counter()
        self.model = kind(path.resolve(), device)
        self.loaded = {'format': request['format'], 'root': str(path), 'device': device}
        return {'load_seconds': round(time.perf_counter() - started, 3), **self.loaded}

    def judge(self, request: dict) -> list[dict]:
        if self.model is None:
            raise WorkerError('model_not_loaded', 'No model is loaded.')
        inputs = request.get('inputs')
        if not isinstance(inputs, list) or not inputs:
            raise WorkerError('invalid_request', 'At least one input is required.')
        results = self.model.predict(inputs)
        if len(results) != len(inputs) or any(item is None for item in results):
            raise WorkerError('model_failed', 'The model did not answer every input.')
        return results

    def handle(self, request: dict) -> object:
        op = request.get('op')
        if op == 'probe':
            return self.probe()
        if op == 'load':
            return self.load(request)
        if op == 'judge':
            return self.judge(request)
        if op == 'shutdown':
            return {}
        raise WorkerError('invalid_request', f'Unknown op {op!r}.')


def main() -> None:
    # The protocol owns the real stdout; anything a library prints, from Python or native code,
    # lands on stderr instead of corrupting a response line.
    protocol = os.fdopen(os.dup(1), 'w', encoding='utf-8', newline='\n')
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    worker = Worker()
    for line in sys.stdin.buffer:
        text = line.decode('utf-8').strip()
        if not text:
            continue
        request_id = None
        op = None
        try:
            request = json.loads(text)
            if not isinstance(request, dict):
                raise WorkerError('invalid_request', 'A request must be an object.')
            request_id = request.get('id')
            op = request.get('op')
            response = {'id': request_id, 'ok': True, 'result': worker.handle(request)}
        except WorkerError as error:
            response = {'id': request_id, 'ok': False, 'error': {'code': error.code, 'message': str(error)}}
        except json.JSONDecodeError as error:
            response = {'id': request_id, 'ok': False, 'error': {'code': 'invalid_request', 'message': str(error)}}
        except Exception as error:  # noqa: BLE001 - every failure must reach the host as an error
            traceback.print_exc()
            response = {'id': request_id, 'ok': False, 'error': {'code': 'model_failed', 'message': f'{type(error).__name__}: {error}'}}
        protocol.write(json.dumps(response, ensure_ascii=False, allow_nan=False) + '\n')
        protocol.flush()
        if op == 'shutdown':
            break


if __name__ == '__main__':
    main()
