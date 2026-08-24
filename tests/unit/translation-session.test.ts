import { afterEach, describe, expect, it, vi } from 'vitest';

import { PageTranslationSession } from '../../src/content/translation-session';
import type { TranslateBatchMessage } from '../../src/messaging/protocol';

describe('PageTranslationSession', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('translates collected nodes and restores their exact originals', async () => {
    document.body.innerHTML = `
      <main>
        <h1>A complete translation workflow</h1>
        <p>This paragraph contains enough English text for the main content detector.</p>
        <p>The second paragraph verifies that several nodes can be translated safely.</p>
      </main>
    `;
    const originalHtml = document.querySelector('main')!.innerHTML;
    const sendMessage = vi.fn(async (message: TranslateBatchMessage) => ({
      ok: true,
      result: {
        translations: message.payload.blocks.flatMap((block) =>
          block.segments.map((segment) => ({ id: segment.id, text: `中文:${segment.text}` })),
        ),
        failedIds: [],
        failures: [],
      },
    }));
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    const session = new PageTranslationSession(document);
    session.start({ batchCharacterLimit: 4_000, concurrency: 2 });

    await vi.waitFor(() => expect(session.getStatus().state).toBe('completed'));
    expect(session.getStatus().translated).toBeGreaterThan(0);
    expect(document.querySelector('main')?.textContent).toContain('中文:');

    session.restore();
    expect(document.querySelector('main')?.innerHTML).toBe(originalHtml);
  });

  it('applies valid sibling nodes when another result is missing', async () => {
    document.body.innerHTML = `
      <main>
        <h1>A reliable partial translation example</h1>
        <p>This first paragraph should receive a valid translated result.</p>
        <p>This second paragraph deliberately remains untranslated after a node failure.</p>
      </main>
    `;
    const sendMessage = vi.fn(async (message: TranslateBatchMessage) => {
      const segments = message.payload.blocks.flatMap((block) => block.segments);
      return {
        ok: true,
        result: {
          translations: [{ id: segments[1]!.id, text: '部分有效译文。' }],
          failedIds: segments.filter((_segment, index) => index !== 1).map((segment) => segment.id),
          failures: segments
            .filter((_segment, index) => index !== 1)
            .map((segment) => ({ id: segment.id, reason: 'MISSING_ID' as const })),
        },
      };
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    const session = new PageTranslationSession(document);
    session.start({ batchCharacterLimit: 4_000, concurrency: 1 });

    await vi.waitFor(() => expect(session.getStatus().state).toBe('completed'));
    expect(session.getStatus().translated).toBe(1);
    expect(session.getStatus().failed).toBeGreaterThan(0);
    expect(session.getStatus().failureDetails.MISSING_ID).toBeGreaterThan(0);
    expect(session.getStatus().message).toContain('模型漏回 ID');
    expect(document.querySelector('main')?.textContent).toContain('部分有效译文。');
    expect(document.querySelector('main')?.textContent).toContain(
      'This second paragraph deliberately remains untranslated after a node failure.',
    );
  });

  it('does not write a late batch response after the user stops translation', async () => {
    document.body.innerHTML = `
      <main>
        <h1>A cancellable translation workflow</h1>
        <p>This paragraph waits for a deliberately delayed model response.</p>
        <p>Stopping the session must keep every original node unchanged.</p>
      </main>
    `;
    const originalText = document.querySelector('main')!.textContent;
    let pendingMessage: TranslateBatchMessage | undefined;
    let resolveBatch: ((response: unknown) => void) | undefined;
    const batchPromise = new Promise((resolve) => {
      resolveBatch = resolve;
    });
    const sendMessage = vi.fn((message: { type?: string }) => {
      if (message.type === 'TRANSLATE_BATCH') {
        pendingMessage = message as TranslateBatchMessage;
        return batchPromise;
      }
      return Promise.resolve({ ok: true });
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    const session = new PageTranslationSession(document);
    session.start({ batchCharacterLimit: 4_000, concurrency: 1 });
    await vi.waitFor(() => expect(pendingMessage).toBeDefined());
    session.stop();

    const translations = pendingMessage!.payload.blocks.flatMap((block) =>
      block.segments.map((segment) => ({ id: segment.id, text: '不应写入的迟到译文' })),
    );
    resolveBatch?.({ ok: true, result: { translations, failedIds: [], failures: [] } });
    await Promise.resolve();

    expect(session.getStatus().state).toBe('stopped');
    expect(document.querySelector('main')?.textContent).toBe(originalText);
  });

  it('invalidates a navigating document and can translate the replacement page', async () => {
    document.body.innerHTML = `
      <main>
        <h1>An old route with pending translation</h1>
        <p>This response must not be written after client-side navigation.</p>
      </main>
    `;
    let pendingMessage: TranslateBatchMessage | undefined;
    let resolvePending: ((response: unknown) => void) | undefined;
    const pendingResponse = new Promise((resolve) => {
      resolvePending = resolve;
    });
    let usePendingResponse = true;
    const successfulResponse = (message: TranslateBatchMessage) => ({
      ok: true,
      result: {
        translations: message.payload.blocks.flatMap((block) =>
          block.segments.map((segment) => ({ id: segment.id, text: '新页面译文' })),
        ),
        failedIds: [],
        failures: [],
      },
    });
    const sendMessage = vi.fn((message: { type?: string }) => {
      if (message.type !== 'TRANSLATE_BATCH') return Promise.resolve({ ok: true });
      const batch = message as TranslateBatchMessage;
      if (usePendingResponse) {
        pendingMessage = batch;
        return pendingResponse;
      }
      return Promise.resolve(successfulResponse(batch));
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    const session = new PageTranslationSession(document);
    session.start({ batchCharacterLimit: 2_000, concurrency: 1 });
    await vi.waitFor(() => expect(pendingMessage).toBeDefined());
    session.invalidateForNavigation();
    expect(session.getStatus()).toMatchObject({ state: 'stopped', total: 0 });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'CANCEL_SESSION' }));

    document.body.innerHTML = `
      <main>
        <h1>A replacement route ready for translation</h1>
        <p>This new route should start a fresh translation generation.</p>
      </main>
    `;
    usePendingResponse = false;
    session.start({ batchCharacterLimit: 2_000, concurrency: 1 });
    await vi.waitFor(() => expect(session.getStatus().state).toBe('completed'));
    expect(document.querySelector('main')?.textContent).toContain('新页面译文');

    resolvePending?.(successfulResponse(pendingMessage!));
    await Promise.resolve();
    expect(document.querySelector('main')?.textContent).not.toContain('old route');
  });

  it('clears a manually stopped session when the page navigates', async () => {
    document.body.innerHTML = `
      <main>
        <h1>An article stopped before navigation</h1>
        <p>This old document keeps collected records until its route changes.</p>
      </main>
    `;
    let pendingMessage: TranslateBatchMessage | undefined;
    let resolvePending: ((response: unknown) => void) | undefined;
    const pendingResponse = new Promise((resolve) => {
      resolvePending = resolve;
    });
    let usePendingResponse = true;
    const sendMessage = vi.fn((message: { type?: string }) => {
      if (message.type !== 'TRANSLATE_BATCH') return Promise.resolve({ ok: true });
      const batch = message as TranslateBatchMessage;
      if (usePendingResponse) {
        pendingMessage = batch;
        return pendingResponse;
      }
      return Promise.resolve({
        ok: true,
        result: {
          translations: batch.payload.blocks.flatMap((block) =>
            block.segments.map((segment) => ({ id: segment.id, text: '停止后导航的新译文' })),
          ),
          failedIds: [],
          failures: [],
        },
      });
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    const session = new PageTranslationSession(document);
    session.start({ batchCharacterLimit: 2_000, concurrency: 1 });
    await vi.waitFor(() => expect(pendingMessage).toBeDefined());
    session.stop();
    session.invalidateForNavigation();

    document.body.innerHTML = `
      <main>
        <h1>A new route after the stopped session</h1>
        <p>This document must be collected as a completely fresh translation session.</p>
      </main>
    `;
    usePendingResponse = false;
    session.start({ batchCharacterLimit: 2_000, concurrency: 1 });
    await vi.waitFor(() => expect(session.getStatus().state).toBe('completed'));
    expect(document.querySelector('main')?.textContent).toContain('停止后导航的新译文');

    resolvePending?.({ ok: false, code: 'CANCELLED', message: '旧请求已取消。' });
    await Promise.resolve();
    expect(session.getStatus().state).toBe('completed');
  });

  it('does not start translation after the user stops during a time-sliced scan', async () => {
    document.body.innerHTML = `<main><h1>A large cancellable article</h1>${Array.from(
      { length: 300 },
      (_value, index) => `<p>Paragraph ${index} contains enough English text for scanning.</p>`,
    ).join('')}</main>`;
    const originalText = document.querySelector('main')!.textContent;
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      void message;
      return { ok: true };
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    const session = new PageTranslationSession(document);
    session.start({ batchCharacterLimit: 4_000, concurrency: 1 });
    expect(session.getStatus().state).toBe('scanning');
    session.stop();
    await new Promise((resolve) => window.setTimeout(resolve, 20));

    expect(session.getStatus().state).toBe('stopped');
    expect(sendMessage.mock.calls.some(([message]) => message.type === 'TRANSLATE_BATCH')).toBe(
      false,
    );
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'CANCEL_SESSION' }));
    expect(document.querySelector('main')?.textContent).toBe(originalText);
  });

  it('reports a provider batch failure separately from missing model IDs', async () => {
    document.body.innerHTML = `
      <main>
        <h1>A rate limited translation request</h1>
        <p>This paragraph remains unchanged when the provider rejects its batch.</p>
      </main>
    `;
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === 'TRANSLATE_BATCH') {
        return {
          ok: false,
          code: 'RATE_LIMITED',
          message: '模型服务请求过于频繁，请稍后重试。',
        };
      }
      return { ok: true };
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    const session = new PageTranslationSession(document);
    session.start({ batchCharacterLimit: 4_000, concurrency: 1 });

    await vi.waitFor(() => expect(session.getStatus().state).toBe('error'));
    expect(session.getStatus().failureDetails).toEqual({ RATE_LIMITED: 2 });
    expect(session.getStatus().message).toContain('服务限流 2');
    expect(session.getStatus().failureDetails.MISSING_ID).toBeUndefined();
  });

  it('writes completed semantic blocks without waiting for an earlier slow batch', async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 30 },
      (_value, index) => `<p>Ordered paragraph ${index + 1} contains translatable English.</p>`,
    ).join('')}</main>`;
    const messages: TranslateBatchMessage[] = [];
    let resolveFirst: ((response: unknown) => void) | undefined;
    const firstResponse = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const responseFor = (message: TranslateBatchMessage) => ({
      ok: true,
      result: {
        translations: message.payload.blocks.flatMap((block) =>
          block.segments.map((segment) => ({ id: segment.id, text: `译文:${segment.text}` })),
        ),
        failedIds: [],
        failures: [],
      },
    });
    const sendMessage = vi.fn((message: { type?: string }) => {
      if (message.type !== 'TRANSLATE_BATCH') return Promise.resolve({ ok: true });
      const batch = message as TranslateBatchMessage;
      messages.push(batch);
      return messages.length === 1 ? firstResponse : Promise.resolve(responseFor(batch));
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    const session = new PageTranslationSession(document);
    session.start({ batchCharacterLimit: 2_000, concurrency: 3 });
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(1));
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll('p')].some((paragraph) =>
          paragraph.textContent?.startsWith('译文:'),
        ),
      ).toBe(true),
    );

    expect(document.querySelector('p')?.textContent).toContain('Ordered paragraph 1');
    expect(session.getStatus().translated).toBeGreaterThan(0);
    expect(session.getStatus().translated).toBeLessThan(30);
    resolveFirst?.(responseFor(messages[0]!));
    await vi.waitFor(() => expect(session.getStatus().state).toBe('completed'));

    expect(session.getStatus().translated).toBe(30);
  });

  it('keeps a semantic block atomic while unrelated completed blocks write immediately', async () => {
    const longParagraph = `${'A'.repeat(900)}. ${'B'.repeat(900)}. ${'C'.repeat(900)}.`;
    document.body.innerHTML = `
      <main>
        <p id="long">${longParagraph}</p>
        <p id="independent">An independent paragraph can be displayed as soon as it is ready.</p>
      </main>
    `;
    const messages: TranslateBatchMessage[] = [];
    let resolveFirst: ((response: unknown) => void) | undefined;
    const firstResponse = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const responseFor = (message: TranslateBatchMessage) => ({
      ok: true,
      result: {
        translations: message.payload.blocks.flatMap((block) =>
          block.segments.map((segment) => ({ id: segment.id, text: `译文:${segment.text}` })),
        ),
        failedIds: [],
        failures: [],
      },
    });
    const sendMessage = vi.fn((message: { type?: string }) => {
      if (message.type !== 'TRANSLATE_BATCH') return Promise.resolve({ ok: true });
      const batch = message as TranslateBatchMessage;
      messages.push(batch);
      return messages.length === 1 ? firstResponse : Promise.resolve(responseFor(batch));
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    const session = new PageTranslationSession(document);
    session.start({ batchCharacterLimit: 2_000, concurrency: 3 });

    await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(3));
    await vi.waitFor(() =>
      expect(document.querySelector('#independent')?.textContent).toContain('译文:'),
    );
    expect(document.querySelector('#long')?.textContent).toBe(longParagraph);

    resolveFirst?.(responseFor(messages[0]!));
    await vi.waitFor(() => expect(session.getStatus().state).toBe('completed'));
    expect(document.querySelector('#long')?.textContent).toContain('译文:');
  });

  it('retries only records that are still untranslated', async () => {
    document.body.innerHTML = `
      <main>
        <h1>A retryable article title</h1>
        <p>The first retryable paragraph.</p>
        <p>The second retryable paragraph.</p>
      </main>
    `;
    const messages: TranslateBatchMessage[] = [];
    let successfulId = '';
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type !== 'TRANSLATE_BATCH') return { ok: true };
      const batch = message as TranslateBatchMessage;
      messages.push(batch);
      const segments = batch.payload.blocks.flatMap((block) => block.segments);
      if (messages.length === 1) {
        successfulId = segments[0]!.id;
        return {
          ok: true,
          result: {
            translations: [{ id: successfulId, text: '首次成功译文。' }],
            failedIds: segments.slice(1).map((segment) => segment.id),
            failures: segments
              .slice(1)
              .map((segment) => ({ id: segment.id, reason: 'INVALID_RESPONSE' as const })),
          },
        };
      }
      return responseForRetry(batch);
    });
    const responseForRetry = (message: TranslateBatchMessage) => ({
      ok: true,
      result: {
        translations: message.payload.blocks.flatMap((block) =>
          block.segments.map((segment) => ({ id: segment.id, text: '重试成功译文。' })),
        ),
        failedIds: [],
        failures: [],
      },
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    const session = new PageTranslationSession(document);
    session.start({ batchCharacterLimit: 4_000, concurrency: 1 });
    await vi.waitFor(() => expect(session.getStatus().state).toBe('completed'));
    expect(session.getStatus()).toMatchObject({ translated: 1, failed: 2 });

    session.retryFailed();
    expect(session.getStatus().state).toBe('translating');
    await vi.waitFor(() => expect(session.getStatus().state).toBe('completed'));
    expect(session.getStatus().failed).toBe(0);
    expect(session.getStatus().translated).toBe(3);
    const retryIds = messages[1]!.payload.blocks.flatMap((block) =>
      block.segments.map((segment) => segment.id),
    );
    expect(retryIds).not.toContain(successfulId);
    expect(retryIds).toHaveLength(2);
  });

  it('keeps an inline-code list item original until retry completes its semantic block', async () => {
    document.body.innerHTML = `
      <main>
        <h1>Agent Skills name requirements</h1>
        <ul>
          <li id="rule">May only contain <code>a-z</code> and hyphens <code>-</code> in the directory name.</li>
        </ul>
        <p>This supporting paragraph makes the documentation body detectable.</p>
      </main>
    `;
    const messages: TranslateBatchMessage[] = [];
    let cachedSuccessfulId = '';
    const sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type !== 'TRANSLATE_BATCH') return { ok: true };
      const batch = message as TranslateBatchMessage;
      messages.push(batch);
      const segments = batch.payload.blocks.flatMap((block) => block.segments);
      if (messages.length === 1) {
        const ruleBlock = batch.payload.blocks.find((block) =>
          block.context.includes('May only contain'),
        )!;
        cachedSuccessfulId = ruleBlock.segments[0]!.id;
        const failedSegments = segments.filter((segment) => segment.id !== cachedSuccessfulId);
        return {
          ok: true,
          result: {
            translations: [{ id: cachedSuccessfulId, text: '只能包含' }],
            failedIds: failedSegments.map((segment) => segment.id),
            failures: failedSegments.map((segment) => ({
              id: segment.id,
              reason: 'OUTPUT_TRUNCATED' as const,
            })),
          },
        };
      }
      return {
        ok: true,
        result: {
          translations: segments.map((segment) => ({ id: segment.id, text: '补全译文' })),
          failedIds: [],
          failures: [],
        },
      };
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    const session = new PageTranslationSession(document);
    session.start({ batchCharacterLimit: 2_000, concurrency: 1 });
    await vi.waitFor(() => expect(session.getStatus().state).toBe('error'));
    expect(document.querySelector('#rule')?.textContent).toContain('and hyphens');
    expect(session.getStatus().failureDetails.OUTPUT_TRUNCATED).toBeGreaterThan(0);

    session.retryFailed();
    await vi.waitFor(() => expect(session.getStatus().state).toBe('completed'));
    const retryIds = messages[1]!.payload.blocks.flatMap((block) =>
      block.segments.map((segment) => segment.id),
    );
    expect(retryIds).not.toContain(cachedSuccessfulId);
    expect(document.querySelector('#rule')?.textContent).not.toContain('and hyphens');
    expect(document.querySelector('#rule code')?.textContent).toBe('a-z');
    expect(session.getStatus()).toMatchObject({ failed: 0 });
  });
});
