const GITHUB_REPO = 'zhiyicom/english-oral-teacher-agent'
const API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean | null
  releaseUrl: string | null
  checkedAt: string
}

let cache: { info: UpdateInfo; fetchedAt: number } | null = null

export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.info
  }

  const info: UpdateInfo = {
    currentVersion,
    latestVersion: null,
    updateAvailable: null,
    releaseUrl: null,
    checkedAt: new Date().toISOString(),
  }

  try {
    const res = await fetch(API_URL, {
      headers: { 'User-Agent': 'EnglishOralTeacher-UpdateChecker' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      cache = { info, fetchedAt: Date.now() }
      return info
    }
    const data = (await res.json()) as { tag_name?: string; html_url?: string }
    if (typeof data.tag_name === 'string') {
      info.latestVersion = data.tag_name.replace(/^v/, '')
      info.releaseUrl = data.html_url ?? null
      info.updateAvailable = compareVersions(currentVersion, info.latestVersion) < 0
    }
  } catch {
    // network error / timeout — return null updateAvailable
  }

  cache = { info, fetchedAt: Date.now() }
  return info
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number)
  const partsB = b.split('.').map(Number)
  const aMaj = partsA[0] ?? 0
  const aMin = partsA[1] ?? 0
  const aPat = partsA[2] ?? 0
  const bMaj = partsB[0] ?? 0
  const bMin = partsB[1] ?? 0
  const bPat = partsB[2] ?? 0
  if (aMaj !== bMaj) return aMaj - bMaj
  if (aMin !== bMin) return aMin - bMin
  return aPat - bPat
}
