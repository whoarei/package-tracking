import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  ExternalLink,
  FileUp,
  FolderOpen,
  Inbox,
  LayoutGrid,
  LoaderCircle,
  MapPin,
  Monitor,
  Package,
  PackageCheck,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SkipForward,
  Square,
  Trash2,
  Truck,
  X,
} from 'lucide-react';
import * as api from './bridge';
import { version as appVersion } from '../package.json';
import {
  activePhases,
  carriers,
  defaultSettings,
  idleJob,
  statusNames,
  type Settings,
  type Shipment,
  type ShipmentStatus,
  type Snapshot,
} from './types';
import { exportCsv, formatDate, parseImport } from './utils';

type View = 'all' | 'tracking' | 'attention' | 'delivered';
const empty: Snapshot = { shipments: [], settings: defaultSettings, job: idleJob, dataDir: '' };
const viewNames: Record<View, string> = {
  all: '全部运单',
  tracking: '在途跟踪',
  attention: '需要关注',
  delivered: '已签收',
};
const isAttention = (s: Shipment) =>
  s.status === 'exception' || s.queryState === 'error' || s.queryState === 'attention';
const isInTransit = (s: Shipment) => s.status === 'in_transit' || s.status === 'out_for_delivery';

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [view, setView] = useState<View>('all');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let disposed = false,
      unlisten: (() => void) | undefined;
    let received = false;
    api
      .subscribe((data) => {
        received = true;
        if (!disposed) {
          setSnapshot(data);
          setLoaded(true);
          setLoadError('');
        }
      })
      .then(async (cleanup) => {
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        const data = await api.getSnapshot();
        if (!disposed && !received) setSnapshot(data);
        if (!disposed) setLoaded(true);
      })
      .catch((error) => {
        if (!disposed) {
          setLoadError(String(error));
          setLoaded(true);
        }
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const ids = new Set(snapshot.shipments.map((s) => s.id));
    setSelected((previous) => new Set([...previous].filter((id) => ids.has(id))));
  }, [snapshot.shipments]);

  const notify = (message: string, error = false) => setToast({ message, error });
  const controlJob = (action: Parameters<typeof api.controlJob>[0]) =>
    void api.controlJob(action).catch((error) => notify(String(error), true));
  const perform = async (task: () => Promise<unknown>, success?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await task();
      if (success) notify(success);
    } catch (error) {
      notify(String(error), true);
    } finally {
      setBusy(false);
    }
  };
  const counts = useMemo(
    () => ({
      all: snapshot.shipments.length,
      transit: snapshot.shipments.filter(isInTransit).length,
      tracking: snapshot.shipments.filter(
        (s) => s.tracking && !['delivered', 'returned'].includes(s.status),
      ).length,
      attention: snapshot.shipments.filter(isAttention).length,
      delivered: snapshot.shipments.filter((s) => s.status === 'delivered').length,
    }),
    [snapshot.shipments],
  );
  const filtered = useMemo(
    () =>
      snapshot.shipments.filter((s) => {
        if (view === 'tracking' && (!s.tracking || ['delivered', 'returned'].includes(s.status)))
          return false;
        if (view === 'attention' && !isAttention(s)) return false;
        if (view === 'delivered' && s.status !== 'delivered') return false;
        if (status === 'transit_all' ? !isInTransit(s) : status !== 'all' && s.status !== status)
          return false;
        return `${s.number} ${s.carrierName} ${s.note}`
          .toLowerCase()
          .includes(search.trim().toLowerCase());
      }),
    [snapshot.shipments, view, status, search],
  );
  const detail = snapshot.shipments.find((s) => s.id === detailId);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 50));
  const currentPage = Math.min(page, pageCount);
  const visibleRows = filtered.slice((currentPage - 1) * 50, currentPage * 50);
  useEffect(() => setPage(1), [view, status, search]);
  const active = activePhases.includes(snapshot.job.phase);
  const paused = snapshot.job.phase === 'paused' || snapshot.job.phase === 'waiting';
  const allSelected = visibleRows.length > 0 && visibleRows.every((s) => selected.has(s.id));
  const someSelected = visibleRows.some((s) => selected.has(s.id));
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);
  const chooseView = (next: View) => {
    setView(next);
    setStatus('all');
    setSearch('');
  };
  const toggleSelect = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const queryIds = selected.size ? [...selected] : filtered.map((s) => s.id);
  const exportResults = async () => {
    const rows = selected.size ? snapshot.shipments.filter((s) => selected.has(s.id)) : filtered;
    if (!rows.length) {
      notify('没有可导出的运单');
      return;
    }
    const contents = exportCsv(rows, statusNames);
    const name = `运单工作台-${new Date().toISOString().slice(0, 10)}.csv`;
    if (api.desktop) {
      await api.exportFile(contents, name);
    } else {
      const url = URL.createObjectURL(new Blob([contents], { type: 'text/csv;charset=utf-8;' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Package size={24} strokeWidth={1.7} />
          </span>
          <div>
            <strong>运单工作台</strong>
            <span>PACKAGE TRACKING</span>
          </div>
        </div>
        <div className="workspace-label">
          工作空间 <span>本地</span>
        </div>
        <nav aria-label="主导航">
          {(
            [
              ['all', LayoutGrid, counts.all],
              ['tracking', Truck, counts.tracking],
              ['attention', CircleAlert, counts.attention],
              ['delivered', PackageCheck, counts.delivered],
            ] as const
          ).map(([key, Icon, count]) => (
            <button
              key={key}
              className={`nav-item ${view === key ? 'active' : ''}`}
              onClick={() => chooseView(key)}
            >
              <Icon size={18} />
              <span>{viewNames[key]}</span>
              <b className={key === 'attention' && count ? 'attention-count' : ''}>{count}</b>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="tracking-tip">
            <span className="tip-icon">
              <RefreshCw size={17} />
            </span>
            <strong>让每个包裹都有着落</strong>
            <p>
              {snapshot.settings.autoTrack
                ? `每 ${snapshot.settings.intervalMinutes} 分钟复查未完成运单`
                : '开启自动跟踪，及时掌握物流变化'}
            </p>
            <button onClick={() => setSettingsOpen(true)}>
              {snapshot.settings.autoTrack ? '管理跟踪设置' : '设置自动跟踪'}
              <ArrowUpRight size={15} />
            </button>
          </div>
          <button className="nav-item settings-link" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={18} />
            <span>偏好设置</span>
          </button>
          <div className="local-account">
            <div className="avatar">企</div>
            <div>
              <strong>企业工作台</strong>
              <span>
                <span className="tiny-dot" /> 数据保存在本机
              </span>
            </div>
            <ShieldCheck size={17} />
          </div>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            工作空间
            <ChevronRight size={14} />
            <span>{viewNames[view]}</span>
          </div>
          <div className="topbar-right">
            <span className="platform">
              <Monitor size={14} />
              {api.desktop ? 'Windows 桌面版' : '浏览器预览'}
            </span>
            <span className="topbar-separator" />
            <span className="version">v{appVersion}</span>
          </div>
        </header>
        <main>
          <section className="page-heading">
            <div>
              <div className="eyebrow">SHIPMENTS OVERVIEW</div>
              <h1>
                每一程，都心中有数<span className="heading-dot">.</span>
              </h1>
              <p>集中查询运单，跟进物流动态，让日常查件更简单。</p>
            </div>
            <div className="heading-actions">
              <button
                className="button secondary"
                onClick={() => perform(api.openBrowser)}
                disabled={busy}
              >
                <ExternalLink size={16} />
                查询窗口
              </button>
              <button
                className="button primary"
                onClick={() => setImportOpen(true)}
                disabled={!loaded || !!loadError}
              >
                <Plus size={18} />
                添加运单
              </button>
            </div>
          </section>

          {!api.desktop && (
            <div className="preview-notice">
              <Monitor size={15} />
              <span>当前为浏览器预览。可体验导入、筛选和导出；真实查件请运行 Windows 桌面版。</span>
            </div>
          )}
          {loadError && (
            <div className="error-banner" role="alert">
              <CircleAlert size={18} />
              <div>
                <strong>本地数据未能加载</strong>
                <p>{loadError}</p>
              </div>
              <button
                className="text-button"
                onClick={() =>
                  perform(async () => {
                    setSnapshot(await api.getSnapshot());
                    setLoadError('');
                  })
                }
              >
                重试
              </button>
            </div>
          )}

          <section className="stats-grid" aria-label="运单统计">
            <StatCard
              label="全部运单"
              value={counts.all}
              caption="已添加到工作台"
              icon={<Package size={21} />}
              className="total"
              onClick={() => chooseView('all')}
            />
            <StatCard
              label="运输途中"
              value={counts.transit}
              caption="运输中及派送中的包裹"
              icon={<Truck size={21} />}
              className="transit"
              onClick={() => {
                chooseView('all');
                setStatus('transit_all');
              }}
            />
            <StatCard
              label="已签收"
              value={counts.delivered}
              caption="已顺利送达"
              icon={<CheckCheck size={21} />}
              className="delivered"
              onClick={() => chooseView('delivered')}
            />
            <StatCard
              label="需要关注"
              value={counts.attention}
              caption="物流异常或查询待处理"
              icon={<CircleAlert size={21} />}
              className="attention"
              onClick={() => chooseView('attention')}
            />
          </section>

          <section
            className={`batch-panel ${snapshot.job.phase === 'waiting' ? 'needs-action' : ''}`}
            aria-label="批量查询进度"
          >
            <div className="batch-icon">
              {active && !paused ? (
                <RefreshCw size={21} className="spin" />
              ) : snapshot.job.phase === 'waiting' ? (
                <CircleAlert size={21} />
              ) : (
                <FolderOpen size={21} />
              )}
            </div>
            <div className="batch-info">
              <div className="batch-title">
                <strong>
                  {active
                    ? snapshot.job.phase === 'waiting'
                      ? '等待人工处理'
                      : paused
                        ? '批量查询已暂停'
                        : '正在批量查询'
                    : snapshot.job.total
                      ? '上次查询批次'
                      : '批量查询，进度一目了然'}
                </strong>
                <span>
                  {snapshot.job.total
                    ? `${snapshot.job.completed} / ${snapshot.job.total}`
                    : '准备就绪'}
                </span>
              </div>
              <p>{snapshot.job.message || '导入多个单号后开始查询，结果将逐条更新并自动保存。'}</p>
              {snapshot.job.total > 0 && (
                <>
                  <div className="progress-track">
                    <div
                      style={{ width: `${(snapshot.job.completed / snapshot.job.total) * 100}%` }}
                    />
                  </div>
                  <div className="batch-meta">
                    <span>
                      成功 {snapshot.job.completed - snapshot.job.failed - snapshot.job.skipped}
                    </span>
                    <span>失败 {snapshot.job.failed}</span>
                    <span>跳过 {snapshot.job.skipped}</span>
                    {snapshot.job.currentNumber && (
                      <span className="current-number">当前：{snapshot.job.currentNumber}</span>
                    )}
                  </div>
                </>
              )}
            </div>
            <div className="batch-actions">
              {active ? (
                <>
                  {snapshot.job.phase !== 'cancelling' && (
                    <button
                      className="button compact secondary"
                      onClick={() => controlJob(paused ? 'resume' : 'pause')}
                    >
                      {paused ? <Play size={15} /> : <Pause size={15} />}
                      {paused ? '继续查询' : '暂停'}
                    </button>
                  )}
                  {paused && snapshot.job.currentId && (
                    <button
                      className="icon-button"
                      aria-label="跳过此单"
                      title="跳过此单"
                      onClick={() => controlJob('skip')}
                    >
                      <SkipForward size={17} />
                    </button>
                  )}
                  <button
                    className="icon-button"
                    aria-label="停止批次"
                    title="停止批次"
                    disabled={snapshot.job.phase === 'cancelling'}
                    onClick={() => controlJob('cancel')}
                  >
                    <Square size={15} />
                  </button>
                </>
              ) : (
                <button
                  className="button compact primary"
                  disabled={!queryIds.length || busy || !!loadError}
                  onClick={() => perform(() => api.startQuery(queryIds))}
                >
                  <Play size={15} fill="currentColor" />
                  {selected.size ? `查询选中 ${selected.size} 单` : '开始批量查询'}
                </button>
              )}
            </div>
          </section>

          <section className="shipments-panel">
            <div className="panel-heading">
              <div>
                <h2>{viewNames[view]}</h2>
                <span className="count-tag">{filtered.length}</span>
              </div>
              <span className="tracking-indicator">
                <span className={`tiny-dot ${snapshot.settings.autoTrack ? '' : 'muted'}`} />
                {snapshot.settings.autoTrack
                  ? `自动跟踪 · ${snapshot.settings.intervalMinutes} 分钟`
                  : '手动查询模式'}
              </span>
            </div>
            <div className="table-toolbar">
              <label className="search-field">
                <Search size={17} />
                <input
                  aria-label="搜索运单"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索单号、快递公司或备注…"
                />
                {search && (
                  <button
                    className="icon-button"
                    aria-label="清空搜索"
                    onClick={() => setSearch('')}
                  >
                    <X size={14} />
                  </button>
                )}
              </label>
              <div className="toolbar-actions">
                <label className="select-wrap">
                  <select
                    aria-label="筛选物流状态"
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    <option value="all">全部状态</option>
                    <option value="transit_all">运输途中</option>
                    {Object.entries(statusNames).map(([key, name]) => (
                      <option key={key} value={key}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={14} />
                </label>
                <span className="toolbar-divider" />
                {selected.size > 0 && (
                  <button
                    className="icon-button danger-text"
                    title="删除选中"
                    aria-label="删除选中"
                    disabled={active}
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 size={17} />
                  </button>
                )}
                <button
                  className="button ghost compact"
                  disabled={!filtered.length || busy}
                  onClick={() => perform(exportResults)}
                >
                  <ArrowDownToLine size={16} />
                  导出{selected.size ? ` (${selected.size})` : ''}
                </button>
              </div>
            </div>
            {selected.size > 0 && (
              <div className="selection-bar">
                <span>
                  已选择 <strong>{selected.size}</strong> 个运单
                </span>
                <button onClick={() => setSelected(new Set())}>取消选择</button>
              </div>
            )}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th className="checkbox-cell">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        aria-label="选择当前页所有运单"
                        checked={allSelected}
                        disabled={!filtered.length}
                        onChange={() =>
                          setSelected((previous) => {
                            const next = new Set(previous);
                            for (const s of visibleRows) {
                              allSelected ? next.delete(s.id) : next.add(s.id);
                            }
                            return next;
                          })
                        }
                      />
                    </th>
                    <th>运单信息</th>
                    <th>物流状态</th>
                    <th className="latest-column">最新动态</th>
                    <th>最后查询</th>
                    <th className="action-column">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((s) => (
                    <tr
                      key={s.id}
                      className={`${selected.has(s.id) ? 'selected' : ''} ${detailId === s.id ? 'opened' : ''}`}
                    >
                      <td className="checkbox-cell">
                        <input
                          type="checkbox"
                          aria-label={`选择 ${s.number}`}
                          checked={selected.has(s.id)}
                          onChange={() => toggleSelect(s.id)}
                        />
                      </td>
                      <td>
                        <button className="shipment-number" onClick={() => setDetailId(s.id)}>
                          {s.number}
                        </button>
                        <div className="shipment-sub">
                          <span className={`carrier-symbol carrier-${s.carrier}`}>
                            {(
                              s.carrierName ||
                              carriers.find(([code]) => code === s.carrier)?.[1] ||
                              '快'
                            ).slice(0, 1)}
                          </span>
                          <span>
                            {s.carrierName ||
                              carriers.find(([code]) => code === s.carrier)?.[1] ||
                              s.carrier}
                          </span>
                          {s.note && (
                            <>
                              <span className="sub-separator">·</span>
                              <span className="note-text" title={s.note}>
                                {s.note}
                              </span>
                            </>
                          )}
                        </div>
                      </td>
                      <td>
                        <StatusBadge status={s.status} />
                        {snapshot.job.currentId === s.id && active ? (
                          <span className="query-state">
                            <LoaderCircle size={12} className={paused ? '' : 'spin'} />
                            {paused ? '等待处理' : '查询中'}
                          </span>
                        ) : isAttention(s) && s.queryState !== 'success' ? (
                          <span className="query-state warning">
                            <CircleAlert size={12} />
                            {s.queryState === 'attention' ? '需要处理' : '查询失败'}
                          </span>
                        ) : null}
                      </td>
                      <td className="latest-column">
                        <div
                          className={`latest-text ${!s.events.length ? 'muted-text' : ''}`}
                          title={s.events[0]?.context || s.error || ''}
                        >
                          {s.events[0]?.context ||
                            (s.queryState === 'pending'
                              ? '添加成功，等待首次查询'
                              : s.error || '暂无物流轨迹')}
                        </div>
                        <div className="latest-time">
                          {s.events[0] ? (
                            <>
                              <MapPin size={11} />
                              {s.events[0].location || s.events[0].time}
                            </>
                          ) : s.tracking ? (
                            '已加入跟踪列表'
                          ) : (
                            '自动跟踪已关闭'
                          )}
                        </div>
                      </td>
                      <td className="checked-time">{formatDate(s.checkedAt)}</td>
                      <td>
                        <button
                          className="row-action"
                          aria-label={`查看 ${s.number}`}
                          onClick={() => setDetailId(s.id)}
                        >
                          <ChevronRight size={18} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!loaded ? (
              <div className="empty-state">
                <LoaderCircle className="spin" size={32} />
                <h3>正在读取本地运单…</h3>
              </div>
            ) : !filtered.length ? (
              <div className="empty-state">
                <div className="empty-art">
                  <span className="empty-art-back" />
                  <Package size={43} strokeWidth={1.3} />
                  <span className="empty-art-dot" />
                </div>
                <h3>{snapshot.shipments.length ? '没有找到匹配的运单' : '从第一个包裹开始'}</h3>
                <p>
                  {snapshot.shipments.length
                    ? '试试其他单号、备注或筛选条件。'
                    : '粘贴单号或导入文件，一次管理多个包裹的旅程。'}
                </p>
                <button
                  className="button secondary"
                  onClick={() =>
                    snapshot.shipments.length ? chooseView('all') : setImportOpen(true)
                  }
                >
                  {snapshot.shipments.length ? (
                    <>
                      <ArrowLeft size={15} />
                      查看全部运单
                    </>
                  ) : (
                    <>
                      <Plus size={16} />
                      添加第一批运单
                    </>
                  )}
                </button>
              </div>
            ) : null}
            <div className="table-footer">
              <span>
                {filtered.length ? `共 ${filtered.length} 个运单` : '运单记录将显示在这里'}
                {selected.size > 0 ? ` · 已选 ${selected.size} 个` : ''}
              </span>
              {pageCount > 1 && (
                <div className="pagination">
                  <button
                    className="icon-button"
                    aria-label="上一页"
                    disabled={currentPage === 1}
                    onClick={() => setPage(currentPage - 1)}
                  >
                    <ArrowLeft size={14} />
                  </button>
                  <span>
                    {currentPage} / {pageCount}
                  </span>
                  <button
                    className="icon-button"
                    aria-label="下一页"
                    disabled={currentPage === pageCount}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    <ChevronRight size={15} />
                  </button>
                </div>
              )}
              <span>
                <ShieldCheck size={13} />
                本地保存，随时查看
              </span>
            </div>
          </section>
          <footer className="page-footer">
            <span>一站掌握包裹动态</span>
            <span>
              PACKAGE TRACKING <span className="footer-dot">·</span> 为高效的日常而造
            </span>
          </footer>
        </main>
      </div>

      {importOpen && (
        <ImportModal
          onClose={() => setImportOpen(false)}
          onImported={(message) => {
            setImportOpen(false);
            notify(message);
          }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          settings={snapshot.settings}
          dataDir={snapshot.dataDir}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            notify('偏好设置已保存');
          }}
        />
      )}
      {deleteOpen && (
        <Modal title="删除所选运单" onClose={() => setDeleteOpen(false)}>
          <p className="modal-description">
            将从本机移除 {selected.size} 个运单及其物流记录。需要时可以重新导入单号。
          </p>
          <div className="modal-actions">
            <button className="button secondary" onClick={() => setDeleteOpen(false)}>
              取消
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  await api.removeShipments([...selected]);
                  setDeleteOpen(false);
                  setSelected(new Set());
                }, '所选运单已删除')
              }
            >
              删除 {selected.size} 个运单
            </button>
          </div>
        </Modal>
      )}
      {detail && (
        <DetailDrawer
          key={detail.id}
          shipment={detail}
          active={active}
          current={snapshot.job.currentId === detail.id}
          onClose={() => setDetailId(null)}
          onQuery={() => perform(() => api.startQuery([detail.id]))}
          onSave={async (patch) => {
            await api.updateShipment(detail.id, patch);
            notify('运单信息已保存');
          }}
          onCopy={() =>
            perform(async () => {
              await navigator.clipboard.writeText(detail.number);
            }, '单号已复制')
          }
        />
      )}
      {toast && (
        <div
          className={`toast ${toast.error ? 'error' : ''}`}
          role={toast.error ? 'alert' : 'status'}
        >
          {toast.error ? <CircleAlert size={18} /> : <Check size={18} />}
          <span>{toast.message}</span>
          <button aria-label="关闭提示" onClick={() => setToast(null)}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  caption,
  icon,
  className,
  onClick,
}: {
  label: string;
  value: number;
  caption: string;
  icon: ReactNode;
  className: string;
  onClick: () => void;
}) {
  return (
    <button className={`stat-card ${className}`} onClick={onClick}>
      <div className="stat-top">
        <span>{label}</span>
        <span className="stat-icon">{icon}</span>
      </div>
      <strong className="stat-value">
        {value.toLocaleString()}
        <span>单</span>
      </strong>
      <div className="stat-bottom">
        <span>{caption}</span>
        <ArrowUpRight size={14} />
      </div>
    </button>
  );
}
function StatusBadge({ status }: { status: ShipmentStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span />
      {statusNames[status]}
    </span>
  );
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Tab') {
            const elements = [
              ...(ref.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), textarea, select, [tabindex="0"]',
              ) || []),
            ];
            const first = elements[0],
              last = elements[elements.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              last?.focus();
              e.preventDefault();
            }
            if (!e.shiftKey && document.activeElement === last) {
              first?.focus();
              e.preventDefault();
            }
          }
        }}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">PACKAGE TRACKING</span>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (message: string) => void;
}) {
  const [text, setText] = useState('');
  const [carrier, setCarrier] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => parseImport(text, carrier), [text, carrier]);
  const submit = async () => {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const result = await api.importRows(parsed.rows);
      onImported(
        `已添加 ${result.added} 个运单${result.duplicates + parsed.duplicates ? `，跳过 ${result.duplicates + parsed.duplicates} 个重复单号` : ''}${parsed.invalid.length + result.invalid ? `，忽略 ${parsed.invalid.length + result.invalid} 个无效项` : ''}`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      title="添加运单"
      onClose={() => {
        if (!pending) onClose();
      }}
      wide
    >
      <p className="modal-description">批量粘贴单号，或导入 TXT / CSV 文件。单号会自动去重。</p>
      <div className="import-options">
        <label>
          默认快递公司
          <select value={carrier} onChange={(e) => setCarrier(e.target.value)}>
            {carriers.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.csv,text/plain,text/csv"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            if (file.size > 1024 * 1024) {
              setError('文件不能超过 1 MB');
              return;
            }
            try {
              setText(await file.text());
              setFileName(file.name);
              setError('');
            } catch {
              setError('文件读取失败，请保存为 UTF-8 格式后重试');
            }
          }}
        />
        <button className="button secondary" onClick={() => fileRef.current?.click()}>
          <FileUp size={16} />
          导入文件
        </button>
      </div>
      <label className="textarea-label" htmlFor="tracking-input">
        运单号{fileName && <span>{fileName}</span>}
      </label>
      <textarea
        id="tracking-input"
        className="tracking-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          '每行一个单号，也支持空格或逗号分隔\n\nSF1234567890123\nJD1234567890123\n\nCSV 可包含：单号,快递公司,备注'
        }
        spellCheck={false}
      />
      <div className="import-summary">
        <span>
          <Check size={14} />
          有效单号 <strong>{parsed.rows.length}</strong> 个
        </span>
        {parsed.duplicates > 0 && <span>重复 {parsed.duplicates} 个</span>}
        {parsed.invalid.length > 0 && (
          <span className="warning-text">无效 {parsed.invalid.length} 个</span>
        )}
        <span className="import-limit">每批最多 1000 单</span>
      </div>
      {parsed.invalid.length > 0 && (
        <p className="field-hint warning-text">
          无效项不会导入：{parsed.invalid.slice(0, 3).join('、')}
          {parsed.invalid.length > 3 ? '…' : ''}
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="button secondary" disabled={pending} onClick={onClose}>
          取消
        </button>
        <button
          className="button primary"
          disabled={pending || !parsed.rows.length || parsed.rows.length > 1000}
          onClick={submit}
        >
          {pending ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}添加{' '}
          {parsed.rows.length} 个运单
        </button>
      </div>
    </Modal>
  );
}

function SettingsModal({
  settings,
  dataDir,
  onClose,
  onSaved,
}: {
  settings: Settings;
  dataDir: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState({ ...settings });
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  return (
    <Modal
      title="偏好设置"
      onClose={() => {
        if (!pending) onClose();
      }}
    >
      <div className="setting-toggle">
        <div>
          <strong>自动跟踪未完成运单</strong>
          <p>应用运行时定时复查；已签收、已退回及待人工处理的运单会自动跳过。</p>
        </div>
        <button
          role="switch"
          aria-checked={draft.autoTrack}
          aria-label="自动跟踪"
          className={`switch ${draft.autoTrack ? 'on' : ''}`}
          onClick={() => setDraft({ ...draft, autoTrack: !draft.autoTrack })}
        >
          <span />
        </button>
      </div>
      <div className="form-grid">
        <label>
          复查间隔
          <span className="input-unit">
            <input
              type="number"
              min={5}
              max={1440}
              value={draft.intervalMinutes}
              onChange={(e) => setDraft({ ...draft, intervalMinutes: Number(e.target.value) })}
            />
            <span>分钟</span>
          </span>
        </label>
        <label>
          单号查询间隔
          <span className="input-unit">
            <input
              type="number"
              min={2}
              max={120}
              value={draft.requestDelaySeconds}
              onChange={(e) => setDraft({ ...draft, requestDelaySeconds: Number(e.target.value) })}
            />
            <span>秒</span>
          </span>
        </label>
      </div>
      <label className="form-label">
        浏览器路径 <span>可选</span>
        <input
          value={draft.browserPath}
          onChange={(e) => setDraft({ ...draft, browserPath: e.target.value })}
          placeholder="留空自动寻找 Microsoft Edge / Chrome"
        />
      </label>
      <p className="field-hint">
        查询时会打开独立的浏览器窗口。需要验证时，请在该窗口完成操作，然后回到运单工作台继续。
      </p>
      <div className="data-location">
        <ShieldCheck size={17} />
        <div>
          <strong>本地数据目录</strong>
          <p>{dataDir || '正在读取…'}</p>
        </div>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="button secondary" disabled={pending} onClick={onClose}>
          取消
        </button>
        <button
          className="button primary"
          disabled={pending}
          onClick={async () => {
            setError('');
            if (
              draft.intervalMinutes < 5 ||
              draft.intervalMinutes > 1440 ||
              !Number.isInteger(draft.intervalMinutes)
            ) {
              setError('复查间隔应为 5–1440 分钟的整数');
              return;
            }
            if (
              draft.requestDelaySeconds < 2 ||
              draft.requestDelaySeconds > 120 ||
              !Number.isInteger(draft.requestDelaySeconds)
            ) {
              setError('查询间隔应为 2–120 秒的整数');
              return;
            }
            setPending(true);
            try {
              await api.saveSettings(draft);
              onSaved();
            } catch (e) {
              setError(String(e));
            } finally {
              setPending(false);
            }
          }}
        >
          {pending && <LoaderCircle size={16} className="spin" />}保存设置
        </button>
      </div>
    </Modal>
  );
}

function DetailDrawer({
  shipment,
  active,
  current,
  onClose,
  onQuery,
  onSave,
  onCopy,
}: {
  shipment: Shipment;
  active: boolean;
  current: boolean;
  onClose: () => void;
  onQuery: () => void;
  onSave: (patch: Pick<Shipment, 'note' | 'tracking' | 'carrier'>) => Promise<void>;
  onCopy: () => void;
}) {
  const [note, setNote] = useState(shipment.note);
  const [tracking, setTracking] = useState(shipment.tracking);
  const [carrier, setCarrier] = useState(shipment.carrier);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setNote(shipment.note);
    setTracking(shipment.tracking);
    setCarrier(shipment.carrier);
  }, [shipment.note, shipment.tracking, shipment.carrier]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);
  const dirty =
    note !== shipment.note || tracking !== shipment.tracking || carrier !== shipment.carrier;
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="detail-drawer" role="dialog" aria-label="运单详情">
        <div className="drawer-header">
          <span>运单详情</span>
          <button className="icon-button" aria-label="关闭详情" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="drawer-scroll">
          <div className="detail-package">
            <Package size={27} />
          </div>
          <div className="detail-number">
            {shipment.number}
            <button className="icon-button" aria-label="复制单号" onClick={onCopy}>
              <Copy size={15} />
            </button>
          </div>
          <div className="detail-subtitle">
            {shipment.carrierName ||
              carriers.find(([code]) => code === shipment.carrier)?.[1] ||
              shipment.carrier}
            <span>·</span>添加于 {formatDate(shipment.createdAt, false)}
          </div>
          <div className="detail-status">
            <StatusBadge status={shipment.status} />
            <span>最后查询：{formatDate(shipment.checkedAt)}</span>
          </div>
          {shipment.error && (
            <div className="detail-warning">
              <CircleAlert size={16} />
              <span>{shipment.error}</span>
            </div>
          )}
          <div className="detail-section-title">
            <h3>物流轨迹</h3>
            <span>{shipment.events.length} 条动态</span>
          </div>
          {shipment.events.length ? (
            <ol className="timeline">
              {shipment.events.map((event, index) => (
                <li key={`${event.time}-${index}`} className={index === 0 ? 'latest' : ''}>
                  <span className="timeline-dot">{index === 0 && <Check size={11} />}</span>
                  <time>{event.time}</time>
                  <p>{event.context}</p>
                  {event.location && (
                    <span className="timeline-location">
                      <MapPin size={12} />
                      {event.location}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <div className="timeline-empty">
              <Inbox size={28} strokeWidth={1.3} />
              <p>暂时没有物流动态</p>
              <span>查询后将在这里展示完整轨迹</span>
            </div>
          )}
          <div className="detail-section-title">
            <h3>运单设置</h3>
          </div>
          <label className="form-label">
            快递公司
            <select
              value={carrier}
              disabled={current && active}
              onChange={(e) => setCarrier(e.target.value)}
            >
              {!carriers.some(([code]) => code === carrier) && (
                <option value={carrier}>{shipment.carrierName || carrier}</option>
              )}
              {carriers.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="form-label">
            备注
            <input
              maxLength={200}
              value={note}
              disabled={current && active}
              onChange={(e) => setNote(e.target.value)}
              placeholder="如客户名称、订单号…"
            />
          </label>
          <label className="tracking-checkbox">
            <input
              type="checkbox"
              checked={tracking}
              disabled={current && active}
              onChange={(e) => setTracking(e.target.checked)}
            />
            <span>加入自动跟踪列表</span>
          </label>
          <p className="field-hint">自动跟踪需在偏好设置中开启；关闭应用后暂停。</p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="drawer-footer">
          {dirty ? (
            <button
              className="button primary"
              disabled={pending || (current && active)}
              onClick={async () => {
                setPending(true);
                setError('');
                try {
                  await onSave({ note, tracking, carrier });
                } catch (e) {
                  setError(String(e));
                } finally {
                  setPending(false);
                }
              }}
            >
              <Check size={16} />
              保存修改
            </button>
          ) : (
            <button className="button primary" disabled={active} onClick={onQuery}>
              <RefreshCw size={16} />
              重新查询
            </button>
          )}
          <button className="button secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      </aside>
    </>
  );
}
