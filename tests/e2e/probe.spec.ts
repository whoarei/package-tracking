import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
const probe = readFileSync(new URL('../../src-tauri/src/probe.js', import.meta.url), 'utf8');

test('extracts only the requested visible shipment and merges international legs', async ({
  page,
}) => {
  await page.route('https://www.kuaidi100.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="internal" style="width:100px;height:100px"><span role="comname">始发物流</span></div><div id="national" style="width:100px;height:100px"><span role="comname">目的物流</span></div>',
    }),
  );
  await page.goto('https://www.kuaidi100.com/');
  await page.evaluate(() => {
    const data = {
      internal: {
        nu: 'SF12345678',
        com: 'origin',
        state: '0',
        data: [{ time: '2026-11-12 10:00:00', context: '已发出' }],
      },
      national: {
        nu: 'SF12345678',
        com: 'destination',
        state: '3',
        data: [{ time: '2026-11-13 10:00:00', context: '已签收' }],
      },
    };
    (window as unknown as { jQuery: unknown }).jQuery = (el: Element) => ({
      data: () => data[el.id as keyof typeof data],
    });
  });
  const result = await page.evaluate<{
    kind: string;
    result: { state: string; events: { context: string }[] };
  }>('(' + probe + ')("SF12345678")');
  expect(result.kind).toBe('success');
  expect(result.result.state).toBe('3');
  expect(result.result.events).toHaveLength(2);
  expect(result.result.events[0].context).toBe('已签收');
  expect((await page.evaluate<{ kind: string }>('(' + probe + ')("SF99999999")')).kind).toBe(
    'pending',
  );
});

test('distinguishes manual verification from unsupported webpage carriers', async ({ page }) => {
  await page.route('https://www.kuaidi100.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="checkCode">请输入手机号后四位</div><div id="queryLimit" style="display:none">小程序查询</div>',
    }),
  );
  await page.goto('https://www.kuaidi100.com/');
  expect((await page.evaluate<{ kind: string }>('(' + probe + ')("SF12345678")')).kind).toBe(
    'attention',
  );
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#checkCode')!.style.display = 'none';
    document.querySelector<HTMLElement>('#queryLimit')!.style.display = 'block';
  });
  expect((await page.evaluate<{ kind: string }>('(' + probe + ')("SF12345678")')).kind).toBe(
    'unavailable',
  );
});

test('an empty logistics result remains retryable rather than requiring manual action', async ({
  page,
}) => {
  await page.route('https://www.kuaidi100.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="errorWrap">抱歉，暂无物流轨迹</div>',
    }),
  );
  await page.goto('https://www.kuaidi100.com/');
  expect((await page.evaluate<{ kind: string }>('(' + probe + ')("SF12345678")')).kind).toBe(
    'failure',
  );
});
