interface LoadingSpinnerProps {
  text?: string
}

export default function LoadingSpinner({ text = '加载中…' }: LoadingSpinnerProps) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-slate-400" data-testid="loading">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-blue-500" />
      <span className="text-sm">{text}</span>
    </div>
  )
}
