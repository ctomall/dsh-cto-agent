// 工具集：每个工具声明 policy（auto/confirm/deny），由 loop 统一裁决。
// 路径一律限制在 run 的工作区内，越界直接拒绝（对齐文档 §4 fs.* 规则）。
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

const inside = (root, p) => {
  const abs = resolve(root, p)
  return abs === root || abs.startsWith(root + sep) ? abs : null
}

export function createTools({ workspaceRoot }) {
  // 词法检查只能挡 "../"；符号链接能绕过它（link -> /outside）。
  // 因此落盘前还要对目录做 realpath 校验，确保真实路径仍在工作区内。
  const guard = async (runId, p, { create = false } = {}) => {
    const root = resolve(workspaceRoot, runId)
    const abs = inside(root, p)
    if (!abs) throw new Error(`path outside workspace: ${p}`)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const realRoot = await realpath(root)
    const dir = dirname(abs)
    if (create) await mkdir(dir, { recursive: true, mode: 0o700 })
    const realDir = await realpath(dir)
    if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
      throw new Error(`path outside workspace: ${p}`)
    }
    return { root: realRoot, abs: join(realDir, basename(abs)) }
  }

  return {
    schema: [
      {
        name: 'fs.read',
        description: '读取会话工作区内的文本文件',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      {
        name: 'fs.write',
        description: '写入文件到会话工作区（会覆盖同名文件，需人工确认）',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
    ],
    policy: { 'fs.read': 'auto', 'fs.write': 'confirm' },
    async run(name, args, runId) {
      if (name === 'fs.read') {
        // 读失败要给模型一个干净、可行动的报错，且**不要把宿主机绝对路径**带进对话
        let abs
        try {
          ({ abs } = await guard(runId, args.path))
        } catch (e) {
          if (e?.code === 'ENOENT') throw new Error(`file_not_found: ${args.path}`)
          throw e
        }
        let text
        try {
          text = await readFile(abs, 'utf8')
        } catch (e) {
          if (e?.code === 'ENOENT') throw new Error(`file_not_found: ${args.path}`)
          if (e?.code === 'EISDIR') throw new Error(`is_a_directory: ${args.path}`)
          throw new Error(`read_failed: ${args.path}`)
        }
        return { content: text.slice(0, 4000), artifact: null }
      }
      if (name === 'fs.write') {
        const { root, abs } = await guard(runId, args.path, { create: true })
        // 0600：租户产物不该被同机其他用户读到
        await writeFile(abs, String(args.content ?? ''), { encoding: 'utf8', mode: 0o600 })
        // 回给模型/用户的路径用"会话内相对路径"：绝对路径会把宿主机目录结构带进对话与日志
        return { content: `已写入 ${args.path}`, artifact: { path: args.path, mime: 'text/markdown', size: Buffer.byteLength(String(args.content ?? '')) }, root }
      }
      throw new Error(`unknown tool: ${name}`)
    },
  }
}
