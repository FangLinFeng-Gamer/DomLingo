import type {
  CancelSessionMessage,
  PageTranslationFailureCode,
  PageTranslationFailureDetails,
  PageTranslationStatus,
  TranslateBatchMessage,
  TranslateBatchResponse,
} from '../messaging/protocol';
import { buildTranslationBatches, mapWithConcurrency } from '../translation/batching';
import type { TranslationBlock } from '../translation/types';
import { detectMainContentAsync } from './main-content';
import {
  applyTranslations,
  collectPageSourcesAsync,
  restoreOriginals,
  type SourceRecord,
} from './source-collector';

export interface TranslationSessionOptions {
  batchCharacterLimit: number;
  concurrency: number;
}

const IDLE_STATUS: PageTranslationStatus = {
  state: 'idle',
  total: 0,
  translated: 0,
  failed: 0,
  failureDetails: {},
  message: '尚未开始翻译。',
};

const FAILURE_LABELS: Record<PageTranslationFailureCode, string> = {
  AUTHENTICATION_FAILED: '认证失败',
  ENDPOINT_NOT_FOUND: '接口或模型不存在',
  INVALID_REQUEST: '请求被拒绝',
  INVALID_RESPONSE: '响应格式错误',
  NETWORK_ERROR: '网络错误',
  OUTPUT_TRUNCATED: '模型输出被截断',
  RATE_LIMITED: '服务限流',
  REQUEST_TIMEOUT: '请求超时',
  SERVER_ERROR: '服务端错误',
  SESSION_CANCELLED: '会话已取消',
  STALE_DOM: '页面节点已变化',
  MISSING_ID: '模型漏回 ID',
  DUPLICATE_ID: '模型返回重复 ID',
  INVALID_TEXT: '译文内容无效',
};

function buildFailureDetails(
  records: SourceRecord[],
  translations: ReadonlyMap<string, string>,
  processedSegmentIds: ReadonlySet<string>,
  segmentFailures: ReadonlyMap<string, PageTranslationFailureCode>,
  staleRecordIds: ReadonlySet<string>,
  includePending: boolean,
): PageTranslationFailureDetails {
  const details: PageTranslationFailureDetails = {};
  const recordsByTransaction = new Map<string, SourceRecord[]>();
  for (const record of records) {
    const transactionId = record.kind === 'text-node' ? record.blockId : record.id;
    const transaction = recordsByTransaction.get(transactionId) ?? [];
    transaction.push(record);
    recordsByTransaction.set(transactionId, transaction);
  }

  for (const record of records) {
    if (record.appliedValue !== undefined) continue;
    const transactionId = record.kind === 'text-node' ? record.blockId : record.id;
    const transaction = recordsByTransaction.get(transactionId) ?? [record];
    const processed = transaction.every((transactionRecord) =>
      transactionRecord.segments.every(
        (segment) => translations.has(segment.id) || processedSegmentIds.has(segment.id),
      ),
    );
    if (!processed && !includePending) continue;

    const reason = transaction.some((transactionRecord) => staleRecordIds.has(transactionRecord.id))
      ? 'STALE_DOM'
      : (transaction.flatMap((transactionRecord) =>
          transactionRecord.segments.flatMap((segment) => {
            const failure = segmentFailures.get(segment.id);
            return failure ? [failure] : [];
          }),
        )[0] ?? 'MISSING_ID');
    details[reason] = (details[reason] ?? 0) + 1;
  }
  return details;
}

function failureCount(details: PageTranslationFailureDetails): number {
  return Object.values(details).reduce((total, count) => total + (count ?? 0), 0);
}

function formatFailureDetails(details: PageTranslationFailureDetails): string {
  return Object.entries(details)
    .filter((entry): entry is [PageTranslationFailureCode, number] => (entry[1] ?? 0) > 0)
    .map(([code, count]) => `${FAILURE_LABELS[code]} ${count}`)
    .join('、');
}

export class PageTranslationSession {
  private status: PageTranslationStatus = { ...IDLE_STATUS };
  private root: HTMLElement | undefined;
  private records: SourceRecord[] = [];
  private blocks: TranslationBlock[] = [];
  private sessionId = '';
  private generation = 0;
  private lastOptions: TranslationSessionOptions | undefined;
  private readonly translations = new Map<string, string>();

  constructor(
    private readonly document: Document,
    private readonly onStatusChange: (status: PageTranslationStatus) => void = () => undefined,
  ) {}

  getStatus(): PageTranslationStatus {
    return { ...this.status, failureDetails: { ...this.status.failureDetails } };
  }

  private setStatus(status: PageTranslationStatus): void {
    this.status = status;
    this.onStatusChange(this.getStatus());
  }

  start(options: TranslationSessionOptions): void {
    if (this.status.state === 'scanning' || this.status.state === 'translating') return;
    if (this.records.some((record) => record.appliedValue !== undefined)) {
      this.setStatus({
        ...this.status,
        state: 'completed',
        message: '当前页面已经翻译，可先恢复原文。',
      });
      return;
    }

    this.lastOptions = options;
    const expectedGeneration = this.generation + 1;
    void this.run(options).catch(() => {
      if (this.generation !== expectedGeneration) return;
      this.setStatus({
        ...this.status,
        state: 'error',
        message: '翻译过程中发生错误，页面中已完成的内容保持不变。',
      });
    });
  }

  stop(): PageTranslationStatus {
    if (this.status.state !== 'scanning' && this.status.state !== 'translating') {
      return this.getStatus();
    }

    const cancelledSessionId = this.sessionId;
    this.generation += 1;
    const remaining = this.records.filter((record) => record.appliedValue === undefined).length;
    const newlyCancelled = Math.max(0, remaining - this.status.failed);
    this.setStatus({
      ...this.status,
      state: 'stopped',
      failed: remaining,
      failureDetails: {
        ...this.status.failureDetails,
        ...(newlyCancelled > 0 ? { SESSION_CANCELLED: newlyCancelled } : {}),
      },
      message: '已停止翻译，已完成的译文仍保留在页面中。',
    });
    if (cancelledSessionId) this.cancelBackgroundSession(cancelledSessionId);
    return this.getStatus();
  }

  invalidateForNavigation(): PageTranslationStatus {
    if (
      this.status.state === 'idle' ||
      (this.status.state === 'stopped' && this.records.length === 0 && !this.sessionId)
    ) {
      return this.getStatus();
    }

    const cancelledSessionId = this.sessionId;
    this.generation += 1;
    if (cancelledSessionId) this.cancelBackgroundSession(cancelledSessionId);
    this.root = undefined;
    this.records = [];
    this.blocks = [];
    this.translations.clear();
    this.sessionId = '';
    this.setStatus({
      ...IDLE_STATUS,
      state: 'stopped',
      message: '页面已导航，旧翻译会话已停止。请重新点击翻译当前页面。',
    });
    return this.getStatus();
  }

  restore(): PageTranslationStatus {
    const cancelledSessionId = this.sessionId;
    this.generation += 1;
    if (cancelledSessionId) this.cancelBackgroundSession(cancelledSessionId);

    if (this.root) restoreOriginals(this.root, this.records);
    this.root = undefined;
    this.records = [];
    this.blocks = [];
    this.translations.clear();
    this.sessionId = '';
    this.setStatus({ ...IDLE_STATUS, message: '已恢复本次会话修改的原文。' });
    return this.getStatus();
  }

  retryFailed(options = this.lastOptions): PageTranslationStatus {
    if (this.status.state === 'scanning' || this.status.state === 'translating') {
      return this.getStatus();
    }
    if (!options || !this.root || this.records.length === 0 || this.blocks.length === 0) {
      return this.getStatus();
    }

    const failedRecords = this.records.filter((record) => record.appliedValue === undefined);
    if (failedRecords.length === 0) return this.getStatus();

    const failedSegmentIds = new Set(
      failedRecords.flatMap((record) =>
        record.segments.flatMap((segment) =>
          this.translations.has(segment.id) ? [] : [segment.id],
        ),
      ),
    );
    const retryBlocks = this.blocks.flatMap((block) => {
      const segments = block.segments.filter((segment) => failedSegmentIds.has(segment.id));
      return segments.length > 0 ? [{ ...block, segments }] : [];
    });
    if (retryBlocks.length === 0) return this.getStatus();

    this.lastOptions = options;
    this.generation += 1;
    const generation = this.generation;
    this.sessionId = crypto.randomUUID();
    this.setStatus({
      ...this.status,
      state: 'translating',
      failed: 0,
      failureDetails: {},
      message: `正在重试 ${failedRecords.length} 个失败节点…`,
    });
    void this.translateBlocks(retryBlocks, options, generation).catch(() => {
      if (this.generation !== generation) return;
      this.setStatus({
        ...this.status,
        state: 'error',
        message: '重试失败内容时发生错误，页面中已完成的译文保持不变。',
      });
    });
    return this.getStatus();
  }

  private cancelBackgroundSession(sessionId: string): void {
    const message: CancelSessionMessage = { version: 1, type: 'CANCEL_SESSION', sessionId };
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  }

  private async run(options: TranslationSessionOptions): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    this.sessionId = crypto.randomUUID();
    this.translations.clear();
    this.setStatus({ ...IDLE_STATUS, state: 'scanning', message: '正在识别网页正文…' });

    const detection = await detectMainContentAsync(this.document, {
      shouldContinue: () => generation === this.generation,
    });
    if (generation !== this.generation) return;
    if (!detection) {
      this.setStatus({
        ...IDLE_STATUS,
        state: 'error',
        message: '未识别到正文区域，本页未进行任何修改。',
      });
      return;
    }

    const collected = await collectPageSourcesAsync(detection.root, this.sessionId);
    if (generation !== this.generation) return;
    if (collected.records.length === 0) {
      this.setStatus({
        ...IDLE_STATUS,
        state: 'error',
        message: '正文中没有找到可翻译的英文内容。',
      });
      return;
    }

    this.root = detection.root;
    this.records = collected.records;
    this.blocks = collected.blocks;
    this.setStatus({
      state: 'translating',
      total: collected.records.length,
      translated: 0,
      failed: 0,
      failureDetails: {},
      message: `正在翻译 0 / ${collected.records.length}…`,
    });
    await this.translateBlocks(collected.blocks, options, generation);
  }

  private async translateBlocks(
    sourceBlocks: TranslationBlock[],
    options: TranslationSessionOptions,
    generation: number,
  ): Promise<void> {
    const batches = buildTranslationBatches(sourceBlocks, options.batchCharacterLimit);

    let lastError = '';
    const processedSegmentIds = new Set<string>();
    const segmentFailures = new Map<string, PageTranslationFailureCode>();
    const staleRecordIds = new Set<string>();

    const commitBatch = (blocks: TranslationBlock[], response: TranslateBatchResponse): void => {
      if (!this.root) return;
      for (const block of blocks) {
        for (const segment of block.segments) processedSegmentIds.add(segment.id);
      }

      if (!response.ok) {
        lastError = response.message ?? '模型服务没有返回有效结果。';
        for (const block of blocks) {
          for (const segment of block.segments) {
            segmentFailures.set(segment.id, response.code);
          }
        }
      } else {
        for (const translation of response.result.translations) {
          this.translations.set(translation.id, translation.text);
        }
        for (const failure of response.result.failures) {
          segmentFailures.set(failure.id, failure.reason);
        }
        const mutation = applyTranslations(this.root, this.records, this.translations);
        for (const recordId of mutation.staleRecordIds) staleRecordIds.add(recordId);
      }

      const failureDetails = buildFailureDetails(
        this.records,
        this.translations,
        processedSegmentIds,
        segmentFailures,
        staleRecordIds,
        false,
      );
      this.status.translated = this.records.filter(
        (record) => record.appliedValue !== undefined,
      ).length;
      this.status.failed = failureCount(failureDetails);
      this.status.failureDetails = failureDetails;
      this.setStatus({
        ...this.status,
        message: `正在翻译 ${this.status.translated + this.status.failed} / ${this.status.total}…`,
      });
    };

    await mapWithConcurrency(batches, options.concurrency, async (blocks, batchIndex) => {
      if (generation !== this.generation || !this.root) return;

      const message: TranslateBatchMessage = {
        version: 1,
        type: 'TRANSLATE_BATCH',
        payload: {
          requestId: `${this.sessionId}:request:${batchIndex + 1}`,
          sessionId: this.sessionId,
          generation,
          blocks,
        },
      };

      let response: TranslateBatchResponse;
      try {
        response = (await chrome.runtime.sendMessage(message)) as TranslateBatchResponse;
      } catch {
        response = {
          ok: false,
          code: 'NETWORK_ERROR',
          message: '无法连接扩展后台，请重新加载扩展后再试。',
        };
      }

      if (generation !== this.generation || !this.root) return;
      commitBatch(blocks, response);
    });

    if (generation !== this.generation) return;
    const finalFailureDetails = buildFailureDetails(
      this.records,
      this.translations,
      processedSegmentIds,
      segmentFailures,
      staleRecordIds,
      true,
    );
    this.status.failureDetails = finalFailureDetails;
    this.status.failed = failureCount(finalFailureDetails);
    const finalState = this.status.translated > 0 ? 'completed' : 'error';
    const failureSummary = formatFailureDetails(finalFailureDetails);
    this.setStatus({
      ...this.status,
      state: finalState,
      message:
        finalState === 'completed'
          ? `翻译完成：成功 ${this.status.translated}，失败 ${this.status.failed}。${failureSummary ? `失败原因：${failureSummary}。` : ''}`
          : `${lastError || '没有节点翻译成功，页面保持原文。'}${failureSummary ? ` 失败原因：${failureSummary}。` : ''}`,
    });
  }
}
