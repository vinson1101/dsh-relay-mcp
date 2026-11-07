#!/usr/bin/env node
/**
 * dsh-relay-mcp — 把 dsh-session-relay 的 HTTP 接口包成 MCP 工具。
 *
 * 零依赖：只用 Node 内置模块 + 全局 fetch（Node >= 18）。
 * 通过 stdio 与 MCP 客户端（Codex 等）通信，每条消息一行 JSON。
 *
 * 环境变量：
 *   DSH_RELAY_URL    中继地址，默认 http://127.0.0.1:7391
 *   DSH_RELAY_TOKEN  中继设置了 token 时需要的 Bearer token
 */

import { createInterface } from 'node:readline'

const RELAY_URL = (process.env.DSH_RELAY_URL ?? 'http://127.0.0.1:7391').replace(/\/+$/, '')
const RELAY_TOKEN = process.env.DSH_RELAY_TOKEN ?? ''
const SERVER_INFO = { name: 'dsh-relay', version: '0.1.0' }
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18']
const DEFAULT_PROTOCOL = '2025-06-18'

/** 只往 stdout 写 JSON-RPC，绝不写日志。 */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

const TOOLS = [
  {
    name: 'dsh_send',
    description:
      '把一条消息投递给 DSH，在指定工作空间里干活，立即返回投递回执。' +
      '用 workspace（项目目录的绝对路径）指定去哪干活：该目录下已有会话就复用，没有就新建一个；' +
      '也可以用 sessionId 精确指定某个会话。' +
      '这只表示消息已被接受，不代表已经处理完；要拿结果请用 dsh_ask。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: '项目目录的绝对路径，例如 /Users/vinson/Projects/github/vinson1101/FinOS-DSH',
        },
        sessionId: { type: 'string', description: '可选。精确指定会话 id；与 workspace 二选一' },
        text: { type: 'string', description: '要投递的消息正文' },
        mode: {
          type: 'string',
          enum: ['steer'],
          description: '可选。steer 表示插话打断当前轮次，省略则排队',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_ask',
    description:
      '把一条消息投递给 DSH 并等待它这一轮跑完，返回最终回答正文。' +
      '用 workspace（项目绝对路径）或 sessionId 指定目标；省略两者会报错。' +
      '适合"派活并拿结果"。任务较长时调大 timeoutMs。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: '项目目录的绝对路径' },
        sessionId: { type: 'string', description: '可选。精确指定会话 id；与 workspace 二选一' },
        text: { type: 'string', description: '要投递的消息正文' },
        timeoutMs: {
          type: 'integer',
          minimum: 1000,
          description: '最长等待毫秒数，默认 120000。长任务建议 300000 以上',
        },
        maxMessages: { type: 'integer', minimum: 1, description: '最多回读多少条助手消息，默认 20' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_sessions',
    description:
      '列出 DSH 会话，包含休眠会话（不只是正在运行的）。可按 cwd 过滤，或按标题关键词搜索。' +
      '用来确认某个工作空间下有没有已有会话。',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '可选。只看这个项目目录下的会话（绝对路径）' },
        query: { type: 'string', description: '可选。按会话标题关键词过滤' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_workspaces',
    description: '列出 DSH 里已注册的工作空间（项目目录）。不确定路径时先调这个。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

async function callRelay(path, init = {}) {
  const headers = { 'content-type': 'application/json' }
  if (RELAY_TOKEN !== '') headers.authorization = `Bearer ${RELAY_TOKEN}`
  let response
  try {
    response = await fetch(`${RELAY_URL}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  } catch (error) {
    throw new Error(
      `连不上 DSH 中继（${RELAY_URL}）。确认 DeepSeek Harness 正在运行，且 dsh-session-relay 插件已启用。原始错误: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const raw = await response.text()
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    body = { ok: false, error: { message: raw } }
  }
  if (!response.ok || body?.ok === false) {
    const detail = body?.error?.message ?? raw
    throw new Error(`中继返回 ${String(response.status)}: ${detail}`)
  }
  return body
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

/** 把 sessionId 或 workspace 二选一放进请求体。 */
function targetOf(args) {
  if (typeof args.sessionId === 'string' && args.sessionId !== '') return { sessionId: args.sessionId }
  if (typeof args.workspace === 'string' && args.workspace !== '') return { workspace: args.workspace }
  return {}
}

async function runTool(name, args) {
  switch (name) {
    case 'dsh_send': {
      const target = targetOf(args)
      if (Object.keys(target).length === 0) {
        return textResult('需要 workspace（项目绝对路径）或 sessionId 二者之一。', true)
      }
      const result = await callRelay('/send', {
        method: 'POST',
        body: JSON.stringify({
          ...target,
          text: args.text,
          ...(args.mode === undefined ? {} : { mode: args.mode }),
        }),
      })
      const where = result.selection?.rule === 'created' ? '新建会话' : '复用已有会话'
      const rule = result.selection?.rule
      return textResult(
        `已投递到 ${String(result.sessionId)}（${where}，选择依据 ${String(rule)}${result.selection?.workspace ? `，工作空间 ${String(result.selection.workspace)}` : ''}）。\n` +
          '注意：这只表示消息已被接受，不代表已经处理完。要拿结果请用 dsh_ask。',
      )
    }

    case 'dsh_ask': {
      const target = targetOf(args)
      if (Object.keys(target).length === 0) {
        return textResult('需要 workspace（项目绝对路径）或 sessionId 二者之一。', true)
      }
      const payload = { ...target, text: args.text }
      if (Number.isInteger(args.timeoutMs)) payload.timeoutMs = args.timeoutMs
      if (Number.isInteger(args.maxMessages)) payload.maxMessages = args.maxMessages
      const result = await callRelay('/ask', { method: 'POST', body: JSON.stringify(payload) })
      const body = typeof result.text === 'string' ? result.text.trim() : ''

      // 等待超时：消息已被接受，任务可能仍在跑。绝不重发，只报告状态并交还 id。
      if (result.status === 'running' || result.status === 'unknown') {
        const running = result.status === 'running'
        return textResult(
          `消息已投递到 ${String(result.sessionId)}，但等待超时：会话${running ? '仍在运行' : '状态未知'}。\n` +
            '本次没有重发，不要再发一遍同样的任务。\n' +
            `之后可以用 sessionId=${String(result.sessionId)} 或同一 workspace 投递一条**新的询问**来取结果。\n` +
            `requestId=${String(result.requestId)}`,
        )
      }

      if (body === '') {
        return textResult(
          `会话 ${String(result.sessionId)} 这一轮结束了，但没有产生正文（reason=${String(result.reason)}）。` +
            '可能它只在调用工具、或者被中断了。',
        )
      }
      const where = result.selection?.rule === 'created' ? '新建会话' : '复用会话'
      return textResult(
        `${body}\n\n[${where} ${String(result.sessionId)}, reason=${String(result.reason)}${result.truncated ? ', 输出已截断' : ''}]`,
      )
    }

    case 'dsh_sessions': {
      const params = []
      if (typeof args.cwd === 'string' && args.cwd !== '') params.push(`cwd=${encodeURIComponent(args.cwd)}`)
      if (typeof args.query === 'string' && args.query !== '') params.push(`query=${encodeURIComponent(args.query)}`)
      const suffix = params.length === 0 ? '' : `?${params.join('&')}`
      const result = await callRelay(`/sessions${suffix}`, { method: 'GET' })
      const rows = Array.isArray(result.sessions) ? result.sessions : []
      if (rows.length === 0) {
        return textResult('没有匹配的会话。用 dsh_workspaces 看看有哪些工作空间，或在 dsh_send 里直接给 workspace 路径（会自动新建会话）。')
      }
      const lines = rows.map((row) => {
        const kind = row.kind === 'subagent' ? '子会话' : '主会话'
        const state = row.running ? '运行中' : '空闲'
        const deliver = row.deliverable === true ? '可投递' : `不可投递（${String(row.reason ?? '原因未知')}）`
        return (
          `- ${String(row.sessionId)}  [${kind}/${state}]  ${deliver}  ${String(row.cwd ?? '?')}` +
          (row.title ? `  「${String(row.title)}」` : '') +
          (row.updatedAt ? `  最后活动 ${row.updatedAt}` : '')
        )
      })
      const usable = rows.filter((row) => row.deliverable === true).length
      return textResult(`共 ${String(rows.length)} 个会话（可投递 ${String(usable)} 个）：\n${lines.join('\n')}`)
    }

    case 'dsh_workspaces': {
      const result = await callRelay('/workspaces', { method: 'GET' })
      const rows = Array.isArray(result.workspaces) ? result.workspaces : []
      if (rows.length === 0) return textResult('没有已注册的工作空间。可以直接给 dsh_send 传任意项目目录的绝对路径。')
      const lines = rows.map(
        (row) => `- ${String(row.path)}${row.title ? `  「${String(row.title)}」` : ''}`,
      )
      return textResult(`已注册工作空间 ${String(rows.length)} 个：\n${lines.join('\n')}`)
    }

    default:
      return textResult(`未知工具: ${String(name)}`, true)
  }
}

function negotiateProtocol(params) {
  const requested = params?.protocolVersion
  if (typeof requested === 'string' && SUPPORTED_PROTOCOLS.includes(requested)) return requested
  return DEFAULT_PROTOCOL
}

async function handleMessage(message) {
  const { id, method, params } = message ?? {}
  const isRequest = id !== undefined && id !== null

  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: negotiateProtocol(params),
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        })

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return

      case 'ping':
        return reply(id, {})

      case 'tools/list':
        return reply(id, { tools: TOOLS })

      case 'tools/call': {
        const name = params?.name
        const args = params?.arguments ?? {}
        if (typeof name !== 'string') return replyError(id, -32602, 'tools/call 缺少 name')
        return reply(id, await runTool(name, args))
      }

      case 'resources/list':
        return reply(id, { resources: [] })

      case 'prompts/list':
        return reply(id, { prompts: [] })

      default:
        if (isRequest) replyError(id, -32601, `未知方法: ${String(method)}`)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (isRequest) reply(id, textResult(`错误: ${detail}`, true))
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    // 非 JSON 行直接忽略：stdout 属于协议通道
    return
  }
  void handleMessage(message)
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
