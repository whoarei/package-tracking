import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  defaultSettings,
  idleJob,
  type Snapshot,
  type ImportRow,
  type ImportResult,
  type Settings,
  type Shipment,
} from './types';

export const desktop = isTauri();
// Keep the existing storage key so renaming does not discard preview records.
const previewKey = 'parcel-desk-preview-v1';
const previewEvent = 'package-tracking-preview-change';
function loadPreview(): Snapshot {
  const saved = localStorage.getItem(previewKey);
  try {
    if (saved)
      return {
        ...JSON.parse(saved),
        job: { ...idleJob },
        dataDir: '浏览器预览 · 数据仅保存在当前浏览器',
      };
  } catch {
    /* A malformed preview must not break the desktop app. */
  }
  return {
    shipments: [],
    settings: { ...defaultSettings },
    job: { ...idleJob },
    dataDir: '浏览器预览 · 数据仅保存在当前浏览器',
  };
}
function savePreview(snapshot: Snapshot) {
  localStorage.setItem(previewKey, JSON.stringify(snapshot));
  window.dispatchEvent(new CustomEvent(previewEvent, { detail: snapshot }));
}
export async function getSnapshot(): Promise<Snapshot> {
  return desktop ? invoke('get_snapshot') : loadPreview();
}
export async function subscribe(callback: (snapshot: Snapshot) => void): Promise<() => void> {
  if (desktop) return listen<Snapshot>('desk:changed', (event) => callback(event.payload));
  const handler = (event: Event) => callback((event as CustomEvent<Snapshot>).detail);
  window.addEventListener(previewEvent, handler);
  return () => window.removeEventListener(previewEvent, handler);
}
export async function importRows(rows: ImportRow[]): Promise<ImportResult> {
  if (desktop) return invoke('import_shipments', { rows });
  const data = loadPreview(),
    existing = new Set(data.shipments.map((s) => s.number));
  let added = 0,
    duplicates = 0;
  for (const row of rows) {
    if (existing.has(row.number)) {
      duplicates++;
      continue;
    }
    existing.add(row.number);
    added++;
    data.shipments.unshift({
      ...row,
      id: crypto.randomUUID(),
      carrierName: '',
      status: 'pending',
      queryState: 'pending',
      events: [],
      tracking: true,
      createdAt: new Date().toISOString(),
      checkedAt: null,
      error: null,
    });
  }
  savePreview(data);
  return { added, duplicates, invalid: 0 };
}
export async function updateShipment(
  id: string,
  patch: Pick<Shipment, 'note' | 'tracking' | 'carrier'>,
): Promise<void> {
  if (desktop) return invoke('update_shipment', { id, ...patch });
  const data = loadPreview();
  data.shipments = data.shipments.map((s) => (s.id === id ? { ...s, ...patch } : s));
  savePreview(data);
}
export async function removeShipments(ids: string[]): Promise<void> {
  if (desktop) return invoke('remove_shipments', { ids });
  const data = loadPreview();
  data.shipments = data.shipments.filter((s) => !ids.includes(s.id));
  savePreview(data);
}
export async function saveSettings(settings: Settings): Promise<void> {
  if (desktop) return invoke('save_settings', { settings });
  const data = loadPreview();
  data.settings = settings;
  savePreview(data);
}
export async function startQuery(ids: string[]): Promise<void> {
  if (!desktop)
    throw new Error('请在 Windows 桌面版中运行真实查询。浏览器预览支持导入、筛选和界面操作。');
  return invoke('start_query', { ids });
}
export async function controlJob(action: 'pause' | 'resume' | 'cancel' | 'skip'): Promise<void> {
  if (desktop) return invoke('control_job', { action });
}
export async function openBrowser(): Promise<void> {
  if (!desktop) throw new Error('查询窗口需要 Windows 桌面版与 Microsoft Edge。');
  return invoke('open_browser');
}
export async function exportFile(contents: string, defaultPath: string): Promise<boolean> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const path = await save({ defaultPath, filters: [{ name: 'CSV 表格', extensions: ['csv'] }] });
  if (!path) return false;
  await invoke('export_csv', { path, contents });
  return true;
}
