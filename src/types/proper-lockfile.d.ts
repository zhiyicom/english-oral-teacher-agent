declare module 'proper-lockfile' {
  function lock(file: string, options?: { retries?: number }): Promise<() => Promise<void>>
  function unlock(file: string): Promise<void>
  function check(file: string): Promise<boolean>
  export { lock, unlock, check }
}
