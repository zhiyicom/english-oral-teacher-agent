// Mirror of `SessionApi` interface in src/server.ts. Keep in sync manually
// until v0.8.5+ extracts to a shared package. camelCase per v0.8-design §3.1.
export interface SessionApi {
  id: string
  startedAt: string
  endedAt: string | null
  durationMin: number | null
  phaseHistory: string[]
  summary: string | null
  keywords: string[]
  topicMatch: string | null
}
