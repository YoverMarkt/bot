import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

function readTypeScriptTree(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return readTypeScriptTree(path)
    return entry.name.endsWith('.ts') ? [fs.readFileSync(path, 'utf8')] : []
  })
}

describe('entrypoint TypeScript', () => {
  it('compone el servidor desde src y arranca directamente desde dist', () => {
    const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const serverPackage = JSON.parse(fs.readFileSync(
      new URL('../package.json', import.meta.url),
      'utf8',
    ))

    expect(serverPackage.main).toBe('dist/index.js')
    expect(serverPackage.scripts.start).toBe('node dist/index.js')
    expect(source).toContain("dotenv.config({ path: path.join(serverRoot, '.env') })")
    expect(source).toContain("path.join(projectRoot, 'apps/client/dist')")
    expect(source).toContain("app.use('/api/client', activeClientGuard)")
    expect(source).toContain('app.use(webhooksRouter)')
    expect(source).not.toContain('@ts-nocheck')
  })

  it('resuelve módulos internos sin volver a las fachadas CommonJS raíz', () => {
    const sourceDirectory = new URL('../src', import.meta.url).pathname
    const sources = readTypeScriptTree(sourceDirectory).join('\n')

    expect(sources).not.toMatch(/require\(['"]\.\.\/\.\.\//)
  })

  it('no conserva fachadas JavaScript fuera de la configuración de ESLint', () => {
    const serverDirectory = new URL('..', import.meta.url).pathname
    const javascript = fs.readdirSync(serverDirectory)
      .filter(name => name.endsWith('.js'))

    expect(javascript).toEqual(['eslint.config.js'])
  })
})
