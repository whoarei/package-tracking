// Read the page's displayed result and its associated UI model. No direct courier
// API requests, request interception, CAPTCHA solving, or hidden data collection.
function readTrackingPage(expectedNumber) {
  if (location.hostname !== 'www.kuaidi100.com') {
    return { kind: 'attention', message: '查询页面已跳转，请在 Edge 中返回快递100查询页后继续' };
  }
  const visible = (el) =>
    !!el &&
    !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
    getComputedStyle(el).visibility !== 'hidden';
  const text = (selector) =>
    [...document.querySelectorAll(selector)]
      .filter(visible)
      .map((el) => el.innerText || '')
      .join('\n')
      .trim();
  const normalize = (value) =>
    String(value || '')
      .replace(/[-\s]/g, '')
      .toUpperCase();
  const jq = window.jQuery;
  if (jq) {
    const groups = ['#internal', '#national']
      .map((selector) => {
        const el = document.querySelector(selector);
        return visible(el) ? { el, data: jq(el).data('result') } : null;
      })
      .filter((group) => group?.data && normalize(group.data.nu) === normalize(expectedNumber));
    const events = groups
      .flatMap((group) =>
        (group.data.data || []).map((item) => ({
          time: String(item.ftime || item.time || ''),
          context: String(item.context || '').replace(/<[^>]*>/g, ''),
          location: String(item.location || item.areaName || ''),
        })),
      )
      .filter((item) => item.time && item.context);
    const unique = [
      ...new Map(events.map((item) => [item.time + '\n' + item.context, item])).values(),
    ].sort((a, b) => b.time.localeCompare(a.time));
    if (unique.length) {
      // Prefer the destination leg's state for international shipments.
      const group = groups.find((g) => g.el.id === 'national') || groups[0];
      return {
        kind: 'success',
        result: {
          carrier: String(group.data.com || ''),
          carrierName: group.el.querySelector('[role=comname]')?.textContent?.trim() || '',
          state: String(group.data.state ?? ''),
          events: unique,
        },
      };
    }
  }
  if (visible(document.querySelector('#checkCode'))) {
    return {
      kind: 'attention',
      message: '需要手机号后四位：请在 Edge 查询窗口中完成验证，再点击继续',
    };
  }
  const challenge = document.querySelector(
    '.geetest_panel, .geetest_box, .geetest_holder, .nc-container, iframe[src*="captcha"], iframe[src*="geetest"]',
  );
  if (visible(challenge))
    return { kind: 'attention', message: '页面需要人工验证，请在 Edge 查询窗口中完成后继续' };
  if (visible(document.querySelector('#queryLimit'))) {
    return {
      kind: 'unavailable',
      message: '该快递当前要求通过快递100小程序或 App 查询，网页无法读取轨迹',
    };
  }
  const error = text('#errorWrap, #internal .error-wrap, #national .error-wrap');
  if (error) return { kind: 'failure', message: error.slice(0, 260) };
  const notice = text('#tips, .tips-box, #queryPanel');
  if (/访问频繁|稍后再试|请求频繁|查询次数|操作频繁/.test(notice)) {
    return { kind: 'attention', message: '页面提示访问受限，请稍后在 Edge 中重试，或跳过此单' };
  }
  return { kind: 'pending' };
}
