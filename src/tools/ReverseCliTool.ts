/**
 * ReverseCliTool — RE/Pentest toolbox for Haking Code.
 * Wraps 20+ security tools (nmap, nuclei, sqlmap, strings, diec, ghidra, etc.)
 * into a single AI-callable tool.
 */
import { execa } from 'execa'
import type { Tool } from '../../Tool.js'

const TOOL_NAME = 'ReverseCli'

const ACTIONS = [
  'analyze', 'strings', 'dump', 'diec', 'upx', 'ghidra', 'ida',
  'tshark', 'pentest', 'kali', 'forensic', 'frida-unpack', 'shell-protect',
] as const

type Action = typeof ACTIONS[number]

const PENTEST_TOOLS = ['nuclei', 'nmap', 'httpx', 'ffuf', 'sqlmap', 'subfinder', 'naabu'] as const

export const ReverseCliTool: Tool = {
  name: TOOL_NAME,
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
- {action: "kali", kaliCmd: "whatweb https://target.com"}`
  },
  isEnabled() { return true },
  isReadOnly() { return false },
  async validateInput(input: Record<string, unknown>) {
    if (!input.action || !ACTIONS.includes(input.action as Action)) {
      return { valid: false, message: `action must be one of: ${ACTIONS.join(', ')}` }
    }
    return { valid: true }
  },
  userFacingName() { return 'Reverse CLI' },
  async call(_toolUseId: string, input: Record<string, unknown>) {
    const action = input.action as Action
    const target = (input.targetPath as string) ?? ''

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
          const tool = input.pentestTool as string
          const args = (input.pentestArgs as string ?? '').split(/\s+/)
          result = await execa(tool, args, { timeout: 120000, reject: false }) as any
          break
        }
        case 'kali': {
          const cmd = input.kaliCmd as string ?? ''
          result = await execa('bash', ['-c', cmd], { timeout: 60000, reject: false }) as any
          break
        }
        case 'tshark': {
          const args = (input.tsharkArgs as string ?? '').split(/\s+/)
          result = await execa('tshark', args, { timeout: 30000, reject: false }) as any
          break
        }
        case 'forensic': {
          const url = input.forensicUrl as string ?? ''
          result = await execa('curl', ['-sI', url], { timeout: 15000, reject: false }) as any
          break
        }
        default:
          result = await execa('bash', ['-c', `echo "Action ${action} not yet wired"`], { reject: false }) as any
      }

      const output = (result.stdout || '') + (result.stderr ? `\n[stderr] ${result.stderr}` : '')
      return { output: output.slice(0, 4000) || `[exit ${result.exitCode}]` }
    } catch (err) {
      return { output: `Error: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}
