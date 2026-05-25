/**
 * CdpBrowserTool — CDP 浏览器自动化：信息收集 + 结构化数据提取
 * 直接通过 Chrome DevTools Protocol 控制浏览器，无需 Puppeteer/Playwright 依赖。
 */
import { z } from 'zod/v4'
import { WebSocket } from 'ws'
import { execSync, spawn } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const TOOL_NAME = 'CdpBrowser'

const ACTIONS = [
  'navigate',       // 打开 URL，返回页面基本信息
  'extract',        // 按选择器提取结构化数据
  'screenshot',     // 截图取证
  'network',        // 捕获网络请求日志
  'js',             // 执行 JS 表达式
  'crawl',          // 递归爬取，提取链接/表单/API
  'schema',         // 自动推断页面数据结构（链接、表单、脚本、API端点）
  'cookies',        // 提取所有 cookies
  'storage',        // 提取 localStorage/sessionStorage
  'headers',        // 获取响应头
] as const

type Action = typeof ACTIONS[number]

const inputSchema = z.object({
  action: z.enum(ACTIONS).describe(`Browser operation. One of: ${ACTIONS.join(', ')}.`),
  url: z.string().optional().describe('Target URL (required for navigate, crawl, schema, network, headers, extract, js, cookies, storage, screenshot)'),
  selectors: z.record(z.string(), z.string()).optional().describe('Object mapping names to CSS selectors when action="extract", e.g. {"prices": ".price"}'),
  expression: z.string().optional().describe('JS expression to evaluate when action="js"'),
  depth: z.number().int().min(1).max(5).optional().describe('Crawl depth (1-5) when action="crawl", default 1'),
  waitMs: z.number().int().min(0).max(60000).optional().describe('Wait time in ms after page load (default 3000)'),
  proxy: z.string().optional().describe('Proxy URL like "socks5://user:pass@host:1080" (optional)'),
})

type CdpBrowserInput = z.infer<typeof inputSchema>

// ─── CDP 连接管理 ───

// ─── Stealth 反检测配置 ───

const STEALTH_ARGS = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=VizDisplayCompositor,IsolateOrigins,site-per-process',
  '--disable-infobars',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
  '--disable-hang-monitor',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-client-side-phishing-detection',
  '--no-first-run',
  '--no-default-browser-check',
  '--metrics-recording-only',
  '--mute-audio',
  '--hide-scrollbars',
  '--remote-debugging-port=9222',
  '--window-size=1920,1080',
]

// 随机化 profile 池 — 5 个完整设备变体
const DEVICE_PROFILES = [
  {
    name: 'Windows-Chrome-Desktop',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    platform: 'Win32',
    deviceMemory: 16,
    hardwareConcurrency: 12,
    timezone: 'Asia/Shanghai',
    lang: 'zh-CN',
    gpu: { vendor: 'NVIDIA Corporation', renderer: 'NVIDIA GeForce RTX 3060/PCIe/SSE2' },
    screen: { availWidth: 1920, availHeight: 1040, colorDepth: 24 },
  },
  {
    name: 'Mac-Chrome-Retina',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 2560, height: 1440 },
    platform: 'MacIntel',
    deviceMemory: 8,
    hardwareConcurrency: 8,
    timezone: 'America/New_York',
    lang: 'en-US',
    gpu: { vendor: 'Apple', renderer: 'Apple M2' },
    screen: { availWidth: 2560, availHeight: 1415, colorDepth: 30 },
  },
  {
    name: 'Linux-Chrome-Dev',
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1536, height: 864 },
    platform: 'Linux x86_64',
    deviceMemory: 32,
    hardwareConcurrency: 16,
    timezone: 'Europe/London',
    lang: 'en-GB',
    gpu: { vendor: 'Intel', renderer: 'Mesa Intel(R) UHD Graphics 770' },
    screen: { availWidth: 1536, availHeight: 824, colorDepth: 24 },
  },
  {
    name: 'Windows-Edge-Corporate',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    viewport: { width: 1440, height: 900 },
    platform: 'Win32',
    deviceMemory: 8,
    hardwareConcurrency: 4,
    timezone: 'Asia/Tokyo',
    lang: 'ja-JP',
    gpu: { vendor: 'Intel Inc.', renderer: 'Intel Iris Xe Graphics' },
    screen: { availWidth: 1440, availHeight: 860, colorDepth: 24 },
  },
  {
    name: 'Mac-Chrome-Casual',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    platform: 'MacIntel',
    deviceMemory: 4,
    hardwareConcurrency: 4,
    timezone: 'America/Los_Angeles',
    lang: 'en-US',
    gpu: { vendor: 'Apple', renderer: 'Apple M1' },
    screen: { availWidth: 1366, availHeight: 743, colorDepth: 24 },
  },
] as const

function randomPick<T>(arr: readonly T[]): T { return arr[Math.floor(Math.random() * arr.length)] }

function getStealthProfile() {
  return randomPick(DEVICE_PROFILES)
}

// 注入到页面的 stealth JS — 修补 CDP 泄露和指纹
function buildStealthScript(profile: typeof DEVICE_PROFILES[number]): string {
  return `
    // 1. 移除 webdriver 标记
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    
    // 2. 伪造 plugins（无头浏览器默认为空）
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        plugins.length = 3;
        return plugins;
      }
    });

    // 3. 伪造 languages
    Object.defineProperty(navigator, 'languages', { get: () => ['${profile.lang}', 'en'] });
    Object.defineProperty(navigator, 'language', { get: () => '${profile.lang}' });

    // 4. 伪造 platform
    Object.defineProperty(navigator, 'platform', { get: () => '${profile.platform}' });

    // 5. 伪造 hardwareConcurrency 和 deviceMemory
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${profile.hardwareConcurrency} });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => ${profile.deviceMemory} });

    // 6. 伪造 Media Devices（防止 0 设备检测）
    if (navigator.mediaDevices) {
      navigator.mediaDevices.enumerateDevices = async () => [
        { deviceId: 'default', kind: 'audioinput', label: 'Default', groupId: 'g1' },
        { deviceId: 'comm', kind: 'audiooutput', label: 'Speakers', groupId: 'g1' },
        { deviceId: 'vid1', kind: 'videoinput', label: 'HD Webcam', groupId: 'g2' },
      ];
    }

    // 7. 修补 Permissions API 异常
    const origQuery = window.Permissions?.prototype?.query;
    if (origQuery) {
      window.Permissions.prototype.query = function(params) {
        if (params.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission });
        }
        return origQuery.call(this, params);
      };
    }

    // 8. 防止 iframe 环境差异检测
    const origAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function() { return origAttachShadow.call(this, ...arguments); };

    // 9. 伪造 chrome.runtime（非扩展环境也要有）
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = { connect: () => {}, sendMessage: () => {} };

    // 10. Canvas 指纹噪声注入
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const noise = Math.random() * 0.01;
        const imageData = ctx.getImageData(0, 0, Math.min(this.width, 2), Math.min(this.height, 2));
        imageData.data[0] = imageData.data[0] + noise > 255 ? 255 : Math.floor(imageData.data[0] + noise);
        ctx.putImageData(imageData, 0, 0);
      }
      return origToDataURL.call(this, type);
    };

    // 11. WebGL 渲染器伪造 — 匹配设备 profile
    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return '${profile.gpu.vendor}';
      if (param === 37446) return '${profile.gpu.renderer}';
      return getParam.call(this, param);
    };
    const getParam2 = WebGL2RenderingContext?.prototype?.getParameter;
    if (getParam2) {
      WebGL2RenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return '${profile.gpu.vendor}';
        if (param === 37446) return '${profile.gpu.renderer}';
        return getParam2.call(this, param);
      };
    }

    // 12. Screen 属性伪造
    Object.defineProperty(screen, 'availWidth', { get: () => ${profile.screen.availWidth} });
    Object.defineProperty(screen, 'availHeight', { get: () => ${profile.screen.availHeight} });
    Object.defineProperty(screen, 'colorDepth', { get: () => ${profile.screen.colorDepth} });
    Object.defineProperty(screen, 'width', { get: () => ${profile.viewport.width} });
    Object.defineProperty(screen, 'height', { get: () => ${profile.viewport.height} });

    // 13. 防止 CDP Runtime.enable 检测（Error stack trace 清洗）
    const origError = Error;
    Error = class extends origError {
      constructor(msg) {
        super(msg);
        if (this.stack) {
          this.stack = this.stack.split('\\n').filter(l => !l.includes('pptr') && !l.includes('puppeteer') && !l.includes('playwright') && !l.includes('cdp')).join('\\n');
        }
      }
    };

    // 14. AudioContext 指纹伪造（防止音频指纹检测）
    const origAudioContext = window.AudioContext || window.webkitAudioContext;
    if (origAudioContext) {
      const origCreateOscillator = origAudioContext.prototype.createOscillator;
      const origCreateDynamicsCompressor = origAudioContext.prototype.createDynamicsCompressor;
      origAudioContext.prototype.createOscillator = function() {
        const osc = origCreateOscillator.call(this);
        const origConnect = osc.connect.bind(osc);
        osc.connect = function(dest) {
          // 注入微量频率偏移
          if (osc.frequency) osc.frequency.value += (Math.random() - 0.5) * 0.001;
          return origConnect(dest);
        };
        return osc;
      };
      origAudioContext.prototype.createDynamicsCompressor = function() {
        const comp = origCreateDynamicsCompressor.call(this);
        // 微调压缩器参数产生唯一但稳定的音频指纹
        const seed = ${Math.random().toFixed(8)};
        if (comp.threshold) comp.threshold.value = -50 + seed * 2;
        if (comp.knee) comp.knee.value = 40 + seed;
        return comp;
      };
    }

    // 15. 隐藏 console._commandLineAPI（CDP 注入检测）
    delete console._commandLineAPI;
    Object.defineProperty(console, '_commandLineAPI', { get: () => undefined, configurable: false });

    // 16. 防止 window.cdc_ 变量检测（ChromeDriver 标记）
    for (const key of Object.keys(window)) {
      if (key.match(/^cdc_|^\\$cdc_/)) delete window[key];
    }

    // 17. 防止 document.hidden / visibilityState 检测（无头浏览器总是 hidden）
    Object.defineProperty(document, 'hidden', { get: () => false });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });

    // 18. 防止 Notification.permission 异常（无头默认 denied）
    Object.defineProperty(Notification, 'permission', { get: () => 'default' });

    // 19. 防止 outerWidth/outerHeight 为 0（无头浏览器特征）
    if (window.outerWidth === 0) Object.defineProperty(window, 'outerWidth', { get: () => ${profile.viewport.width} });
    if (window.outerHeight === 0) Object.defineProperty(window, 'outerHeight', { get: () => ${profile.viewport.height} + 85 });

    // 20. 防止 connection.rtt 为 0（自动化环境特征）
    if (navigator.connection) {
      Object.defineProperty(navigator.connection, 'rtt', { get: () => ${50 + Math.floor(Math.random() * 100)} });
    }

    // 21. 伪造 Battery API（部分检测系统用来区分真实设备）
    if (navigator.getBattery) {
      navigator.getBattery = () => Promise.resolve({
        charging: true, chargingTime: 0, dischargingTime: Infinity, level: 0.${Math.floor(Math.random() * 40) + 60},
        addEventListener: () => {}, removeEventListener: () => {},
      });
    }
  `;
}

// ─── 人类行为模拟（基于真人运动学参数） ───

async function humanDelay(min = 200, max = 800) {
  // 真人延迟符合对数正态分布，不是均匀分布
  const mu = Math.log((min + max) / 2)
  const sigma = 0.5
  const delay = Math.exp(mu + sigma * (Math.random() + Math.random() + Math.random() - 1.5))
  await new Promise(r => setTimeout(r, Math.max(min, Math.min(max * 2, delay))))
}

async function humanMouseMove(ws: WebSocket, targetX: number, targetY: number, steps = 0) {
  // 真人鼠标轨迹：Fitts' Law + 贝塞尔曲线 + 微震颤
  const startX = 100 + Math.random() * 400
  const startY = 100 + Math.random() * 300
  const distance = Math.sqrt((targetX - startX) ** 2 + (targetY - startY) ** 2)

  // Fitts' Law: 移动时间与距离/目标大小成对数关系
  const moveTime = 200 + 150 * Math.log2(distance / 10 + 1)
  const numSteps = steps || Math.max(8, Math.floor(moveTime / 16)) // ~60fps

  // 贝塞尔控制点（模拟手腕弧线运动）
  const cp1x = startX + (targetX - startX) * 0.3 + (Math.random() - 0.5) * distance * 0.2
  const cp1y = startY + (targetY - startY) * 0.1 + (Math.random() - 0.5) * distance * 0.3
  const cp2x = startX + (targetX - startX) * 0.7 + (Math.random() - 0.5) * distance * 0.1
  const cp2y = startY + (targetY - startY) * 0.9 + (Math.random() - 0.5) * distance * 0.15

  for (let i = 0; i <= numSteps; i++) {
    const t = i / numSteps
    // 缓入缓出（真人加速-减速曲线）
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2

    // 三次贝塞尔插值
    const u = 1 - ease
    const x = u*u*u*startX + 3*u*u*ease*cp1x + 3*u*ease*ease*cp2x + ease*ease*ease*targetX
    const y = u*u*u*startY + 3*u*u*ease*cp1y + 3*u*ease*ease*cp2y + ease*ease*ease*targetY

    // 微震颤（手部生理性颤抖，幅度 1-3px，频率 8-12Hz）
    const tremor = i > 0 && i < numSteps ? (Math.random() - 0.5) * 2.5 : 0

    await cdpSend(ws, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: Math.round(x + tremor), y: Math.round(y + tremor)
    })

    // 非均匀时间间隔（真人不是匀速的）
    const baseInterval = moveTime / numSteps
    const jitter = baseInterval * (0.7 + Math.random() * 0.6)
    await new Promise(r => setTimeout(r, jitter))
  }
}

async function humanScroll(ws: WebSocket, distance = 300) {
  // 真人滚动：惯性物理模型（初速快→逐渐减速）
  const steps = 6 + Math.floor(Math.random() * 6)
  let remaining = distance
  for (let i = 0; i < steps; i++) {
    // 指数衰减：每步滚动量递减
    const ratio = Math.pow(0.6, i)
    const delta = remaining * ratio * (0.3 + Math.random() * 0.2)
    remaining -= delta

    await cdpSend(ws, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 300 + Math.random() * 200, y: 400 + Math.random() * 100,
      deltaX: 0, deltaY: Math.round(delta)
    })
    // 滚动间隔也递增（减速感）
    await new Promise(r => setTimeout(r, 30 + i * 20 + Math.random() * 40))
  }
}

async function humanClick(ws: WebSocket, x: number, y: number) {
  // 真人点击：mouseDown 和 mouseUp 之间有 50-150ms 间隔
  await cdpSend(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await new Promise(r => setTimeout(r, 50 + Math.random() * 100))
  await cdpSend(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

async function humanType(ws: WebSocket, text: string) {
  // 真人打字：WPM 变化 + 偶尔停顿（思考）
  for (let i = 0; i < text.length; i++) {
    await cdpSend(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', text: text[i] })
    await cdpSend(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', text: text[i] })
    // 基础间隔 50-150ms，偶尔长停顿（模拟思考）
    let delay = 50 + Math.random() * 100
    if (Math.random() < 0.05) delay += 300 + Math.random() * 500 // 5% 概率长停顿
    await new Promise(r => setTimeout(r, delay))
  }
}

// ─── CDP 连接管理 ───

let browserProcess: any = null
let wsEndpoint: string | null = null
let cdpId = 1
let currentProxy: string | null = null

async function ensureBrowser(proxy?: string): Promise<string> {
  // 如果代理变了，重启浏览器
  if (wsEndpoint && proxy !== currentProxy) {
    if (browserProcess) { browserProcess.kill(); browserProcess = null }
    wsEndpoint = null
  }
  if (wsEndpoint) return wsEndpoint
  currentProxy = proxy || null

  // 尝试连接已有的 Chrome debug 端口
  try {
    const resp = await fetch('http://127.0.0.1:9222/json/version')
    const data = await resp.json() as any
    wsEndpoint = data.webSocketDebuggerUrl
    return wsEndpoint!
  } catch {}

  // 启动新的 Chrome 实例
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.CHROME_PATH,
  ].filter(Boolean) as string[]

  const chromePath = chromePaths.find(p => {
    try { execSync(`if exist "${p}" echo ok`, { encoding: 'utf8' }); return true } catch { return false }
  })

  if (!chromePath) throw new Error('Chrome not found. Set CHROME_PATH env var.')

  browserProcess = spawn(chromePath, [
    ...STEALTH_ARGS,
    ...(currentProxy ? [`--proxy-server=${currentProxy}`] : []),
    '--user-data-dir=' + join(process.env.TEMP || '/tmp', 'cdp-haking'),
  ], { stdio: 'ignore', detached: true })

  // 等待启动
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500))
    try {
      const resp = await fetch('http://127.0.0.1:9222/json/version')
      const data = await resp.json() as any
      wsEndpoint = data.webSocketDebuggerUrl
      return wsEndpoint!
    } catch {}
  }
  throw new Error('Chrome failed to start within 10s')
}

async function cdpSend(ws: WebSocket, method: string, params: any = {}): Promise<any> {
  const id = cdpId++
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 30000)
    const handler = (data: any) => {
      const msg = JSON.parse(data.toString())
      if (msg.id === id) {
        clearTimeout(timeout)
        ws.off('message', handler)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function openPage(url: string, proxy?: string): Promise<{ ws: WebSocket; targetId: string }> {
  await ensureBrowser(proxy)
  const profile = getStealthProfile()
  const resp = await fetch('http://127.0.0.1:9222/json/new?' + encodeURIComponent(url))
  const target = await resp.json() as any
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  await cdpSend(ws, 'Page.enable')
  await cdpSend(ws, 'Network.enable')

  // 注入 stealth: UA + viewport + timezone + stealth script
  await cdpSend(ws, 'Network.setUserAgentOverride', {
    userAgent: profile.ua,
    acceptLanguage: profile.lang,
    platform: profile.platform,
  })
  await cdpSend(ws, 'Emulation.setDeviceMetricsOverride', {
    width: profile.viewport.width,
    height: profile.viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await cdpSend(ws, 'Emulation.setTimezoneOverride', { timezoneId: profile.timezone })

  // 在每个新文档加载前注入 stealth 脚本
  await cdpSend(ws, 'Page.addScriptToEvaluateOnNewDocument', {
    source: buildStealthScript(profile),
  })

  // 等待页面加载
  await new Promise<void>(resolve => {
    const handler = (data: any) => {
      const msg = JSON.parse(data.toString())
      if (msg.method === 'Page.loadEventFired') { ws.off('message', handler); resolve() }
    }
    ws.on('message', handler)
    setTimeout(resolve, 15000)
  })

  // 模拟人类行为：随机滚动 + 鼠标移动
  await humanDelay(500, 1500)
  await humanMouseMove(ws, 400 + Math.random() * 200, 300 + Math.random() * 200)
  await humanScroll(ws, 100 + Math.random() * 200)

  return { ws, targetId: target.id }
}

async function closePage(targetId: string) {
  try { await fetch(`http://127.0.0.1:9222/json/close/${targetId}`) } catch {}
}

// ─── 数据提取 ───

async function extractSchema(ws: WebSocket): Promise<any> {
  const result = await cdpSend(ws, 'Runtime.evaluate', {
    expression: `(() => {
      const data = {
        title: document.title,
        url: location.href,
        meta: {},
        links: [],
        forms: [],
        scripts: [],
        apis: [],
        emails: [],
        comments: [],
      };

      // Meta tags
      document.querySelectorAll('meta').forEach(m => {
        const name = m.getAttribute('name') || m.getAttribute('property') || '';
        if (name) data.meta[name] = m.getAttribute('content') || '';
      });

      // Links
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href;
        if (href && !href.startsWith('javascript:')) {
          data.links.push({ text: a.textContent?.trim().slice(0, 80) || '', href, rel: a.rel || '' });
        }
      });

      // Forms
      document.querySelectorAll('form').forEach(f => {
        const inputs = [...f.querySelectorAll('input,select,textarea')].map(i => ({
          name: i.name || i.id || '', type: i.type || i.tagName.toLowerCase(), value: i.value?.slice(0, 50) || ''
        }));
        data.forms.push({ action: f.action, method: f.method || 'GET', inputs });
      });

      // Scripts (external)
      document.querySelectorAll('script[src]').forEach(s => {
        data.scripts.push(s.src);
      });

      // API endpoints from inline scripts
      const scriptText = [...document.querySelectorAll('script:not([src])')].map(s => s.textContent).join(' ');
      const apiMatches = scriptText.match(/["'](\\/(api|v[0-9]|graphql|rest)\\/[^"'\\s]{3,80})["']/g) || [];
      data.apis = [...new Set(apiMatches.map(m => m.slice(1, -1)))];

      // Fetch/XHR endpoints from script text
      const fetchMatches = scriptText.match(/fetch\\(["']([^"']+)["']/g) || [];
      fetchMatches.forEach(m => { const u = m.match(/["']([^"']+)["']/); if (u) data.apis.push(u[1]); });

      // Emails
      const bodyText = document.body?.innerText || '';
      const emailMatches = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g) || [];
      data.emails = [...new Set(emailMatches)];

      // HTML comments
      const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
      while (walker.nextNode()) {
        const val = walker.currentNode.nodeValue?.trim();
        if (val && val.length > 3) data.comments.push(val.slice(0, 200));
      }

      data.links = data.links.slice(0, 100);
      data.forms = data.forms.slice(0, 20);
      data.scripts = data.scripts.slice(0, 50);
      data.apis = [...new Set(data.apis)].slice(0, 50);
      data.comments = data.comments.slice(0, 30);
      return JSON.stringify(data);
    })()`,
    returnByValue: true,
  })
  return JSON.parse(result.result.value)
}

async function extractSelectors(ws: WebSocket, selectors: Record<string, string>): Promise<any> {
  const selectorJson = JSON.stringify(selectors)
  const result = await cdpSend(ws, 'Runtime.evaluate', {
    expression: `(() => {
      const selectors = ${selectorJson};
      const out = {};
      for (const [key, sel] of Object.entries(selectors)) {
        const els = document.querySelectorAll(sel);
        out[key] = [...els].map(el => ({
          text: el.textContent?.trim().slice(0, 500) || '',
          href: el.href || el.src || '',
          attrs: Object.fromEntries([...el.attributes].map(a => [a.name, a.value.slice(0, 200)]))
        }));
      }
      return JSON.stringify(out);
    })()`,
    returnByValue: true,
  })
  return JSON.parse(result.result.value)
}

async function captureNetworkLog(ws: WebSocket, url: string, waitMs = 5000): Promise<any[]> {
  const requests: any[] = []
  const handler = (data: any) => {
    const msg = JSON.parse(data.toString())
    if (msg.method === 'Network.requestWillBeSent') {
      requests.push({ url: msg.params.request.url, method: msg.params.request.method, type: msg.params.type })
    }
    if (msg.method === 'Network.responseReceived') {
      const r = msg.params.response
      requests.push({ url: r.url, status: r.status, mimeType: r.mimeType, type: 'response' })
    }
  }
  ws.on('message', handler)
  await cdpSend(ws, 'Page.navigate', { url })
  await new Promise(r => setTimeout(r, waitMs))
  ws.off('message', handler)
  return requests.slice(0, 200)
}

// ─── Tool 定义 ───

export const CdpBrowserTool = {
  name: TOOL_NAME,
  inputSchema,
  async description() {
    return `CDP Browser automation for information gathering and structured data extraction. Actions: ${ACTIONS.join(', ')}.`
  },
  async prompt() {
    return `Use this tool to control a headless Chrome browser via CDP for information gathering.

Parameters:
- action: One of: ${ACTIONS.join(', ')}
- url: Target URL (required for navigate, crawl, schema, network, headers)
- selectors: Object mapping names to CSS selectors (for action=extract). e.g. {"titles": "h1,h2", "links": "a[href]"}
- expression: JS expression to evaluate (for action=js)
- depth: Crawl depth (for action=crawl, default 1)
- waitMs: Wait time in ms after page load (default 3000)

Examples:
- {action: "schema", url: "https://target.com"} → auto-extract all links, forms, scripts, APIs, emails, comments
- {action: "extract", url: "https://target.com", selectors: {"prices": ".price", "products": ".product-name"}}
- {action: "network", url: "https://target.com"} → capture all HTTP requests/responses
- {action: "js", url: "https://target.com", expression: "document.cookie"}
- {action: "cookies", url: "https://target.com"}
- {action: "screenshot", url: "https://target.com"}
- {action: "crawl", url: "https://target.com", depth: 2}
- {action: "schema", url: "https://target.com", proxy: "socks5://user:pass@host:1080"} → with proxy

Output is always structured JSON. Proxy supports http/https/socks5 format.`
  },
  isEnabled() { return true },
  isReadOnly() { return true },
  userFacingName() { return 'CDP Browser' },
  async validateInput(input: CdpBrowserInput) {
    if (!input.action || !ACTIONS.includes(input.action)) {
      return { valid: false, message: `action must be one of: ${ACTIONS.join(', ')}` }
    }
    return { valid: true }
  },
  async call(input: CdpBrowserInput) {
    const action = input.action
    const url = input.url ?? ''
    const waitMs = input.waitMs ?? 3000
    const proxy = input.proxy

    try {
      switch (action) {
        case 'navigate': {
          const { ws, targetId } = await openPage(url, proxy)
          const title = await cdpSend(ws, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true })
          const loc = await cdpSend(ws, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true })
          ws.close()
          await closePage(targetId)
          return { data: JSON.stringify({ ok: true, title: title.result.value, url: loc.result.value }) }
        }

        case 'schema': {
          const { ws, targetId } = await openPage(url, proxy)
          await new Promise(r => setTimeout(r, waitMs))
          const data = await extractSchema(ws)
          ws.close()
          await closePage(targetId)
          return { data: JSON.stringify(data, null, 2).slice(0, 8000) }
        }

        case 'extract': {
          const selectors = input.selectors
          if (!selectors) return { data: JSON.stringify({ error: 'selectors parameter required' }) }
          const { ws, targetId } = await openPage(url, proxy)
          await new Promise(r => setTimeout(r, waitMs))
          const data = await extractSelectors(ws, selectors)
          ws.close()
          await closePage(targetId)
          return { data: JSON.stringify(data, null, 2).slice(0, 8000) }
        }

        case 'screenshot': {
          const { ws, targetId } = await openPage(url, proxy)
          await new Promise(r => setTimeout(r, waitMs))
          const shot = await cdpSend(ws, 'Page.captureScreenshot', { format: 'png', quality: 80 })
          const dir = join(process.env.APPDATA || '.', '.haking', 'screenshots')
          mkdirSync(dir, { recursive: true })
          const filename = `cdp-${Date.now()}.png`
          writeFileSync(join(dir, filename), Buffer.from(shot.data, 'base64'))
          ws.close()
          await closePage(targetId)
          return { data: JSON.stringify({ ok: true, path: join(dir, filename), size: shot.data.length }) }
        }

        case 'network': {
          const { ws, targetId } = await openPage('about:blank', proxy)
          const requests = await captureNetworkLog(ws, url, waitMs + 3000)
          ws.close()
          await closePage(targetId)
          return { data: JSON.stringify({ requests: requests.slice(0, 100) }, null, 2).slice(0, 8000) }
        }

        case 'js': {
          const expr = input.expression ?? 'document.title'
          const { ws, targetId } = await openPage(url, proxy)
          await new Promise(r => setTimeout(r, waitMs))
          const result = await cdpSend(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true })
          ws.close()
          await closePage(targetId)
          return { data: JSON.stringify({ value: result.result.value }) }
        }

        case 'cookies': {
          const { ws, targetId } = await openPage(url, proxy)
          await new Promise(r => setTimeout(r, waitMs))
          const cookies = await cdpSend(ws, 'Network.getAllCookies')
          ws.close()
          await closePage(targetId)
          return { data: JSON.stringify(cookies.cookies?.slice(0, 50), null, 2).slice(0, 8000) }
        }

        case 'storage': {
          const { ws, targetId } = await openPage(url, proxy)
          await new Promise(r => setTimeout(r, waitMs))
          const result = await cdpSend(ws, 'Runtime.evaluate', {
            expression: `JSON.stringify({localStorage: {...localStorage}, sessionStorage: {...sessionStorage}})`,
            returnByValue: true,
          })
          ws.close()
          await closePage(targetId)
          return { data: result.result.value?.slice(0, 8000) || '{}' }
        }

        case 'headers': {
          const { ws, targetId } = await openPage('about:blank', proxy)
          let responseHeaders: any = {}
          const handler = (data: any) => {
            const msg = JSON.parse(data.toString())
            if (msg.method === 'Network.responseReceived' && msg.params.response.url.includes(url.replace(/^https?:\/\//, ''))) {
              responseHeaders = msg.params.response.headers
            }
          }
          ws.on('message', handler)
          await cdpSend(ws, 'Page.navigate', { url })
          await new Promise(r => setTimeout(r, waitMs))
          ws.off('message', handler)
          ws.close()
          await closePage(targetId)
          return { data: JSON.stringify(responseHeaders, null, 2).slice(0, 4000) }
        }

        case 'crawl': {
          const depth = input.depth ?? 1
          const visited = new Set<string>()
          const results: any[] = []

          async function crawlPage(pageUrl: string, d: number) {
            if (d > depth || visited.has(pageUrl) || visited.size >= 20) return
            visited.add(pageUrl)
            const { ws, targetId } = await openPage(pageUrl)
            await new Promise(r => setTimeout(r, 2000))
            const schema = await extractSchema(ws)
            results.push({ url: pageUrl, ...schema })
            ws.close()
            await closePage(targetId)

            if (d < depth) {
              const sameOrigin = schema.links
                .filter((l: any) => l.href.startsWith(new URL(pageUrl).origin))
                .slice(0, 10)
              for (const link of sameOrigin) {
                await crawlPage(link.href, d + 1)
              }
            }
          }

          await crawlPage(url, 1)
          return { data: JSON.stringify({ pages: results.length, data: results }, null, 2).slice(0, 8000) }
        }

        default:
          return { data: `Unknown action: ${action}` }
      }
    } catch (err) {
      return { data: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }
    }
  },
}
