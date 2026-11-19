import { trashSync } from './fixtures/trash.ts'
import { mkdtempSync } from 'node:fs'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Context } from '../src/runtime/context.ts'
import type { Agent } from '../src/runtime/types.ts'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { admissionImageKeys, readAdmissionImage } from '../src/sources/feishu-image.ts'
import type { FeishuRef } from '../src/sources/feishu-read.ts'

let directory: string
let agent: Agent
let saveImage: ReturnType<typeof vi.fn>
let resolveModelInfo: ReturnType<typeof vi.fn>
let lark: MockInstance<Commands['lark']>
const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
const source: FeishuRef = { triggerId: 'source', chatId: 'oc_chat', messageId: 'om_source' }
const text = '![Image](img_source) Plan mode'
const ref = { attachmentId: 'image-id', mediaType: 'image/png', bytes: 4, width: 1, height: 1 }
const imageBytes = Buffer.from('data')
const signal = () => new AbortController().signal

async function expectRetiredDownloads(downloads: readonly Record<string, Buffer>[], remainingFiles: readonly string[] = []) {
  expect(lark).toHaveBeenCalledTimes(downloads.length)
  const keepsArchive = process.platform !== 'darwin'
  const archive = join(directory, 'retired-images')
  const expectedEntries = keepsArchive ? [...remainingFiles, 'retired-images'] : [...remainingFiles]
  expect((await readdir(directory)).sort()).toEqual(expectedEntries.sort())
  if (keepsArchive) expect((await lstat(archive)).isDirectory()).toBe(true)
  const archived = keepsArchive ? await readdir(archive, { withFileTypes: true }) : undefined
  if (archived) expect(archived).toHaveLength(downloads.length)

  for (const [index, files] of downloads.entries()) {
    const original = lark.mock.calls[index]![1]!
    expect(dirname(original)).toBe(directory)
    await expect(lstat(original)).rejects.toMatchObject({ code: 'ENOENT' })
    if (!archived) continue

    const matches = archived.filter(entry => entry.name.startsWith(`${basename(original)}-`))
    expect(matches).toHaveLength(1)
    const entry = matches[0]!
    expect(entry.isDirectory()).toBe(true)
    const retired = join(archive, entry.name)
    expect((await readdir(retired)).sort()).toEqual(Object.keys(files).sort())
    for (const [name, bytes] of Object.entries(files)) {
      const path = join(retired, name)
      expect((await lstat(path)).isFile()).toBe(true)
      expect(await readFile(path)).toEqual(bytes)
    }
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'admission-image-test-'))
  saveImage = vi.fn().mockResolvedValue(ref)
  resolveModelInfo = vi.fn().mockResolvedValue({ inputModalities: ['text', 'image'] })
  const ctx = new Context()
  ctx.reflect.provide('attachments', { saveImage, imageLimits: { maxImageBytes: 100, maxMessageImageBytes: 100 } })
  ctx.reflect.provide('llm', { resolveModelInfo })
  agent = { ctx, session: { requestHeader: () => ({ config: { provider: 'chosen-provider', model: 'chosen-model' } }) }, options: {} } as unknown as Agent
  lark = vi.spyOn(Commands.prototype, 'lark').mockImplementation(async (args: string[], cwd?: string) => {
    expect(args).toEqual(['im', '+messages-resources-download', '--message-id', 'om_source', '--file-key', 'img_source', '--type', 'image', '--output', './image'])
    expect(cwd).toContain(directory)
    const saved_path = join(cwd!, 'image.png'); await writeFile(saved_path, imageBytes)
    return { saved_path }
  })
})
afterEach(() => { vi.restoreAllMocks(); trashSync(directory, { recursive: true, force: true }) })
it('retains the source-message pairing, commits an image reference and retires the download directory', async () => {
  expect(admissionImageKeys('![Image](img_source) {"image_key":"img_second"} img_source')).toEqual(['img_source', 'img_second'])
  expect(await readAdmissionImage(agent, commands, source, text, 'img_source', directory, signal())).toEqual({ source_message_id: 'om_source', image_key: 'img_source', image: ref })
  expect(resolveModelInfo).toHaveBeenCalledWith('chosen-provider', 'chosen-model', expect.any(AbortSignal))
  expect(saveImage).toHaveBeenCalledWith({ data: imageBytes, mediaType: 'image/png', name: 'img_source.png' })
  await expectRetiredDownloads([{ 'image.png': imageBytes }])
})
it('rejects arbitrary keys and non-visual models before downloading', async () => {
  await expect(readAdmissionImage(agent, commands, source, text, '../img_other', directory, signal())).rejects.toThrow('source message')
  resolveModelInfo.mockResolvedValue({ inputModalities: ['text'] })
  await expect(readAdmissionImage(agent, commands, source, text, 'img_source', directory, signal())).rejects.toThrow('does not support image')
  expect(lark).not.toHaveBeenCalled()
  expect(saveImage).not.toHaveBeenCalled()
  expect(await readdir(directory)).toEqual([])
})
it('cleans up refused attachments and failed downloads without returning an image', async () => {
  const downloaded = { 'image.png': imageBytes }
  saveImage.mockRejectedValueOnce(new Error('Invalid image bytes'))
  await expect(readAdmissionImage(agent, commands, source, text, 'img_source', directory, signal())).rejects.toThrow('Invalid image')
  await expectRetiredDownloads([downloaded])
  lark.mockRejectedValueOnce(new Error('Resource permission denied'))
  await expect(readAdmissionImage(agent, commands, source, text, 'img_source', directory, signal())).rejects.toThrow('permission denied')
  await expectRetiredDownloads([downloaded, {}])
})
it('refuses escaped output paths, oversize files and unsupported types', async () => {
  const outside = join(directory, 'outside.png')
  const outsideBytes = Buffer.from('outside fixture')
  await writeFile(outside, outsideBytes)
  const { ino, mode, mtimeMs } = await lstat(outside)
  lark.mockResolvedValueOnce({ saved_path: outside })
  await expect(readAdmissionImage(agent, commands, source, text, 'img_source', directory, signal())).rejects.toThrow('outside')
  const downloads: Record<string, Buffer>[] = [{}]
  for (const [name, bytes, error] of [['image.png', 101, 'byte limit'], ['image.svg', 4, 'supported']] as const) {
    const data = Buffer.alloc(bytes, 'x')
    lark.mockImplementationOnce(async (_args, cwd) => {
      const saved_path = join(cwd!, name); await writeFile(saved_path, data); return { saved_path }
    })
    await expect(readAdmissionImage(agent, commands, source, text, 'img_source', directory, signal())).rejects.toThrow(error)
    downloads.push({ [name]: data })
  }
  expect(saveImage).not.toHaveBeenCalled()
  await expectRetiredDownloads(downloads, ['outside.png'])
  expect(await lstat(outside)).toMatchObject({ ino, mode, mtimeMs })
  expect(await readFile(outside)).toEqual(outsideBytes)
})
