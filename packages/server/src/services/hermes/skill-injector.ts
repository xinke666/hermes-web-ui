import { copyFile, mkdir, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { getActiveProfileDir } from './hermes-profile'
import { logger } from '../logger'

export interface SkillInjectionResult {
  sourceDir: string
  targetDir: string
  injected: string[]
  skipped: string[]
}

export class HermesSkillInjector {
  constructor(
    private readonly sourceDir = HermesSkillInjector.resolveSourceDir(),
    private readonly targetDir = join(getActiveProfileDir(), 'skills'),
  ) {}

  static resolveSourceDir(env: NodeJS.ProcessEnv = process.env, baseDir = __dirname): string {
    const override = env.HERMES_WEB_UI_SKILLS_DIR?.trim()
    if (override) return resolve(override)

    const candidates = [
      // Production bundle: dist/server/index.js with dist/skills copied by build.
      resolve(baseDir, '../skills'),
      // Development/test: packages/server/src/services/hermes -> packages/skills.
      resolve(baseDir, '../../../../skills'),
      // Running from repository root without bundling.
      resolve(process.cwd(), 'packages/skills'),
    ]

    return candidates.find(candidate => existsSync(candidate)) || candidates[0]
  }

  async injectMissingSkills(): Promise<SkillInjectionResult> {
    const result: SkillInjectionResult = {
      sourceDir: this.sourceDir,
      targetDir: this.targetDir,
      injected: [],
      skipped: [],
    }

    if (!await this.isDirectory(this.sourceDir)) {
      logger.debug('[skill-injector] no bundled skills directory at %s', this.sourceDir)
      return result
    }

    await mkdir(this.targetDir, { recursive: true })
    const entries = await readdir(this.sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const sourceSkillDir = join(this.sourceDir, entry.name)
      const targetSkillDir = join(this.targetDir, entry.name)
      if (existsSync(targetSkillDir)) {
        result.skipped.push(entry.name)
        continue
      }
      await this.copyDirMissingOnly(sourceSkillDir, targetSkillDir)
      result.injected.push(entry.name)
    }

    if (result.injected.length > 0) {
      logger.info({ injected: result.injected, targetDir: this.targetDir }, '[skill-injector] injected bundled skills')
    }
    return result
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory()
    } catch {
      return false
    }
  }

  private async copyDirMissingOnly(sourceDir: string, targetDir: string): Promise<void> {
    await mkdir(targetDir, { recursive: true })
    const entries = await readdir(sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      const sourcePath = join(sourceDir, entry.name)
      const targetPath = join(targetDir, entry.name)
      if (existsSync(targetPath)) continue
      if (entry.isDirectory()) {
        await this.copyDirMissingOnly(sourcePath, targetPath)
      } else if (entry.isFile()) {
        await copyFile(sourcePath, targetPath)
      }
    }
  }
}
