/**
 * ReverseCliTool — RE/Pentest toolbox for Haking Code.
 * Wraps 20+ security tools (nmap, nuclei, sqlmap, strings, diec, ghidra, etc.)
 * into a single AI-callable tool.
 */
import { execa } from 'execa'
import { readFileSync } from 'fs'
import { createHash as md5Hash } from 'crypto'
import { z } from 'zod/v4'

/**
 * FuzzTag 解析器 — 参考 yakit Web Fuzzer 的标签语法
 * 支持: {{int(1-10)}}, {{list(a|b|c)}}, {{repeat(3)}},
 *       {{file(/path)}}, {{base64(str)}}, {{md5(str)}},
 *       {{randstr(8)}}, {{randint(1,100)}}
 */
function expandFuzzTag(template: string): string[] {
  // 找到第一个 {{...}} 标签
  const match = template.match(/\{\{(\w+)\(([^)]*)\)\}\}/)
  if (!match) return [template]

  const [full, tag, arg] = match
  const before = template.slice(0, match.index)
  const after = template.slice((match.index ?? 0) + full.length)

  let values: string[] = []

  switch (tag) {
    case 'int': {
      const [start, end] = arg.split('-').map(Number)
      for (let i = start; i <= end; i++) values.push(String(i))
      break
    }
    case 'list':
      values = arg.split('|')
      break
    case 'repeat': {
      const n = parseInt(arg)
      values = Array(n).fill(before + after)
      return values // repeat 特殊处理
    }
    case 'randstr': {
      const len = parseInt(arg) || 8
      const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
      values = [Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('')]
      break
    }
    case 'randint': {
      const [min, max] = arg.split(',').map(Number)
      values = [String(Math.floor(Math.random() * (max - min + 1)) + min)]
      break
    }
    case 'base64':
      values = [Buffer.from(arg).toString('base64')]
      break
    case 'md5': {
      values = [md5Hash('md5').update(arg).digest('hex')]
      break
    }
    case 'file': {
      try {
        values = readFileSync(arg, 'utf-8').split('\n').filter(Boolean)
      } catch { values = [`[file-not-found:${arg}]`] }
      break
    }
    default:
      values = [full] // 未知标签原样保留
  }

  // 笛卡尔展开：每个值递归展开后续标签
  return values.flatMap(v => expandFuzzTag(before + v + after))
}

const TOOL_NAME = 'ReverseCli'

const ACTIONS = [
  'analyze', 'strings', 'dump', 'diec', 'upx', 'ghidra', 'ida',
  'tshark', 'pentest', 'kali', 'forensic', 'frida-unpack', 'shell-protect',
  'run',   // 通用：直接运行任意安全工具命令
  'fuzz',  // FuzzTag：生成测试payload（参考yakit Web Fuzzer）
] as const

type Action = typeof ACTIONS[number]

const PENTEST_TOOLS = [
  // 原有工具
  'nuclei', 'nmap', 'httpx', 'ffuf', 'sqlmap', 'subfinder', 'naabu',
  // 侦察/信息收集
  'whatweb', 'wafw00f', 'amass', 'assetfinder', 'gau', 'hakrawler',
  'rustscan', 'holehe', 'maigret', 'spiderfoot', 'trufflehog', 'gitleaks',
  'katana', 'arjun', 'dracnmap', 'redhawk', 'reconspider', 'infoga',
  // 漏洞扫描/Web攻击
  'nikto', 'wpscan', 'gobuster', 'feroxbuster', 'dirsearch',
  'dalfox', 'xsstrike', 'commix', 'testssl.sh',
  // SQL注入
  'nosqlmap', 'leviathan',
  // 钓鱼/社工
  'evilginx3', 'socialfish', 'dnstwist', 'setoolkit',
  // 利用框架
  'metasploit', 'msfconsole', 'searchsploit', 'routersploit',
  // 后渗透/C2
  'sliver', 'havoc', 'mythic', 'pwncat-cs',
  'peass-ng', 'linpeas', 'winpeas', 'ligolo-ng', 'chisel', 'evil-winrm',
  // Active Directory
  'bloodhound', 'netexec', 'nxc', 'impacket', 'responder', 'certipy', 'kerbrute',
  // 密码/爆破
  'hydra', 'hashcat', 'john', 'crunch', 'haiti', 'hash-buster', 'pdfrip',
  // 网络分析/无线
  'masscan', 'zmap', 'netcat', 'socat', 'bettercap',
  'airgeddon', 'wifite', 'wifiphisher', 'hcxdumptool', 'hcxtools',
  // 云安全
  'prowler', 'scoutsuite', 'pacu', 'trivy',
  // 移动安全
  'mobsf', 'frida', 'objection',
  // 取证
  'volatility3', 'binwalk', 'pspy', 'bulk-extractor', 'wireshark',
  // Payload生成
  'msfvenom', 'thefatrat', 'venom',
  // OSINT
  'theHarvester', 'maltego', 'recon-ng', 'sherlock', 'socialscan',
  // 隐写
  'steghide', 'stegcracker', 'binwalk',
] as const

const inputSchema = z.object({
  action: z.enum(ACTIONS).describe(`Operation to perform. One of: ${ACTIONS.join(', ')}.`),
  targetPath: z.string().optional().describe('Path to target binary/file (for analyze, strings, dump, diec, upx, ghidra, ida, frida-unpack, shell-protect)'),
  pentestTool: z.string().optional().describe(`Pentest sub-tool name when action="pentest". One of: ${PENTEST_TOOLS.join(', ')}`),
  pentestArgs: z.string().optional().describe('CLI arguments for the pentest tool when action="pentest"'),
  kaliCmd: z.string().optional().describe('Shell command to run when action="kali"'),
  tsharkArgs: z.string().optional().describe('tshark arguments when action="tshark"'),
  forensicUrl: z.string().optional().describe('URL to analyze when action="forensic"'),
  cmd: z.string().optional().describe('Generic shell command when action="run"'),
  template: z.string().optional().describe('FuzzTag template when action="fuzz", e.g. "id={{int(1-100)}}"'),
})

type ReverseCliInput = z.infer<typeof inputSchema>

export const ReverseCliTool = {
  name: TOOL_NAME,
  inputSchema,
  async description() {
    return `Reverse engineering and penetration testing toolbox. Actions: ${ACTIONS.join(', ')}. Pentest sub-tools: ${PENTEST_TOOLS.join(', ')}.`
  },
  async prompt() {
    return `Use this tool for binary analysis, reverse engineering, and penetration testing.

Parameters:
- action: One of: ${ACTIONS.join(', ')}
- targetPath: Path to target binary/file (for analyze, strings, dump, diec, upx, ghidra, ida, frida-unpack, shell-protect)
- pentestTool: One of: ${PENTEST_TOOLS.join(', ')} (when action=pentest)
- pentestArgs: Arguments for the pentest tool (when action=pentest)
- kaliCmd: Command to run (when action=kali)
- tsharkArgs: tshark arguments (when action=tshark)
- forensicUrl: URL to analyze (when action=forensic)

Examples:
- {action: "strings", targetPath: "./malware.exe"}
- {action: "diec", targetPath: "./packed.bin"}
- {action: "pentest", pentestTool: "nmap", pentestArgs: "-sV -p 1-1000 192.168.1.1"}
- {action: "pentest", pentestTool: "nuclei", pentestArgs: "-u https://target.com"}
- {action: "kali", kaliCmd: "whatweb https://target.com"}
- {action: "run", cmd: "whatweb https://target.com"}
- {action: "run", cmd: "searchsploit apache 2.4"}
- {action: "run", cmd: "hydra -l admin -P wordlist.txt ssh://192.168.1.1"}
- {action: "run", cmd: "masscan -p1-65535 192.168.1.0/24 --rate=1000"}
- {action: "fuzz", template: "id={{int(1-100)}}"}
- {action: "fuzz", template: "user={{list(admin|root|test)}}&pass={{list(123456|password|admin)}}"}
- {action: "fuzz", template: "token={{base64(admin:password)}}"}
- {action: "fuzz", template: "{{randstr(16)}}"}

SecLists wordlists available at D:\\miserad\\SecLists\\ :
- Passwords: Common-Credentials/10k-most-common.txt, darkweb2017_top-100.txt
- Default creds: Default-Credentials/default-passwords.csv
- Usernames: ../Usernames/top-usernames-shortlist.txt
- Web dirs: Discovery/Web-Content/common.txt, raft-medium-directories.txt
- XSS: Fuzzing/XSS/, SQLi: Fuzzing/Databases/SQLi/, LFI: Fuzzing/LFI/LFI-Jhaddix.txt`
  },
  isEnabled() { return true },
  isReadOnly() { return false },
  async validateInput(input: ReverseCliInput) {
    if (!input.action || !ACTIONS.includes(input.action)) {
      return { valid: false, message: `action must be one of: ${ACTIONS.join(', ')}` }
    }
    return { valid: true }
  },
  userFacingName() { return 'Reverse CLI' },
  async call(input: ReverseCliInput) {
    const action = input.action
    const target = input.targetPath ?? ''

    try {
      let result: { stdout: string; stderr: string; exitCode: number }

      switch (action) {
        case 'strings':
          result = await execa('strings', [target], { timeout: 30000, reject: false }) as any
          break
        case 'analyze':
          result = await execa('file', [target], { timeout: 10000, reject: false }) as any
          break
        case 'dump':
          result = await execa('xxd', ['-l', '512', target], { timeout: 10000, reject: false }) as any
          break
        case 'diec':
          result = await execa('diec', ['-e', '-r', target], { timeout: 30000, reject: false }) as any
          break
        case 'upx':
          result = await execa('upx', ['-d', '-o', `${target}.unpacked`, target], { timeout: 60000, reject: false }) as any
          break
        case 'pentest': {
          const tool = input.pentestTool ?? ''
          const args = (input.pentestArgs ?? '').split(/\s+/).filter(Boolean)
          result = await execa(tool, args, { timeout: 120000, reject: false }) as any
          break
        }
        case 'kali': {
          const cmd = input.kaliCmd ?? ''
          result = await execa('bash', ['-c', cmd], { timeout: 60000, reject: false }) as any
          break
        }
        case 'tshark': {
          const args = (input.tsharkArgs ?? '').split(/\s+/).filter(Boolean)
          result = await execa('tshark', args, { timeout: 30000, reject: false }) as any
          break
        }
        case 'forensic': {
          const url = input.forensicUrl ?? ''
          result = await execa('curl', ['-sI', url], { timeout: 15000, reject: false }) as any
          break
        }
        case 'run': {
          // 通用：直接运行任意命令，支持所有安全工具
          const cmd = input.cmd ?? ''
          result = await execa('bash', ['-c', cmd], { timeout: 120000, reject: false }) as any
          break
        }
        case 'fuzz': {
          // FuzzTag：生成测试payload（参考yakit Web Fuzzer语法）
          const tpl = input.template ?? ''
          const payloads = expandFuzzTag(tpl)
          const preview = payloads.slice(0, 100) // 最多返回100条
          return {
            data: `Generated ${payloads.length} payloads:\n${preview.join('\n')}${payloads.length > 100 ? `\n... (${payloads.length - 100} more)` : ''}`
          }
        }
        default:
          result = await execa('bash', ['-c', `echo "Action ${action} not yet wired"`], { reject: false }) as any
      }

      const output = (result.stdout || '') + (result.stderr ? `\n[stderr] ${result.stderr}` : '')
      return { data: output.slice(0, 4000) || `[exit ${result.exitCode}]` }
    } catch (err) {
      return { data: `Error: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}
