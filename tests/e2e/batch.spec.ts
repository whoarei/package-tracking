import { expect, test } from '@playwright/test';

test('large batches paginate and select one page without selecting hidden rows', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '添加运单', exact: true }).click();
  await page
    .getByLabel('运单号', { exact: true })
    .fill(Array.from({ length: 55 }, (_, i) => 'SF' + String(i + 1).padStart(12, '0')).join('\n'));
  await page.getByRole('button', { name: '添加 55 个运单' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(50);
  await page.getByLabel('选择当前页所有运单').check();
  await expect(page.getByText('已选择', { exact: false })).toContainText('50');
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(5);
  await expect(page.getByLabel('选择当前页所有运单')).not.toBeChecked();
  await page.getByLabel('搜索运单').fill('SF000000000001');
  await expect(page.locator('tbody tr')).toHaveCount(1);
});
