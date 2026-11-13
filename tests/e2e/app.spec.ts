import { expect, test } from '@playwright/test';
import { defaultSettings, idleJob, type Shipment } from '../../src/types';

const fixture: Shipment[] = [
  {
    id: '1',
    number: 'SF1000000000001',
    carrier: 'shunfeng',
    carrierName: '顺丰速运',
    note: '华东仓 · 样品',
    status: 'in_transit',
    queryState: 'success',
    tracking: true,
    createdAt: '2026-11-13T01:00:00Z',
    checkedAt: '2026-11-13T06:32:00Z',
    error: null,
    events: [
      {
        time: '2026-11-13 13:48:26',
        context: '快件已到达上海浦东转运中心，正在安排下一程运输',
        location: '上海市',
      },
      { time: '2026-11-12 16:28:00', context: '快件已揽收', location: '杭州市' },
    ],
  },
  {
    id: '2',
    number: 'JD1000000000002',
    carrier: 'jd',
    carrierName: '京东物流',
    note: '办公用品',
    status: 'out_for_delivery',
    queryState: 'success',
    tracking: true,
    createdAt: '2026-11-12T01:00:00Z',
    checkedAt: '2026-11-13T06:31:00Z',
    error: null,
    events: [
      {
        time: '2026-11-13 12:10:00',
        context: '您的快件正在派送中，请保持电话畅通',
        location: '北京市',
      },
    ],
  },
  {
    id: '3',
    number: 'YT1000000000003',
    carrier: 'yuantong',
    carrierName: '圆通速递',
    note: '杭州客户 · 合同',
    status: 'delivered',
    queryState: 'success',
    tracking: true,
    createdAt: '2026-11-12T01:00:00Z',
    checkedAt: '2026-11-13T06:29:00Z',
    error: null,
    events: [
      { time: '2026-11-13 11:36:00', context: '快件已签收，感谢使用圆通速递', location: '杭州市' },
    ],
  },
  {
    id: '4',
    number: 'SF1000000000004',
    carrier: 'shunfeng',
    carrierName: '顺丰速运',
    note: '需核实收件信息',
    status: 'in_transit',
    queryState: 'attention',
    tracking: true,
    createdAt: '2026-11-12T01:00:00Z',
    checkedAt: '2026-11-13T06:28:00Z',
    error: '需要手机号后四位验证',
    events: [
      { time: '2026-11-12 18:16:00', context: '快件已发出，正在运输途中', location: '深圳市' },
    ],
  },
  {
    id: '5',
    number: 'JT1000000000005',
    carrier: 'jtexpress',
    carrierName: '极兔速递',
    note: '苏州项目',
    status: 'pending',
    queryState: 'pending',
    tracking: true,
    createdAt: '2026-11-13T01:00:00Z',
    checkedAt: null,
    error: null,
    events: [],
  },
];

test('imports batches, persists them, searches, edits notes, exports and removes selected rows', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('从第一个包裹开始')).toBeVisible();
  await page.getByRole('button', { name: '添加运单', exact: true }).click();
  await page
    .getByLabel('运单号', { exact: true })
    .fill('0012345678901234567890\nSF12345678\nsf12345678\n坏单号');
  await expect(page.getByText('重复 1 个', { exact: true })).toBeVisible();
  await expect(page.getByText('无效 1 个', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加 2 个运单' }).click();
  await expect(
    page.getByRole('button', { name: '0012345678901234567890', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByLabel('搜索运单').fill('SF123');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'SF12345678', exact: true }).click();
  await page
    .getByRole('dialog', { name: '运单详情' })
    .getByLabel('备注', { exact: true })
    .fill('华东客户');
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(page.getByRole('button', { name: '重新查询' })).toBeVisible();
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.getByLabel('选择 SF12345678', { exact: true }).check();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 (1)' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  await page.getByRole('button', { name: '删除选中' }).click();
  await page.getByRole('button', { name: '删除 1 个运单' }).click();
  await page.getByLabel('搜索运单').fill('');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: '开始批量查询' }).click();
  await expect(page.getByRole('alert')).toContainText('请在 Windows 桌面版中运行真实查询');
  expect(errors).toEqual([]);
});

test('filters both transit states, shows timelines, and saves tracking preferences', async ({
  page,
}) => {
  await page.addInitScript(
    ({ shipments, settings, job }) =>
      localStorage.setItem('parcel-desk-preview-v1', JSON.stringify({ shipments, settings, job })),
    { shipments: fixture, settings: defaultSettings, job: idleJob },
  );
  await page.goto('/');
  await expect(page.locator('tbody tr')).toHaveCount(5);
  await page.getByRole('button', { name: /运输途中.*运输中及派送中的包裹/ }).click();
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await page.getByRole('button', { name: /需要关注.*物流异常或查询待处理/ }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'SF1000000000004', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '运单详情' })).toContainText(
    '需要手机号后四位验证',
  );
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.getByRole('button', { name: '偏好设置' }).click();
  await page.getByRole('switch', { name: '自动跟踪' }).click();
  await page.getByLabel('复查间隔', { exact: false }).fill('30');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByText('自动跟踪 · 30 分钟')).toBeVisible();
});

test('captures a desktop-sized overview with explicit synthetic fixture data', async ({ page }) => {
  await page.addInitScript(
    ({ shipments, settings, job }) =>
      localStorage.setItem('parcel-desk-preview-v1', JSON.stringify({ shipments, settings, job })),
    { shipments: fixture, settings: defaultSettings, job: idleJob },
  );
  await page.goto('/');
  await expect(page.locator('tbody tr')).toHaveCount(5);
  await page.screenshot({ path: 'test-results/overview.png', fullPage: true });
  await page.getByRole('button', { name: 'SF1000000000001', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '运单详情' })).toBeVisible();
  await page.screenshot({ path: 'test-results/detail.png', fullPage: true });
});
