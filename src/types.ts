export type ShipmentStatus =
  'pending' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'exception' | 'returned';
export type QueryState = 'pending' | 'querying' | 'success' | 'error' | 'attention';
export interface TrackingEvent {
  time: string;
  context: string;
  location: string;
}
export interface Shipment {
  id: string;
  number: string;
  carrier: string;
  carrierName: string;
  note: string;
  status: ShipmentStatus;
  queryState: QueryState;
  events: TrackingEvent[];
  tracking: boolean;
  createdAt: string;
  checkedAt: string | null;
  error: string | null;
}
export interface Settings {
  autoTrack: boolean;
  intervalMinutes: number;
  requestDelaySeconds: number;
  browserPath: string;
}
export type JobPhase =
  'idle' | 'running' | 'paused' | 'waiting' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
export interface Job {
  phase: JobPhase;
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  currentId: string | null;
  currentNumber: string | null;
  message: string;
  startedAt: string | null;
}
export interface Snapshot {
  shipments: Shipment[];
  settings: Settings;
  job: Job;
  dataDir: string;
}
export interface ImportRow {
  number: string;
  carrier: string;
  note: string;
}
export interface ImportResult {
  added: number;
  duplicates: number;
  invalid: number;
}

export const carriers = [
  ['', '自动识别'],
  ['shunfeng', '顺丰速运'],
  ['zhongtong', '中通快递'],
  ['yuantong', '圆通速递'],
  ['yunda', '韵达快递'],
  ['shentong', '申通快递'],
  ['jtexpress', '极兔速递'],
  ['jd', '京东物流'],
  ['youzhengguonei', '邮政包裹'],
  ['ems', 'EMS'],
  ['debangwuliu', '德邦物流'],
  ['annengwuliu', '安能物流'],
] as const;
export const statusNames: Record<ShipmentStatus, string> = {
  pending: '待查询',
  in_transit: '运输中',
  out_for_delivery: '派送中',
  delivered: '已签收',
  exception: '物流异常',
  returned: '已退回',
};
export const idleJob: Job = {
  phase: 'idle',
  total: 0,
  completed: 0,
  failed: 0,
  skipped: 0,
  currentId: null,
  currentNumber: null,
  message: '',
  startedAt: null,
};
export const defaultSettings: Settings = {
  autoTrack: false,
  intervalMinutes: 60,
  requestDelaySeconds: 5,
  browserPath: '',
};
export const activePhases: JobPhase[] = ['running', 'paused', 'waiting', 'cancelling'];
