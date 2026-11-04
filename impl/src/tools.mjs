// 工具集：每个工具声明 policy（auto/confirm/deny），由 loop 统一裁决。
// 路径一律限制在 run 的工作区内，越界直接拒绝（对齐文档 §4 fs.* 规则）。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

const inside = (root, p) => {
  const abs = resolve(root, p)
  return abs === root || abs.startsWith(root + sep) ? abs : null
}

export function createTools({ workspaceRoot }) {
  const guard = (runId, p) => {
    const root = resolve(workspaceRoot, runId)
    const abs = inside(root, p)
    if (!abs) throw new Error(`path outside workspace: ${p}`)
    return { root, abs }
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
        const { abs } = guard(runId, args.path)
        const text = await readFile(abs, 'utf8')
        return { content: text.slice(0, 4000), artifact: null }
      }
      if (name === 'fs.write') {
        const { root, abs } = guard(runId, args.path)
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, String(args.content ?? ''), 'utf8')
        return { content: `已写入 ${abs}`, artifact: { path: args.path, mime: 'text/markdown', size: Buffer.byteLength(String(args.content ?? '')) }, root }
      }
      throw new Error(`unknown tool: ${name}`)
    },
  }
}
