interface MessageBubbleProps {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp?: string
}

export default function MessageBubble({ role, content, timestamp }: MessageBubbleProps) {
  return (
    <div className={`flex ${role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div
        data-testid={role === 'assistant' ? 'assistant-message' : 'user-message'}
        className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-4 py-2 ${
          role === 'user' ? 'bg-blue-100 text-blue-900' : 'bg-gray-100 text-gray-900'
        }`}
      >
        {timestamp && (
          <p className="mb-1 text-xs text-slate-400">
            {role === 'user' ? 'Student' : 'Teacher'} · {new Date(timestamp).toLocaleTimeString()}
          </p>
        )}
        {content}
      </div>
    </div>
  )
}
