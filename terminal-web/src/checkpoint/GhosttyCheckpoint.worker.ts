import { GhosttyCheckpointWorkerRuntime } from './GhosttyCheckpointWorkerRuntime';

const workerScope = globalThis as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
};

const runtime = new GhosttyCheckpointWorkerRuntime({
  postMessage: (message, transfer) => workerScope.postMessage(message, transfer),
});

workerScope.addEventListener('message', event => {
  void runtime.handle(event.data);
});
